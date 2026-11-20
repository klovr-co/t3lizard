import { SIZE_WEIGHT } from "./types.ts";
import type { AccountId, Action, Config, CreateRecord, Machine, MachineId, RepoKey, Size, SizeSlot, State, Ticket } from "./types.ts";

const MINUTE = 60_000;
export const DEADLINE_MARGIN_MS = 5 * MINUTE;

export const BRINGING_UP = new Set(["creating", "installing", "linking"]);
/** Pause after the 1st, 2nd, and 3rd-or-later machine in a row that never became ready. */
export const CREATE_BACKOFF_MINUTES = [2, 5, 15];
const HOUR = 60 * MINUTE;
/** A machine waiting for an account keeps its lease this long past the time the account frees. */
export const ACCOUNT_WAIT_MARGIN_MS = 10 * MINUTE;

const iso = (t: number) => new Date(t).toISOString();

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** The budget unit: an hour of a small machine. Other sizes count by price (SIZE_WEIGHT). */
export const BUDGET_UNIT = "small-machine-hours";

/** Today's spend in small-machine-hours. state.usage holds weighted seconds per UTC day. */
export function usedSmallHours(state: State, now: number): number {
  return (state.usage[utcDay(now)] ?? 0) / 3600;
}

/** Machines per size, every phase counted: Lizard counts a sandbox until it is killed. */
export function sizesInUse(machines: Machine[]): Map<Size, number> {
  const used = new Map<Size, number>();
  for (const m of machines) used.set(m.size, (used.get(m.size) ?? 0) + 1);
  return used;
}

/** The largest size on the ladder with room, given machines per size. */
export function sizeWithRoom(ladder: SizeSlot[], used: Map<Size, number>): Size | undefined {
  return ladder.find((s) => (used.get(s.size) ?? 0) < s.max)?.size;
}

/** The ladder a repo may use: sizes at least its learned minimum (state.repoMinSize). */
export function repoLadder(state: State, config: Config, repo: RepoKey): SizeSlot[] {
  const min = state.repoMinSize?.[repo];
  return min ? config.sizes.filter((s) => SIZE_WEIGHT[s.size] >= SIZE_WEIGHT[min]) : config.sizes;
}

/** The next size up from `size` on the ladder, if there is one. */
export function nextSizeUp(config: Config, size: Size): Size | undefined {
  return [...config.sizes].reverse().find((s) => SIZE_WEIGHT[s.size] > SIZE_WEIGHT[size])?.size;
}

export function ladderText(ladder: SizeSlot[], used: Map<Size, number>): string {
  return ladder.map((s) => `${s.size} ${used.get(s.size) ?? 0}/${s.max}`).join(", ");
}

/**
 * The create circuit breaker. Counts the machines in a row (across repos, newest first) that
 * were lost before they became ready, and pauses creates for a growing time after the last one.
 * One machine that becomes ready resets the count.
 */
export function createBackoff(state: State, now: number): { until: number; failures: number; reason: string } | undefined {
  const settled = (state.creates ?? []).filter((r): r is CreateRecord & { settledAt: number } => r.outcome !== "pending" && r.settledAt !== undefined);
  settled.sort((a, b) => a.settledAt - b.settledAt);
  let failures = 0;
  for (let i = settled.length - 1; i >= 0 && settled[i].outcome === "lost"; i--) failures++;
  if (!failures) return undefined;
  const last = settled[settled.length - 1];
  const until = last.settledAt + CREATE_BACKOFF_MINUTES[Math.min(failures, CREATE_BACKOFF_MINUTES.length) - 1] * MINUTE;
  return now < until ? { until, failures, reason: last.reason ?? "unknown" } : undefined;
}

/** Why no machine may be created for this repo right now: the per-repo hourly create cap. */
export function repoCreateBlock(state: State, repo: RepoKey, now: number, config: Config): string | undefined {
  const recent = (state.creates ?? []).filter((r) => r.repo === repo && now - r.at < HOUR).map((r) => r.at).sort((a, b) => a - b);
  if (recent.length < config.createsPerRepoPerHour) return undefined;
  const next = recent[recent.length - config.createsPerRepoPerHour] + HOUR;
  return `${recent.length} machines created for this repo in the last hour (cap ${config.createsPerRepoPerHour}); next create after ${iso(next)}`;
}

/** Why no machine may be created right now, or undefined when creates are allowed. */
export function createBlock(state: State, now: number, config: Config): string | undefined {
  if (state.createsPausedUntil !== undefined && now < state.createsPausedUntil) {
    const detail = state.lastLizardError ? `: ${state.lastLizardError.message}` : "";
    return `Lizard creates paused until ${iso(state.createsPausedUntil)}${detail}`;
  }
  const backoff = createBackoff(state, now);
  if (backoff) {
    return `creates back off until ${iso(backoff.until)}: ${backoff.failures} machine(s) in a row never became ready; last: ${backoff.reason}`;
  }
  const usedHours = usedSmallHours(state, now);
  if (usedHours >= config.dailySmallMachineHours) {
    return `daily budget used: ${usedHours.toFixed(2)} of ${config.dailySmallMachineHours} ${BUDGET_UNIT}`;
  }
  return undefined;
}

export function accountLimited(state: State, account: AccountId, now: number): boolean {
  return (state.accounts?.[account]?.limitedUntil ?? 0) > now;
}

/** The first account that is not limited, counting from the one after `after` and wrapping round to `after` last. */
export function nextFreeAccount(state: State, now: number, accounts: AccountId[], after?: AccountId): AccountId | undefined {
  const start = after === undefined ? 0 : accounts.indexOf(after) + 1;
  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[(start + i) % accounts.length];
    if (!accountLimited(state, account, now)) return account;
  }
  return undefined;
}

/**
 * A leased machine with limited threads and no free account waits for the earliest account, plus
 * a margin. It keeps its lease and machine that long, but never past maxLifetimeMinutes or the
 * daily budget. Undefined when it need not wait.
 */
export function accountWait(state: State, m: Machine, now: number, config: Config): { until: number } | { blocked: string } | undefined {
  if (m.phase.kind !== "leased" || !m.limitedThreads?.length || !config.accounts.length) return undefined;
  if (nextFreeAccount(state, now, config.accounts)) return undefined;
  const frees = Math.min(...config.accounts.map((a) => state.accounts?.[a]?.limitedUntil ?? now));
  const until = frees + ACCOUNT_WAIT_MARGIN_MS;
  const cap = m.createdAt + config.maxLifetimeMinutes * MINUTE;
  if (until > cap) return { blocked: `the next Claude account frees at ${iso(frees)}, after this machine's maximum lifetime (${iso(cap)})` };
  const hours = usedSmallHours(state, now) + ((until - now) / 3_600_000) * SIZE_WEIGHT[m.size];
  if (hours > config.dailySmallMachineHours) return { blocked: `waiting until ${iso(until)} would pass the daily budget of ${config.dailySmallMachineHours} ${BUDGET_UNIT}` };
  return { until };
}

/** Decide what the daemon should do next. Pure: no I/O, no clock, no mutation. */
export function plan(state: State, now: number, config: Config): Action[] {
  const expireTickets: Action[] = [];
  const expireLeases: Action[] = [];
  const closes: Action[] = [];
  const extends_: Action[] = [];
  const grants: Action[] = [];
  const creates: Action[] = [];
  const continues: Action[] = [];
  const leaseExtends: Action[] = [];

  const machines = Object.values(state.machines);
  const closingNow = new Set<MachineId>();
  const close = (m: Machine, reason: Extract<Action, { kind: "close" }>["reason"]) => {
    closingNow.add(m.id);
    closes.push({ kind: "close", machineId: m.id, reason });
  };

  const reserved = new Set(
    machines.flatMap((m) => (m.phase.kind === "resetting" ? [m.phase.ticketId] : [])),
  );
  const waiting: Ticket[] = [];
  for (const t of state.tickets) {
    if (t.status !== "queued" || reserved.has(t.id)) continue;
    if (now - t.enqueuedAt >= config.ticketMaxWaitMinutes * MINUTE) {
      expireTickets.push({ kind: "expireTicket", ticketId: t.id });
    } else {
      waiting.push(t);
    }
  }

  // A thread that hit a usage limit continues on the next free account. With none free, its
  // machine keeps its lease and stays up until the earliest account frees.
  const holds = new Map<MachineId, number>();
  for (const m of machines) {
    if (m.phase.kind !== "leased" || !m.limitedThreads?.length) continue;
    for (const t of m.limitedThreads) {
      const account = nextFreeAccount(state, now, config.accounts, t.account);
      if (account) continues.push({ kind: "continueThread", machineId: m.id, threadId: t.threadId, runId: t.runId, account });
    }
    const wait = accountWait(state, m, now, config);
    if (!wait || !("until" in wait)) continue;
    holds.set(m.id, wait.until);
    const lease = state.leases[m.phase.leaseId];
    if (lease && lease.expiresAt < wait.until) leaseExtends.push({ kind: "extendLease", leaseId: lease.id, expiresAt: wait.until });
  }

  for (const lease of Object.values(state.leases)) {
    if (now >= lease.expiresAt && !holds.has(lease.machineId)) expireLeases.push({ kind: "expireLease", leaseId: lease.id });
  }

  for (const m of machines) {
    const kind = m.phase.kind;
    if (kind === "closing") continue;
    if (kind === "failed") {
      close(m, "failed");
    } else if (kind === "leased" || kind === "resetting") {
      const near = m.deadline - now <= DEADLINE_MARGIN_MS;
      const want = Math.max(near ? m.deadline + config.lifetimeMinutes * MINUTE : 0, holds.get(m.id) ?? 0);
      const target = Math.min(m.createdAt + config.maxLifetimeMinutes * MINUTE, want);
      if (target > m.deadline) extends_.push({ kind: "extend", machineId: m.id, deadline: target });
    } else if (m.deadline - now <= DEADLINE_MARGIN_MS) {
      close(m, "deadline");
    } else if (kind === "idle" && now - m.createdAt >= config.recycleMinutes * MINUTE) {
      close(m, "recycle");
    }
  }

  const idleByRepo = new Map<RepoKey, Machine[]>();
  for (const m of machines) {
    if (m.phase.kind !== "idle" || closingNow.has(m.id)) continue;
    // A machine that stopped answering is never handed out again.
    if (m.unresponsiveSince) {
      close(m, "unresponsive");
      continue;
    }
    // Too small for this repo's jobs (learned): left to close as idle, never granted.
    const min = state.repoMinSize?.[m.repo];
    if (min && SIZE_WEIGHT[m.size] < SIZE_WEIGHT[min]) continue;
    idleByRepo.set(m.repo, [...(idleByRepo.get(m.repo) ?? []), m]);
  }
  // The oldest ticket gets the largest idle machine; among equals, the one with the most time left.
  for (const list of idleByRepo.values()) list.sort((a, b) => SIZE_WEIGHT[b.size] - SIZE_WEIGHT[a.size] || b.deadline - a.deadline);

  const unmet = new Map<RepoKey, number>();
  for (const t of waiting) {
    const machine = idleByRepo.get(t.repo)?.shift();
    if (machine) grants.push({ kind: "grant", ticketId: t.id, machineId: machine.id });
    else unmet.set(t.repo, (unmet.get(t.repo) ?? 0) + 1);
  }

  const count = (pred: (m: Machine) => boolean) => machines.filter(pred).length;
  const onLadder = new Set(config.sizes.map((s) => s.size));
  const used = sizesInUse(machines);
  let slotsFreeing = machines.filter((m) => (m.phase.kind === "closing" || closingNow.has(m.id)) && onLadder.has(m.size)).length;
  const block = createBlock(state, now, config);
  // Closing an idle machine of a quiet repo frees a slot of its size; larger ones first.
  const stealable = [...idleByRepo.values()]
    .flat()
    .filter((m) => !unmet.has(m.repo) && onLadder.has(m.size))
    .sort((a, b) => SIZE_WEIGHT[b.size] - SIZE_WEIGHT[a.size]);
  for (const [repo, n] of unmet) {
    let need = n - count((m) => m.repo === repo && BRINGING_UP.has(m.phase.kind));
    let inRepo = count((m) => m.repo === repo);
    if (block || repoCreateBlock(state, repo, now, config)) continue;
    // Each pass of the loop stands for one future create, so it also spends the hourly allowance.
    let allowance = config.createsPerRepoPerHour - (state.creates ?? []).filter((r) => r.repo === repo && now - r.at < HOUR).length;
    while (need > 0 && inRepo < config.perRepoCap && allowance-- > 0) {
      const size = sizeWithRoom(repoLadder(state, config, repo), used);
      if (size) {
        creates.push({ kind: "create", repo, size });
        used.set(size, (used.get(size) ?? 0) + 1);
        inRepo++;
      } else if (slotsFreeing > 0) {
        slotsFreeing--;
      } else {
        const victim = stealable.shift();
        if (!victim) break;
        close(victim, "idle");
      }
      need--;
    }
  }

  for (const list of idleByRepo.values()) {
    for (const m of list) {
      if (closingNow.has(m.id) || m.phase.kind !== "idle") continue;
      if (now - m.phase.since >= config.idleCloseMinutes * MINUTE) close(m, "idle");
    }
  }

  return [...expireTickets, ...expireLeases, ...closes, ...extends_, ...leaseExtends, ...grants, ...creates, ...continues];
}

/** Queue position (1-based, within the repo) and why the ticket is still waiting. */
export function queueInfo(state: State, ticketId: string, now: number, config: Config): { position: number; reason?: string } {
  const ticket = state.tickets.find((t) => t.id === ticketId);
  if (!ticket) return { position: 0 };
  const ahead = state.tickets.filter((t) => t.repo === ticket.repo && t.status === "queued");
  const position = ahead.findIndex((t) => t.id === ticketId) + 1;
  const machines = Object.values(state.machines);
  const inRepo = machines.filter((m) => m.repo === ticket.repo);
  const block = createBlock(state, now, config);
  if (block) return { position, reason: block };
  if (inRepo.some((m) => BRINGING_UP.has(m.phase.kind) || m.phase.kind === "resetting")) {
    return { position, reason: "a machine is starting" };
  }
  if (inRepo.length >= config.perRepoCap) return { position, reason: `all ${config.perRepoCap} machines for this repo are busy` };
  const repoBlock = repoCreateBlock(state, ticket.repo, now, config);
  if (repoBlock) return { position, reason: repoBlock };
  const used = sizesInUse(machines);
  const ladder = repoLadder(state, config, ticket.repo);
  if (!ladder.length) return { position, reason: `this repo needs ${state.repoMinSize?.[ticket.repo]} or larger, which the size ladder does not have` };
  if (!sizeWithRoom(ladder, used)) {
    const min = state.repoMinSize?.[ticket.repo];
    return { position, reason: `every machine size${min ? ` this repo fits in (${min} or larger)` : ""} is in use (${ladderText(ladder, used)})` };
  }
  return { position };
}
