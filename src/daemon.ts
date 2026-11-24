import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { busyThreads, cloneRepo, configureFront, pushAccounts, continueOnAccount, execPoll, execStart, exportThreads, FRONT_PORT, install, machineLabel, pairAndLink, PUT_MAX_BYTES, putFile, removePutFiles, resetCheckout, runRepoSetup, scanLimits, scrubForSnapshot, setupProject } from "./bringup.ts";
import type { Account, ExecView, Remote } from "./bringup.ts";
import { paths } from "./config.ts";
import { LizardLimitError, LizardPaymentError } from "./lizard.ts";
import type { Lizard } from "./lizard.ts";
import { learnSize, nextSizeUp, repoGaps, repoIdleMs, repoLadder, vcpuFree } from "./plan.ts";
import { accountLimited, accountWait, BRINGING_UP, BUDGET_UNIT, createBackoff, createBlock, machineAccounts, nextFreeAccount, plan, queueInfo, repoCreateBlock, sizesInUse, usedSmallHours, utcDay } from "./plan.ts";
import { startProxy } from "./proxy.ts";
import type { ProbeResult } from "./probe.ts";
import { addStep, readHistory, readSetup, removeStep } from "./setup.ts";
import type { RepoSetup } from "./setup.ts";
import type { Proxy } from "./proxy.ts";
import type { LocalT3 } from "./t3local.ts";
import { emptyState, SIZE_USD_PER_HOUR, SIZE_VCPU, SIZE_WEIGHT } from "./types.ts";
import type { JobRecord, SnapshotRecord } from "./types.ts";
import type { AccountId, Action, CloseReason, Config, CreateRecord, Lease, Machine, MachineId, MachinePhase, RepoKey, Size, State, Ticket } from "./types.ts";

const MINUTE = 60_000;
const PENDING = "pending:";
/** Stands in for an environment id on machines brought up with linkEnvironment: false. */
const NO_LINK = "unlinked";
const BUSY_LEASE_GRACE_MS = 10 * MINUTE;
/** A leased machine that has not answered this long is closed (see noAnswer). */
const UNRESPONSIVE_CLOSE_MS = 10 * MINUTE;
/** An account whose thread failed to authenticate is skipped this long, unless a probe says it works. */
const AUTH_BLOCK_MINUTES = 10;
/** A snapshot older than this is rebuilt (newer Claude CLI, tools and dependencies). */
const SNAPSHOT_MAX_AGE_MS = 14 * 24 * 60 * MINUTE;
/** A failed or skipped snapshot build is tried again no sooner than this. */
const BAKE_RETRY_MS = 30 * MINUTE;
const BAKE_LIFETIME_MINUTES = 40;
const snapKey = (repo: RepoKey, size: Size) => `${repo}|${size}`;
/** How often a working account is asked again (only while a machine is leased), and a broken one. */
const PROBE_OK_EVERY_MS = 60 * MINUTE;
const PROBE_AUTH_EVERY_MS = 30 * MINUTE;
const PROBE_ERROR_EVERY_MS = 10 * MINUTE;
/** How often a leased machine is checked for threads stopped on a usage limit. */
const LIMIT_SCAN_EVERY_MS = MINUTE;
/** Allowed difference between the machine's clock and the devbox's. */
const CLOCK_SKEW_MS = MINUTE;
const ANTIGRAVITY_INSTANCE = "antigravity";
const DEFAULT_ANTIGRAVITY_MODEL = "gemini-4-neon";

export interface DaemonDeps {
  lizard: Lizard;
  t3: LocalT3;
  config: Config;
  /** Values written to the machine's env file (config.forwardEnv). Never a Claude/Antigravity token. */
  machineEnv: Record<string, string>;
  /** Token of each account in config.accounts. Goes only into that account's T3 provider instance. */
  accountTokens: Record<AccountId, string>;
  /** Antigravity OAuth token JSON. Written only to Antigravity's profile directory on each machine. */
  antigravityToken?: string;
  home: string;
  /** Asks one account's login what it can do (src/probe.ts). Unset: no probing (tests). */
  probe?: (token: string) => Promise<ProbeResult>;
  /** Names for accounts (claudeAgent_acct3 -> claude-xianjun-klovr), from CLAUDE_ACCOUNT_LABEL_<n>. For humans only. */
  accountLabels?: Record<string, string>;
  resolveRepo(input: string): Promise<RepoKey>;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type LeaseView = {
  leaseId: string;
  machineId: MachineId;
  /** The machine's size. A busy ladder can hand out a smaller one than usual (mini: 1 vCPU, 2 GB). */
  size: Size;
  environmentId: string;
  projectId: string;
  workspacePath: string;
  expiresAt: string;
  /** The provider instance to delegate to (Antigravity by default when configured, else a Claude account). */
  providerInstanceId?: AccountId;
  /** Default model to pass with providerInstanceId (e.g. "gemini-4-neon" for Antigravity). */
  model?: string;
  /** Free Claude account to use when explicitly delegating to Claude instead of Antigravity. */
  claudeProviderInstanceId?: AccountId;
};

export type TicketView =
  | { ticketId: string; status: "granted"; lease: LeaseView }
  | { ticketId: string; status: "queued"; position: number; reason?: string }
  | { ticketId: string; status: "released" | "cancelled" | "expired"; error?: string };

/** Thrown inside a machine operation when someone else (close, reconcile) moved the machine on. */
class Superseded extends Error {}

export class Daemon {
  state: State = emptyState();
  private deps: DaemonDeps;
  private files: ReturnType<typeof paths>;
  private proxies = new Map<MachineId, Proxy>();
  /** put and its cleanup run one at a time per machine, so a cleanup never races a write. */
  private putChains = new Map<MachineId, Promise<unknown>>();
  private running = new Map<string, Promise<void>>();
  private createsInFlight = 0;
  private createsDone = 0;
  /** Orphans already killed, so a listing that still shows them does not kill them again every tick. */
  private orphansKilled = new Set<MachineId>();
  private ticking = false;
  private changes = new EventEmitter();
  private t3Version?: string;
  private lastLimitScan = new Map<MachineId, number>();
  private lastAccountPush = new Map<MachineId, number>();
  private probing = false;
  /** The snapshot being built (`<repo>|<size>`), at most one at a time. */
  private baking: string | undefined;
  private lastBakeTry = new Map<string, number>();
  /** Accounts to probe at the next chance: a thread just failed on them. */
  private probeNow = new Set<AccountId>();
  /** A continue that failed is retried after this time, not every tick. */
  private continueRetryAt = new Map<string, number>();
  private remote: Remote;

  constructor(deps: DaemonDeps) {
    this.deps = deps;
    this.files = paths(deps.home);
    this.remote = { lizard: deps.lizard, sleep: deps.sleep, log: (l) => deps.log(l) };
    this.changes.setMaxListeners(0);
  }

  // ---- lifecycle ----

  /** Load state, re-open proxies so existing T3 links keep working, and resume interrupted work. */
  async start(): Promise<void> {
    mkdirSync(this.deps.home, { recursive: true, mode: 0o700 });
    if (existsSync(this.files.state)) this.state = JSON.parse(readFileSync(this.files.state, "utf8"));
    const now = this.deps.now();
    // A create cut short by a restart may still have made a sandbox: reconcile kills it as an orphan.
    // Its record stays, settled as lost, so it still counts toward the hourly cap and the backoff.
    for (const r of this.state.creates ?? []) {
      if (r.outcome === "pending" && r.machineId.startsWith(PENDING)) Object.assign(r, { outcome: "lost", settledAt: now, reason: "daemon restarted during create" });
    }
    for (const m of Object.values(this.state.machines)) {
      if (m.id.startsWith(PENDING)) {
        delete this.state.machines[m.id];
        continue;
      }
      if (m.phase.kind === "resetting") m.phase = { kind: "idle", since: now };
      if (m.proxyPort && m.hostname && m.accessToken) {
        await this.openProxy(m).catch((e) => this.deps.log(`proxy for ${m.id} did not reopen: ${e.message}`));
      }
      if (m.phase.kind === "installing" || m.phase.kind === "linking") this.launch(`bringup:${m.id}`, () => this.bringUp(m.id));
      if (m.phase.kind === "closing") this.launch(`close:${m.id}`, () => this.finishClose(m.id));
    }
    this.save();
  }

  async stop(): Promise<void> {
    await this.settled();
    await Promise.all([...this.proxies.values()].map((p) => p.close()));
    this.proxies.clear();
  }

  /** Resolves once no background operation is running. Tests use it to step a fake clock. */
  async settled(): Promise<void> {
    while (this.running.size) await Promise.allSettled([...this.running.values()]);
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.accrueUsage();
      await this.reconcile();
      this.reopenProxies();
      this.step();
      this.scanForLimits();
      this.syncAccounts();
      this.probeAccounts();
      this.maintainSnapshots();
    } finally {
      this.ticking = false;
    }
  }

  /** Run the scheduler once and start what it decides. No Lizard listing. */
  step(): void {
    const now = this.deps.now();
    for (const action of plan(this.state, now, this.deps.config)) this.apply(action);
    this.pruneTickets(now);
    this.save();
  }

  // ---- API ----

  async acquire(req: { repo: string; ref: string; holder: string }): Promise<TicketView> {
    const repo = await this.deps.resolveRepo(req.repo).catch((e) => {
      throw new ApiError(400, `cannot resolve repo ${req.repo}: ${(e as Error).message}`);
    });
    const ticket: Ticket = { id: randomUUID(), repo, ref: req.ref, holder: req.holder, enqueuedAt: this.deps.now(), status: "queued" };
    this.state.tickets.push(ticket);
    this.deps.log(`ticket ${ticket.id} queued for ${repo}@${req.ref} by ${req.holder}`);
    this.step();
    // An idle machine was granted: wait out the checkout reset so the caller gets the lease now.
    return this.waitUntil(ticket.id, 120, (v) => v.status !== "queued" || !this.isResetting(ticket.id));
  }

  wait(req: { ticketId: string; maxSeconds: number }): Promise<TicketView> {
    return this.waitUntil(req.ticketId, Math.min(req.maxSeconds, 300), (v) => v.status !== "queued");
  }

  /**
   * Runs a command on a leased machine, in its checkout, with no agent and no Claude account. Waits up
   * to maxSeconds; a longer job comes back as "running" and execWait picks it up. The lease's holder
   * is trusted with the machine already (a delegated thread could run the same command).
   */
  async exec(req: { leaseId: string; command: string; timeoutMinutes?: number; maxSeconds?: number }): Promise<ExecView> {
    const { lease, machine } = this.leased(req.leaseId);
    if (!req.command.trim()) throw new ApiError(400, "empty command");
    if (Buffer.byteLength(req.command) > 200_000) throw new ApiError(400, "command is over 200 KB; put a long script in the repo and run that");
    const minutes = Math.min(Math.max(req.timeoutMinutes ?? 30, 1), 180);
    const execId = randomUUID().slice(0, 8);
    await execStart(this.remote, machine.id, machine.workspacePath!, execId, req.command, minutes * 60);
    this.deps.log(`exec ${execId} on ${machine.id} for ${lease.holder}: ${req.command.split("\n")[0].slice(0, 100)}`);
    return this.execWait({ leaseId: lease.id, execId, maxSeconds: req.maxSeconds ?? 120 });
  }

  /** Waits for an exec to finish, up to maxSeconds (at most 300), and returns its state and output tail. */
  async execWait(req: { leaseId: string; execId: string; maxSeconds?: number }): Promise<ExecView> {
    const { machine } = this.leased(req.leaseId);
    const until = this.deps.now() + Math.min(Math.max(req.maxSeconds ?? 120, 0), 300) * 1000;
    for (;;) {
      const view = await execPoll(this.remote, machine.id, req.execId).catch((e) => {
        throw new ApiError(502, `cannot read exec ${req.execId} on ${machine.id}: ${(e as Error).message}`);
      });
      if (view.status === "exited" || this.deps.now() >= until) return view;
      await this.deps.sleep(Math.min(3000, Math.max(0, until - this.deps.now())));
      // The lease may have ended while waiting: stop then, the machine is gone or reassigned.
      this.leased(req.leaseId);
    }
  }

  /**
   * Writes one file under the sandbox user's home on a leased machine: a login or an .env for this
   * job only, so it never goes to every repo's machines the way forwardEnv does. The content is never
   * logged, saved in state, or put in an answer or an error.
   */
  async put(req: { leaseId: string; path: string; contentBase64: string; mode?: string }): Promise<{ path: string; bytes: number; mode: string }> {
    const { lease, machine } = this.leased(req.leaseId);
    const rel = homeRelative(req.path, this.deps.config.sandboxUser);
    const mode = req.mode ?? "600";
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(req.contentBase64) || req.contentBase64.length % 4 !== 0) throw new ApiError(400, "contentBase64 is not base64");
    const content = Buffer.from(req.contentBase64, "base64");
    if (content.length > PUT_MAX_BYTES) throw new ApiError(400, `the file is over ${PUT_MAX_BYTES / 1024} KB`);
    const path = await this.onMachine(machine.id, async () => {
      // The lease may have ended while this waited for the machine.
      this.leased(req.leaseId);
      // Recorded before the write, so a write that half-worked is still cleaned up.
      this.trackPut(machine.id, rel);
      let out: { path: string; rel: string };
      try {
        out = await putFile(this.remote, machine.id, rel, req.contentBase64, mode);
      } catch (e) {
        // Only fixed words go back: the machine's output or a Lizard error could quote the content.
        const msg = (e as Error).message;
        const why = msg.match(/the path leaves the home folder|the path is a folder/)?.[0] ?? msg.match(/\(exit \d+\)/)?.[0] ?? "the machine did not answer";
        throw new ApiError(502, `writing ~/${rel} on ${machine.id} failed: ${why}`);
      }
      // Where it really landed, after links: cleanup removes that, whatever the links point to later.
      this.trackPut(machine.id, out.rel);
      return out.path;
    });
    this.deps.log(`put ~/${rel} (${content.length} bytes, mode ${mode}) on ${machine.id} for ${lease.holder}`);
    return { path, bytes: content.length, mode };
  }

  private trackPut(machineId: MachineId, rel: string): void {
    const m = this.state.machines[machineId];
    if (!m || m.putFiles?.includes(rel)) return;
    m.putFiles = [...(m.putFiles ?? []), rel];
    this.save();
  }

  private onMachine<T>(id: MachineId, fn: () => Promise<T>): Promise<T> {
    const run = (this.putChains.get(id) ?? Promise.resolve()).catch(() => {}).then(fn);
    this.putChains.set(id, run);
    return run;
  }

  /** Removes the files put wrote on a machine. Throws when the machine cannot confirm it. */
  private cleanPuts(machineId: MachineId): Promise<void> {
    return this.onMachine(machineId, async () => {
      const files = this.state.machines[machineId]?.putFiles;
      if (!files?.length) return;
      await removePutFiles(this.remote, machineId, files);
      const m = this.state.machines[machineId];
      if (m) delete m.putFiles;
      this.save();
      this.deps.log(`removed ${files.length} put file(s) on ${machineId}`);
    });
  }

  private leased(leaseId: string): { lease: Lease; machine: Machine } {
    const lease = this.state.leases[leaseId];
    if (!lease) throw new ApiError(404, `no lease ${leaseId}`);
    const machine = this.state.machines[lease.machineId];
    if (!machine || machine.phase.kind !== "leased" || machine.phase.leaseId !== leaseId || !machine.workspacePath) {
      throw new ApiError(409, `the machine of lease ${leaseId} is not available`);
    }
    return { lease, machine };
  }

  /** Ends a lease, or cancels a ticket (releasing its lease if it has one). */
  release(req: { leaseId?: string; ticketId?: string }): { released: boolean } {
    let leaseId = req.leaseId;
    if (req.ticketId) {
      const t = this.ticket(req.ticketId);
      if (t.status === "queued") {
        this.endTicket(t, "cancelled", "cancelled by holder");
        for (const m of Object.values(this.state.machines)) {
          if (m.phase.kind === "resetting" && m.phase.ticketId === t.id) m.phase = { kind: "idle", since: this.deps.now() };
        }
        this.step();
        return { released: true };
      }
      if (t.status === "granted") leaseId = t.leaseId;
    }
    if (!leaseId || !this.state.leases[leaseId]) return { released: false };
    this.endLease(leaseId, "released");
    this.step();
    return { released: true };
  }

  renew(req: { leaseId: string }): { expiresAt: string } {
    const lease = this.state.leases[req.leaseId];
    if (!lease) throw new ApiError(404, `no lease ${req.leaseId}`);
    lease.expiresAt = this.deps.now() + this.deps.config.leaseMinutes * MINUTE;
    this.save();
    return { expiresAt: new Date(lease.expiresAt).toISOString() };
  }

  close(req: { machineId: string }): { closing: boolean } {
    const m = this.state.machines[req.machineId];
    if (!m || m.id.startsWith(PENDING)) throw new ApiError(404, `no machine ${req.machineId}`);
    this.apply({ kind: "close", machineId: m.id, reason: "manual" });
    this.save();
    return { closing: true };
  }

  /**
   * A leased machine whose commands time out. After UNRESPONSIVE_CLOSE it is closed, so its slot
   * frees, and its repo learns to use the next size up: a job that freezes a machine will freeze the
   * next one of that size too (an aldrent push gate on a 2 GB mini did, twice).
   */
  private noAnswer(m: Machine, lease: Lease): void {
    const now = this.deps.now();
    if (!m.unresponsiveSince) {
      m.unresponsiveSince = now;
      this.save();
      return;
    }
    if (now - m.unresponsiveSince < UNRESPONSIVE_CLOSE_MS || m.phase.kind !== "leased" || m.phase.leaseId !== lease.id) return;
    const up = nextSizeUp(this.deps.config, m.size);
    const known = this.state.repoMinSize?.[m.repo];
    if (up && (!known || SIZE_WEIGHT[up] > SIZE_WEIGHT[known])) {
      (this.state.repoMinSize ??= {})[m.repo] = up;
      this.deps.log(`${m.repo} learned: a ${m.size} stopped answering during ${lease.holder}; it now gets ${up} or larger`);
    }
    this.recordJob({ ...this.jobBase(lease, m.size), froze: true });
    this.deps.log(`closing machine ${m.id}: no answer for ${Math.round((now - m.unresponsiveSince) / MINUTE)} minutes`);
    this.apply({ kind: "close", machineId: m.id, reason: "unresponsive" });
    this.save();
  }

  private jobBase(lease: Lease, size: Size): JobRecord {
    return {
      repo: lease.repo,
      holder: lease.holder,
      size,
      machineId: lease.machineId,
      grantedAt: lease.grantedAt,
      endedAt: this.deps.now(),
      waitedMs: lease.waitedMs ?? 0,
    };
  }

  /** At grant: zero the machine's mem-peak and note where guard.log ends, so the stats are this lease's. */
  private async resetPeak(id: MachineId, leaseId: string): Promise<void> {
    try {
      const out = (await this.deps.lizard.exec(id, ["bash", "-c", 'D="$HOME/.t3lizard"; echo 0 > "$D/mem-peak" 2>/dev/null; wc -l < "$D/guard.log" 2>/dev/null || echo 0'], 30_000)).stdout;
      const lease = this.state.leases[leaseId];
      if (lease) {
        lease.guardLogLines = Number(out.trim()) || 0;
        this.save();
      }
    } catch {
      // Stats for this lease are then unknown; learning skips it.
    }
  }

  /** At release: read the lease's peak memory and memory kills from the machine, then record and learn. */
  private async finishJob(lease: Lease, size: Size): Promise<void> {
    const rec = this.jobBase(lease, size);
    if (this.state.machines[lease.machineId] && !this.state.machines[lease.machineId].unresponsiveSince) {
      try {
        const from = (lease.guardLogLines ?? 0) + 1;
        const out = (await this.deps.lizard.exec(
          lease.machineId,
          ["bash", "-c", 'D="$HOME/.t3lizard"; echo "peak=$(cat "$D/mem-peak" 2>/dev/null)"; echo "kills=$(tail -n +"$1" "$D/guard.log" 2>/dev/null | grep -c killed)"', "t3lizard", String(from)],
          30_000,
        )).stdout;
        const peak = out.match(/peak=(\d+)/)?.[1];
        const kills = out.match(/kills=(\d+)/)?.[1];
        if (peak !== undefined && Number(peak) > 0) rec.peakMemPct = Number(peak);
        if (kills !== undefined) rec.memKills = Number(kills);
      } catch {
        // A machine that does not answer gives no stats; noAnswer handles a freeze.
      }
    }
    if (this.state.machines[lease.machineId]?.workspacePath && !this.state.machines[lease.machineId].unresponsiveSince) {
      rec.chats = await this.saveChats(lease).catch((e) => {
        this.deps.log(`saving chats of ${lease.machineId} failed: ${(e as Error).message}`);
        return undefined;
      });
    }
    this.recordJob(rec);
  }

  /** The machine's threads of this lease, saved to <home>/transcripts/<machine>/<n>.json. */
  private async saveChats(lease: Lease): Promise<JobRecord["chats"]> {
    const m = this.state.machines[lease.machineId];
    const since = new Date(lease.grantedAt - CLOCK_SKEW_MS).toISOString();
    const tgz = await exportThreads(this.remote, m.id, m.workspacePath!, since);
    if (!tgz.length) return [];
    const dir = join(this.transcriptsDir(), m.id);
    mkdirSync(dir, { recursive: true });
    const tmp = mkdtempSync(join(tmpdir(), "t3lizard-chats-"));
    try {
      execFileSync("tar", ["-xzf", "-", "-C", tmp], { input: tgz });
      const chats: NonNullable<JobRecord["chats"]> = [];
      for (const f of readdirSync(tmp).filter((x) => x.endsWith(".json"))) {
        const data = JSON.parse(readFileSync(join(tmp, f), "utf8")) as { thread?: { threadId?: string; title?: string }; messages?: unknown[] };
        const threadId = data.thread?.threadId;
        if (!threadId) continue;
        const file = `${m.id}/${threadId.replace(/[^A-Za-z0-9._-]/g, "_").slice(-120)}.json`;
        writeFileSync(join(this.transcriptsDir(), file), JSON.stringify({ ...data, savedAt: new Date(this.deps.now()).toISOString(), machineId: m.id, repo: m.repo, holder: lease.holder }));
        chats.push({ threadId, title: data.thread?.title ?? threadId, file, messages: data.messages?.length ?? 0 });
      }
      if (chats.length) this.deps.log(`saved ${chats.length} chat(s) of ${m.id} (${lease.holder})`);
      return chats;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  transcriptsDir(): string {
    return join(this.deps.home, "transcripts");
  }

  /** Keeps the latest 500 jobs and updates the repo's learned size. */
  private recordJob(rec: JobRecord): void {
    const jobs = (this.state.jobs ??= []);
    jobs.unshift(rec);
    jobs.length = Math.min(jobs.length, 500);
    const { config } = this.deps;
    const current = this.state.repoSize?.[rec.repo]?.size ?? config.defaultSize;
    const next = learnSize(config, current, jobs.filter((j) => j.repo === rec.repo), this.state.repoMinSize?.[rec.repo]);
    if (next && next.size !== current) {
      (this.state.repoSize ??= {})[rec.repo] = { ...next, at: this.deps.now() };
      this.deps.log(`${rec.repo} learned: next machines are ${next.size} (${next.why})`);
    }
    this.save();
  }

  /** Jobs, spend and learned sizes for the dashboard. */
  dashboard() {
    const now = this.deps.now();
    const { config } = this.deps;
    const used = new Map<Size, number>();
    for (const m of Object.values(this.state.machines)) used.set(m.size, (used.get(m.size) ?? 0) + 1);
    const vcpuInUse = [...used].reduce((n, [size, k]) => n + SIZE_VCPU[size] * k, 0);
    const usdPerSmallSecond = SIZE_USD_PER_HOUR.small / 3600;
    const days = Object.entries(this.state.usage).sort(([a], [b]) => (a < b ? 1 : -1)).slice(0, 31);
    const month = new Date(now).toISOString().slice(0, 7);
    const spend = {
      today: (this.state.usage[new Date(now).toISOString().slice(0, 10)] ?? 0) * usdPerSmallSecond,
      thisMonth: days.filter(([d]) => d.startsWith(month)).reduce((n, [, v]) => n + v * usdPerSmallSecond, 0),
      byDay: days.map(([day, v]) => ({ day, usd: v * usdPerSmallSecond })),
    };
    const repos = new Set([...Object.keys(this.state.repoSize ?? {}), ...(this.state.jobs ?? []).map((j) => j.repo)]);
    const learned = [...repos].map((repo) => {
      const jobs = (this.state.jobs ?? []).filter((j) => j.repo === repo);
      const seen = new Set<string>();
      let reused = 0;
      for (const j of [...jobs].sort((a, b) => a.grantedAt - b.grantedAt)) {
        if (seen.has(j.machineId)) reused++;
        seen.add(j.machineId);
      }
      const gaps = repoGaps(this.state, repo);
      return {
      repo,
      keepIdleMinutes: Math.round(repoIdleMs(this.state, config, repo) / MINUTE),
      idleWhy: (() => {
        if (gaps.length < 3) return `default: ${gaps.length} of 3 gaps between jobs seen so far`;
        const p75 = Math.round([...gaps].sort((a, b) => a - b)[Math.ceil(gaps.length * 0.75) - 1] / MINUTE);
        const max = config.idleMaxMinutes ?? config.idleCloseMinutes;
        return p75 > max
          ? `jobs usually come more than ${max} min apart (3 in 4 gaps under ${p75} min): not worth waiting`
          : `3 in 4 of the last ${gaps.length} gaps between jobs were under ${p75} min`;
      })(),
      jobs: jobs.length,
      reusePct: jobs.length ? Math.round((reused / jobs.length) * 100) : undefined,
      size: this.state.repoSize?.[repo]?.size ?? config.defaultSize,
      why: this.state.repoSize?.[repo]?.why ?? "default, nothing learned yet",
      minSize: this.state.repoMinSize?.[repo],
      };
    });
    return {
      now,
      vcpu: { limit: config.vcpuLimit, reserve: config.vcpuReserve, inUse: vcpuInUse, free: vcpuFree(config, used) },
      spend,
      learned,
      jobs: (this.state.jobs ?? []).slice(0, 100),
      status: this.status(),
    };
  }

  /**
   * One-time pairing links a person opens (or pastes into Add environment) to see a machine's threads
   * in their own T3 app. Needs publicHost/publicBind, since 127.0.0.1 on the devbox is not the browser's.
   */
  async connect(req: { machineId?: string }): Promise<{ links: { machineId: string; label: string; url: string }[]; note?: string }> {
    const { publicHost } = this.deps.config;
    if (!publicHost) throw new ApiError(400, 'set "publicHost" and "publicBind" in config.json (the devbox Tailscale name and IP) first');
    const ms = Object.values(this.state.machines).filter(
      (m) => !m.id.startsWith(PENDING) && m.proxyPort && m.environmentId && (!req.machineId || m.id === req.machineId),
    );
    if (req.machineId && !ms.length) throw new ApiError(404, `no linked machine ${req.machineId}`);
    const links = [];
    for (const m of ms) {
      const base = `http://${publicHost}:${m.proxyPort}`;
      const minutesLeft = Math.max(5, Math.ceil((m.deadline - this.deps.now()) / MINUTE));
      const out = (await this.deps.lizard.exec(
        m.id,
        ["bash", "-c", 'export PATH="$HOME/.local/bin:$PATH"; t3 auth pairing create --base-dir "$HOME/.t3" --json --ttl "$1m" --label "browser" --base-url "$2"', "t3lizard", String(minutesLeft), base],
        60_000,
      )).stdout;
      const json = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)) as Record<string, unknown>;
      const url = Object.values(json).find((v) => typeof v === "string" && v.includes("/pair#")) as string | undefined;
      const credential = typeof json.credential === "string" ? json.credential : undefined;
      const link = url ?? (credential ? `${base}/pair#token=${credential}` : undefined);
      if (!link) throw new Error(`no pairing link from ${m.id}`);
      links.push({ machineId: m.id, label: machineLabel(m.repo, m.id, m.size), url: link });
    }
    return { links, ...(links.length ? {} : { note: "no linked machines right now" }) };
  }

  status() {
    const now = this.deps.now();
    const { config } = this.deps;
    const minutes = (ms: number) => Math.round(ms / MINUTE);
    const pools: Record<RepoKey, { machines: unknown[]; queue: unknown[]; leases: unknown[]; createsLastHour?: number; createsBlocked?: string }> = {};
    const pool = (repo: RepoKey) => (pools[repo] ??= { machines: [], queue: [], leases: [] });
    for (const m of Object.values(this.state.machines)) {
      pool(m.repo).machines.push({
        id: m.id,
        size: m.size,
        phase: m.phase.kind,
        ...(m.phase.kind === "failed" ? { error: m.phase.error } : {}),
        ageMinutes: minutes(now - m.createdAt),
        deadlineInMinutes: minutes(m.deadline - now),
        environmentId: m.environmentId,
        label: machineLabel(m.repo, m.id, m.size),
        ...(m.antigravity ? { antigravity: true } : {}),
        ...(m.unresponsiveSince ? { notAnswering: `no answer since ${minutes(now - m.unresponsiveSince)} min ago (likely out of memory)` } : {}),
        ...(m.limitedThreads?.length ? { limitedThreads: m.limitedThreads } : {}),
        ...this.waitView(m, now),
      });
    }
    for (const t of this.state.tickets) {
      if (t.status !== "queued") continue;
      pool(t.repo).queue.push({ ticketId: t.id, holder: t.holder, ref: t.ref, waitedMinutes: minutes(now - t.enqueuedAt), ...queueInfo(this.state, t.id, now, config) });
    }
    for (const [repo, p] of Object.entries(pools)) {
      const n = (this.state.creates ?? []).filter((r) => r.repo === repo && now - r.at < 60 * MINUTE).length;
      if (n) p.createsLastHour = n;
      const min = this.state.repoMinSize?.[repo];
      if (min) (p as Record<string, unknown>).minSize = `${min} (learned: a smaller machine froze on this repo's jobs)`;
      const blocked = repoCreateBlock(this.state, repo, now, config);
      if (blocked) p.createsBlocked = blocked;
    }
    for (const l of Object.values(this.state.leases)) {
      pool(l.repo).leases.push({ leaseId: l.id, machineId: l.machineId, holder: l.holder, ref: l.ref, expiresInMinutes: minutes(l.expiresAt - now) });
    }
    return {
      pools,
      snapshots: Object.values(this.state.snapshots ?? {}).map((s) => ({ repo: s.repo, size: s.size, id: s.id, ageMinutes: minutes(now - s.builtAt), ...this.snapshotStale(s, now) })),
      ...(this.baking ? { baking: this.baking } : {}),
      ...(this.state.lastBake ? { lastBake: { ...this.state.lastBake, at: new Date(this.state.lastBake.at).toISOString() } } : {}),
      budget: {
        unit: `${BUDGET_UNIT}: 1 h of small = 1, mini = 0.5, nano = 0.25 (Lizard per-hour prices)`,
        usedToday: Number(usedSmallHours(this.state, now).toFixed(2)),
        dailyLimit: config.dailySmallMachineHours,
      },
      sizes: (() => {
        const used = sizesInUse(Object.values(this.state.machines));
        return config.sizes.map((s) => ({ size: s.size, max: s.max, inUse: used.get(s.size) ?? 0 }));
      })(),
      perRepoCap: config.perRepoCap,
      createsBlocked: createBlock(this.state, now, config),
      lastLizardError: this.state.lastLizardError,
      antigravityConfigured: Boolean(this.deps.antigravityToken),
      defaultProvider: this.deps.antigravityToken ? (config.defaultProvider ?? "antigravity") : "claude",
      ...(this.deps.antigravityToken && (config.defaultProvider ?? "antigravity") === "antigravity"
        ? { defaultModel: config.defaultModel ?? DEFAULT_ANTIGRAVITY_MODEL }
        : {}),
      accounts: config.accounts.map((id) => {
        const until = this.state.accounts?.[id]?.limitedUntil;
        return { id, ...(this.deps.accountLabels?.[id] ? { label: this.deps.accountLabels[id] } : {}), free: !accountLimited(this.state, id, now), ...(until && until > now ? { limitedUntil: new Date(until).toISOString() } : {}), ...(until && until > now && this.state.accounts?.[id]?.disabled ? { disabled: true } : {}),
          ...(until && until > now && this.state.accounts?.[id]?.auth ? { authFailed: true } : {}),
          ...this.probeView(id, now) };
      }),
    };
  }

  view(ticketId: string): TicketView {
    const t = this.ticket(ticketId);
    if (t.status === "queued") return { ticketId, status: "queued", ...queueInfo(this.state, ticketId, this.deps.now(), this.deps.config) };
    if (t.status === "granted") {
      const lease = this.state.leases[t.leaseId];
      const m = lease && this.state.machines[lease.machineId];
      const account = m && this.accountFor(m);
      if (!lease || !m?.environmentId || !m.projectId || !m.workspacePath) return { ticketId, status: "released" };
      const useAntigravity = Boolean(m.antigravity) && (this.deps.config.defaultProvider ?? "antigravity") === "antigravity";
      return {
        ticketId,
        status: "granted",
        lease: {
          leaseId: lease.id,
          machineId: m.id,
          size: m.size,
          environmentId: m.environmentId,
          projectId: m.projectId,
          workspacePath: m.workspacePath,
          expiresAt: new Date(lease.expiresAt).toISOString(),
          ...(useAntigravity
            ? {
                providerInstanceId: ANTIGRAVITY_INSTANCE,
                model: this.deps.config.defaultModel ?? DEFAULT_ANTIGRAVITY_MODEL,
                ...(account ? { claudeProviderInstanceId: account } : {}),
              }
            : account
              ? { providerInstanceId: account }
              : {}),
        },
      };
    }
    return { ticketId, status: t.status, ...(t.error ? { error: t.error } : {}) };
  }

  // ---- scheduler actions ----

  private apply(a: Action): void {
    switch (a.kind) {
      case "expireTicket":
        this.endTicket(this.ticket(a.ticketId), "expired", `waited longer than ${this.deps.config.ticketMaxWaitMinutes} minutes`);
        return;
      case "grant":
        this.state.machines[a.machineId].phase = { kind: "resetting", ticketId: a.ticketId };
        this.launch(`grant:${a.machineId}`, () => this.grant(a.ticketId, a.machineId));
        return;
      case "create":
        this.create(a.repo, a.size);
        return;
      case "extend":
        this.launch(`extend:${a.machineId}`, () => this.extend(a.machineId, a.deadline));
        return;
      case "expireLease":
        this.launch(`lease:${a.leaseId}`, () => this.expireLease(a.leaseId));
        return;
      case "close":
        this.beginClose(a.machineId, a.reason);
        return;
      case "extendLease": {
        const lease = this.state.leases[a.leaseId];
        if (!lease || lease.expiresAt >= a.expiresAt) return;
        lease.expiresAt = a.expiresAt;
        this.deps.log(`lease ${a.leaseId} kept until ${new Date(a.expiresAt).toISOString()}: every Claude account is limited`);
        return;
      }
      case "continueThread": {
        const key = `continue:${a.machineId}:${a.threadId}`;
        if ((this.continueRetryAt.get(key) ?? 0) > this.deps.now()) return;
        this.launch(key, () => this.continueThread(a));
        return;
      }
    }
  }

  private create(repo: RepoKey, size: Size): void {
    const { config } = this.deps;
    const now = this.deps.now();
    const lifetimeMs = config.lifetimeMinutes * MINUTE;
    const snap = this.state.snapshots?.[snapKey(repo, size)];
    const pendingId = `${PENDING}${randomUUID()}`;
    this.state.machines[pendingId] = { id: pendingId, repo, size, createdAt: now, deadline: now + lifetimeMs, phase: { kind: "creating" } };
    const record: CreateRecord = { machineId: pendingId, repo, at: now, outcome: "pending" };
    (this.state.creates ??= []).push(record);
    this.createsInFlight++;
    this.launch(`create:${pendingId}`, async () => {
      try {
        const { id, deadline } = await this.deps.lizard.create(repo, size, lifetimeMs, snap?.id);
        const pending = this.state.machines[pendingId];
        delete this.state.machines[pendingId];
        // From a snapshot the tools and the repo's setup are already on disk: bring-up finds them and skips them.
        this.state.machines[id] = { ...pending, id, deadline, phase: { kind: "installing" }, ...(snap ? { fromSnapshot: snap.id, ...(snap.setupHash ? { setupHash: snap.setupHash } : {}) } : {}) };
        record.machineId = id;
        // Every machine counts at least createChargeMinutes, so a create loop of short-lived
        // machines still runs into the daily budget. accrueUsage skips that first stretch.
        const day = utcDay(pending.createdAt);
        this.state.usage[day] = (this.state.usage[day] ?? 0) + config.createChargeMinutes * 60 * SIZE_WEIGHT[size];
        this.deps.log(`machine ${id} (${size}) created for ${repo}${snap ? " from its snapshot" : ""}`);
        this.save();
        this.launch(`bringup:${id}`, () => this.bringUp(id));
      } catch (e) {
        delete this.state.machines[pendingId];
        // Lizard made no machine, so this is not a create for the breaker; recordLizardError pauses creates.
        this.state.creates = this.state.creates?.filter((r) => r !== record);
        if (snap && !(e instanceof LizardLimitError) && !(e instanceof LizardPaymentError)) {
          // The snapshot may be gone or broken: forget it, so the next machine starts the long way.
          delete this.state.snapshots?.[snapKey(repo, size)];
          this.deps.log(`snapshot ${snap.id} of ${repo} could not be used and is dropped: ${(e as Error).message}`);
        } else {
          this.recordLizardError(e as Error);
        }
        this.save();
      } finally {
        this.createsInFlight--;
        this.createsDone++;
      }
    });
  }

  private recordLizardError(e: Error): void {
    const now = this.deps.now();
    const err = e as Error & { code?: string; url?: string };
    let pauseMs = MINUTE;
    if (e instanceof LizardLimitError) pauseMs = (e.retryAfterS ?? 60) * 1000;
    if (e instanceof LizardPaymentError) pauseMs = 10 * MINUTE;
    this.state.createsPausedUntil = now + pauseMs;
    this.state.lastLizardError = { at: now, message: e.message, ...(err.code ? { code: err.code } : {}), ...(err.url ? { url: err.url } : {}) };
    this.deps.log(`Lizard create failed, creates paused for ${Math.round(pauseMs / 1000)} s: ${e.message}`);
  }

  private antigravityConfig() {
    return this.deps.antigravityToken
      ? {
          token: this.deps.antigravityToken,
          defaultModel: this.deps.config.defaultModel ?? DEFAULT_ANTIGRAVITY_MODEL,
          makeDefault: (this.deps.config.defaultProvider ?? "antigravity") === "antigravity",
        }
      : undefined;
  }

  /** Why a snapshot needs rebuilding, or nothing: the repo's setup changed, T3 moved on, or it is old. */
  private snapshotStale(s: SnapshotRecord, now: number): { stale?: string } {
    if ((this.repoSetup(s.repo)?.hash ?? "") !== s.setupHash) return { stale: "the repo's setup script changed" };
    if (this.t3Version && s.t3Version !== this.t3Version) return { stale: "T3 Code has a newer version" };
    if (now - s.builtAt > SNAPSHOT_MAX_AGE_MS) return { stale: "older than 14 days" };
    return {};
  }

  /**
   * Builds a snapshot of a prepared machine for `repo` at `size` and starts it in the background: a
   * normal machine installs the tools and the repo's setup, but never gets a login or runs T3; the
   * secrets file is removed (and the build refuses if a secret is found anywhere else) before the
   * snapshot is saved, then the builder is killed. Machines for that repo and size then start from it.
   */
  async bake(req: { repo: string; size?: Size }): Promise<{ baking: string; size: Size }> {
    const { config } = this.deps;
    const repo = await this.setupRepo(req.repo);
    const size = req.size ?? config.defaultSize;
    if (!config.sizes.some((s) => s.size === size)) throw new ApiError(400, `size ${size} is not on the ladder (${config.sizes.map((s) => s.size).join(", ")})`);
    if (this.baking) throw new ApiError(409, `already building ${this.baking}`);
    const block = createBlock(this.state, this.deps.now(), config);
    if (block) throw new ApiError(409, block);
    const used = sizesInUse(Object.values(this.state.machines));
    if (vcpuFree(config, used) < SIZE_VCPU[size]) throw new ApiError(409, `no room for a ${size} machine right now`);
    const key = snapKey(repo, size);
    this.baking = key;
    this.lastBakeTry.set(key, this.deps.now());
    this.launch(`bake:${key}`, () => this.runBake(repo, size).finally(() => void (this.baking = undefined)));
    return { baking: repo, size };
  }

  private async runBake(repo: RepoKey, size: Size): Promise<void> {
    const { config } = this.deps;
    const key = snapKey(repo, size);
    const startedAt = this.deps.now();
    let id: MachineId | undefined;
    try {
      this.t3Version ??= await this.deps.t3.version();
      const setup = this.repoSetup(repo);
      const created = await this.deps.lizard.create(repo, size, BAKE_LIFETIME_MINUTES * MINUTE);
      id = created.id;
      this.state.machines[id] = { id, repo, size, createdAt: startedAt, deadline: created.deadline, phase: { kind: "baking" } };
      const day = utcDay(startedAt);
      this.state.usage[day] = (this.state.usage[day] ?? 0) + config.createChargeMinutes * 60 * SIZE_WEIGHT[size];
      this.deps.log(`machine ${id} (${size}) created to build the snapshot of ${repo}`);
      this.save();
      await install(this.remote, id, this.deps.machineEnv, this.t3Version, [], { label: `${machineLabel(repo, id, size)} (snapshot build)`, size }, this.antigravityConfig(), { bake: true });
      const workspacePath = await cloneRepo(this.remote, id, repo);
      if (setup?.script) await runRepoSetup(this.remote, id, workspacePath, setup.script, config.setupTimeoutMinutes * MINUTE, (log) => this.logSetupOutput(id!, log));
      await scrubForSnapshot(this.remote, id);
      const snapshotId = await this.deps.lizard.snapshot(id, `t3lizard-${repo.split("/").pop()}-${size}-${new Date(this.deps.now()).toISOString().slice(0, 10)}`);
      const old = this.state.snapshots?.[key];
      (this.state.snapshots ??= {})[key] = { id: snapshotId, repo, size, setupHash: setup?.hash ?? "", t3Version: this.t3Version, builtAt: this.deps.now() };
      this.state.lastBake = { at: this.deps.now(), repo, size, ok: true };
      this.save();
      this.deps.log(`snapshot ${snapshotId} of ${repo} (${size}) built in ${Math.round((this.deps.now() - startedAt) / 1000)} s`);
      if (old && old.id !== snapshotId) {
        await this.deps.lizard.deleteSnapshot(old.id).catch((e) => this.deps.log(`old snapshot ${old.id} was not deleted: ${(e as Error).message}`));
      }
      await this.pruneSnapshots(repo);
    } catch (e) {
      const message = (e as Error).message.slice(0, 600);
      this.state.lastBake = { at: this.deps.now(), repo, size, ok: false, message };
      this.deps.log(`snapshot build of ${repo} (${size}) failed, no snapshot changed: ${message}`);
      if (e instanceof LizardLimitError || e instanceof LizardPaymentError) this.recordLizardError(e);
      this.save();
    } finally {
      if (id && this.state.machines[id]) this.beginClose(id, "manual");
    }
  }

  /** The size the pool will hand this repo next: its learned size, else the default, on its ladder. */
  private wantedSize(repo: RepoKey): Size | undefined {
    return repoLadder(this.state, this.deps.config, repo)[0]?.size;
  }

  /**
   * Keeps what storage is paid for useful: a repo's snapshot of the size it gets now, and one size up
   * (where a job that ran out of memory goes next). Others are deleted, as Lizard bills them by the day.
   */
  private async pruneSnapshots(repo: RepoKey): Promise<void> {
    const want = this.wantedSize(repo);
    if (!want || !this.state.snapshots?.[snapKey(repo, want)]) return;
    const up = nextSizeUp(this.deps.config, want);
    for (const [key, s] of Object.entries(this.state.snapshots)) {
      if (s.repo !== repo || s.size === want || s.size === up) continue;
      delete this.state.snapshots[key];
      this.save();
      await this.deps.lizard.deleteSnapshot(s.id).then(
        () => this.deps.log(`snapshot ${s.id} of ${repo} (${s.size}) deleted: the repo gets ${want} now`),
        (e) => this.deps.log(`snapshot ${s.id} was not deleted: ${(e as Error).message}`),
      );
    }
  }

  /**
   * For each repo that has a snapshot: builds the one for the size it gets now when that is missing
   * (its learned size changed), and rebuilds a stale one. Only when nobody waits for a machine of the
   * repo and there is room, one build at a time, and not more often than every BAKE_RETRY_MS.
   */
  private maintainSnapshots(): void {
    if (this.baking || !this.state.snapshots) return;
    const now = this.deps.now();
    const { config } = this.deps;
    if (createBlock(this.state, now, config)) return;
    const wanted: { repo: RepoKey; size: Size; why: "missing" | "stale" }[] = [];
    for (const repo of new Set(Object.values(this.state.snapshots).map((s) => s.repo))) {
      const size = this.wantedSize(repo);
      const have = size && this.state.snapshots[snapKey(repo, size)];
      if (size && !have) wanted.push({ repo, size, why: "missing" });
      else if (size && have && this.snapshotStale(have, now).stale) wanted.push({ repo, size, why: "stale" });
    }
    for (const w of wanted.sort((a, b) => (a.why === "missing" ? -1 : 1) - (b.why === "missing" ? -1 : 1))) {
      const key = snapKey(w.repo, w.size);
      if (now - (this.lastBakeTry.get(key) ?? 0) < BAKE_RETRY_MS) continue;
      if (this.state.tickets.some((t) => t.status === "queued" && t.repo === w.repo)) continue;
      if (vcpuFree(config, sizesInUse(Object.values(this.state.machines))) < SIZE_VCPU[w.size]) continue;
      this.lastBakeTry.set(key, now);
      this.deps.log(`building the ${w.size} snapshot of ${w.repo}: ${w.why === "missing" ? "the repo gets this size now" : "the old one is stale"}`);
      this.bake({ repo: w.repo, size: w.size }).catch((e) => this.deps.log(`snapshot build of ${w.repo} did not start: ${(e as Error).message}`));
      return;
    }
  }

  /** Bring-up steps 1-6. Idempotent, so a daemon restart simply runs it again. */
  private async bringUp(id: MachineId): Promise<void> {
    const at = (kind: MachinePhase["kind"]) => {
      const m = this.state.machines[id];
      if (m?.phase.kind !== kind) throw new Superseded();
      return m;
    };
    let linkedNow: string | undefined;
    try {
      let m = this.state.machines[id];
      if (m?.phase.kind === "installing") {
        this.t3Version ??= await this.deps.t3.version();
        const accounts = this.accounts();
        const antigravity = this.antigravityConfig();
        await install(
          this.remote,
          id,
          this.deps.machineEnv,
          this.t3Version,
          accounts,
          { label: machineLabel(m.repo, id, m.size), size: m.size },
          antigravity,
        );
        const installed = at("installing");
        installed.accounts = accounts.map((a) => a.id);
        installed.accountsKey = this.accountsKey();
        if (antigravity) installed.antigravity = true;
        this.setPhase(installed, { kind: "linking" });
      }
      m = at("linking");
      if (!m.workspacePath || !m.projectId) {
        const project = await setupProject(this.remote, id, m.repo);
        m = at("linking");
        Object.assign(m, project);
        this.save();
      }
      const setup = this.repoSetup(m.repo);
      if (setup?.script && m.setupHash !== setup.hash) {
        this.deps.log(`machine ${id}: running the ${m.repo} setup (${setup.steps.length} step(s), ${setup.path})`);
        await runRepoSetup(this.remote, id, m.workspacePath!, setup.script, this.deps.config.setupTimeoutMinutes * MINUTE, (log) => this.logSetupOutput(id, log));
        m = at("linking");
        m.setupHash = setup.hash;
        this.deps.log(`machine ${id}: ${m.repo} setup done`);
        this.save();
      }
      if (this.deps.config.linkEnvironment === false) {
        // exec-only: pool_exec goes through Lizard's exec API, so no proxy and no link are needed.
        m.environmentId ??= NO_LINK;
      } else {
        if (!m.hostname || !m.accessToken) {
          // Lizard exposes the front proxy, never T3 itself: see src/machine/front.mjs.
          const { hostname, accessToken } = await this.deps.lizard.exposePort(id, FRONT_PORT);
          m = at("linking");
          Object.assign(m, { hostname, accessToken });
          this.save();
        }
        if (!this.proxies.has(id)) {
          await this.openProxy(m);
          m = at("linking");
        }
        if (m.frontHost !== `127.0.0.1:${m.proxyPort}`) {
          const host = await configureFront(this.remote, id, m.proxyPort!);
          m = at("linking");
          m.frontHost = host;
          this.save();
        }
        if (!m.environmentId) {
          linkedNow = await pairAndLink(this.remote, this.deps.t3, id, m.proxyPort!);
          m = at("linking");
          m.environmentId = linkedNow;
        }
      }
      this.settleCreate(id, "ready");
      this.setPhase(m, { kind: "idle", since: this.deps.now() });
      this.deps.log(`machine ${id} ready: environment ${m.environmentId}, project ${m.projectId}`);
      this.step();
    } catch (e) {
      if (e instanceof Superseded) {
        await this.closeProxy(id);
        if (linkedNow) await this.deps.t3.unlink(linkedNow).catch(() => {});
        return;
      }
      const m = this.state.machines[id];
      if (m && (m.phase.kind === "installing" || m.phase.kind === "linking")) {
        this.deps.log(`machine ${id} bring-up failed: ${(e as Error).message}`);
        if (linkedNow) m.environmentId = linkedNow;
        // A bring-up that fails once will likely fail again: the breaker stops a new machine every tick.
        this.settleCreate(id, "lost", `bring-up of ${id} failed: ${(e as Error).message}`);
        this.setPhase(m, { kind: "failed", error: (e as Error).message });
        this.step();
      }
    }
  }

  private async grant(ticketId: string, machineId: MachineId): Promise<void> {
    const reserved = () => {
      const m = this.state.machines[machineId];
      return m?.phase.kind === "resetting" && m.phase.ticketId === ticketId ? m : undefined;
    };
    const t = this.ticket(ticketId);
    // A file the last holder put there must never reach the next one: no clean, no grant.
    // The machine fails and closes; the ticket stays queued for another machine.
    try {
      await this.cleanPuts(machineId);
    } catch (e) {
      const m = reserved();
      if (!m) return;
      this.setPhase(m, { kind: "failed", error: `removing put files failed: ${(e as Error).message}` });
      this.step();
      return;
    }
    let result: Awaited<ReturnType<typeof resetCheckout>>;
    try {
      result = await resetCheckout(this.remote, machineId, this.state.machines[machineId].workspacePath!, t.ref);
    } catch (e) {
      const m = reserved();
      if (!m) return;
      this.setPhase(m, { kind: "failed", error: `reset failed: ${(e as Error).message}` });
      this.endTicket(this.ticket(ticketId), "cancelled", `machine failed while preparing ${t.ref}: ${(e as Error).message}`);
      this.step();
      return;
    }
    const m = reserved();
    if (!m) return;
    const now = this.deps.now();
    const current = this.ticket(ticketId);
    if (current.status !== "queued" || !result.ok) {
      if (!result.ok && current.status === "queued") this.endTicket(current, "cancelled", result.badRef);
      this.setPhase(m, { kind: "idle", since: now });
      this.step();
      return;
    }
    const lease: Lease = {
      id: randomUUID(),
      machineId,
      repo: m.repo,
      ref: current.ref,
      holder: current.holder,
      grantedAt: now,
      expiresAt: now + this.deps.config.leaseMinutes * MINUTE,
      waitedMs: Math.max(0, now - current.enqueuedAt),
    };
    this.launch(`peak-reset:${lease.id}`, () => this.resetPeak(machineId, lease.id));
    this.state.leases[lease.id] = lease;
    this.replaceTicket({ ...current, status: "granted", leaseId: lease.id });
    this.setPhase(m, { kind: "leased", leaseId: lease.id });
    this.deps.log(`lease ${lease.id}: machine ${machineId} (${m.size}) to ${current.holder} at ${current.ref}`);
  }

  private async extend(id: MachineId, deadline: number): Promise<void> {
    try {
      await this.deps.lizard.setTimeout(id, deadline - this.deps.now());
      const m = this.state.machines[id];
      if (m) m.deadline = deadline;
      this.save();
    } catch (e) {
      this.deps.log(`extend ${id} failed: ${(e as Error).message}`);
    }
  }

  private async expireLease(leaseId: string): Promise<void> {
    const lease = this.state.leases[leaseId];
    const m = lease && this.state.machines[lease.machineId];
    if (!lease) return;
    const busy = m?.workspacePath ? await busyThreads(this.remote, m.id, m.workspacePath).catch(() => 0) : 0;
    if (!this.state.leases[leaseId]) return;
    if (busy > 0) {
      lease.expiresAt = this.deps.now() + BUSY_LEASE_GRACE_MS;
      this.deps.log(`lease ${leaseId} past expiry but ${busy} thread(s) still busy; checking again in 10 minutes`);
      this.save();
      return;
    }
    this.endLease(leaseId, "expired");
    this.step();
  }

  private beginClose(id: MachineId, reason: CloseReason): void {
    const m = this.state.machines[id];
    if (!m || m.phase.kind === "closing") return;
    if (m.phase.kind === "leased") delete this.state.leases[m.phase.leaseId];
    if (BRINGING_UP.has(m.phase.kind)) this.settleCreate(id, "lost", `${id} closed (${reason}) before it became ready`);
    this.deps.log(`closing machine ${id} (${reason})`);
    this.setPhase(m, { kind: "closing" });
    this.launch(`close:${id}`, () => this.finishClose(id));
  }

  /** Stop the proxy, unlink locally, kill at Lizard, forget. Each part converges when re-run. */
  private async finishClose(id: MachineId): Promise<void> {
    await this.closeProxy(id);
    const m = this.state.machines[id];
    if (!m) return;
    if (m.environmentId === NO_LINK) m.environmentId = undefined;
    if (m.environmentId) {
      try {
        await this.deps.t3.unlink(m.environmentId);
        m.environmentId = undefined;
      } catch (e) {
        this.deps.log(`unlink ${m.environmentId} failed: ${(e as Error).message}`);
      }
    }
    try {
      await this.deps.lizard.kill(id);
    } catch (e) {
      this.setPhase(m, { kind: "failed", error: `kill failed: ${(e as Error).message}` });
      return;
    }
    this.accrueUsage();
    delete this.state.machines[id];
    this.deps.log(`machine ${id} closed`);
    this.step();
  }

  // ---- per-repo machine setup ----

  private repoSetup(repo: RepoKey): RepoSetup | undefined {
    try {
      return readSetup(this.deps.home, repo);
    } catch (e) {
      this.deps.log(`no setup for ${repo}: ${(e as Error).message}`);
      return undefined;
    }
  }

  private logSetupOutput(id: MachineId, log: string): void {
    for (const line of log.trimEnd().split("\n")) if (line) this.deps.log(`setup ${id}: ${line}`);
  }

  private async setupRepo(input: string): Promise<RepoKey> {
    return this.deps.resolveRepo(input).catch((e) => {
      throw new ApiError(400, `cannot resolve repo ${input}: ${(e as Error).message}`);
    });
  }

  private setupView(setup: RepoSetup) {
    return { repo: setup.repo, path: setup.path, steps: setup.steps.map(({ n, date, reason, line }) => ({ n, date, reason, line })) };
  }

  async setupAdd(req: { repo: string; line: string; reason: string; by?: string }) {
    const repo = await this.setupRepo(req.repo);
    try {
      const out = addStep(this.deps.home, repo, { line: req.line, reason: req.reason, by: req.by, now: this.deps.now() });
      this.deps.log(out.added ? `setup for ${repo}: step ${out.step.n} added${req.by ? ` by ${req.by}` : ""}: ${out.step.line}` : `setup for ${repo}: not added, ${out.note}`);
      return { added: out.added, ...(out.note ? { note: out.note } : {}), step: out.step.n, appliesTo: "machines created from now on", ...this.setupView(readSetup(this.deps.home, repo)) };
    } catch (e) {
      throw new ApiError(400, (e as Error).message);
    }
  }

  async setupShow(req: { repo: string }) {
    const repo = await this.setupRepo(req.repo);
    const setup = readSetup(this.deps.home, repo);
    return { ...this.setupView(setup), exists: setup.exists, script: setup.script ?? "", history: readHistory(this.deps.home, repo) };
  }

  async setupRemove(req: { repo: string; step: number; by?: string }) {
    const repo = await this.setupRepo(req.repo);
    try {
      const out = removeStep(this.deps.home, repo, { n: req.step, by: req.by, now: this.deps.now() });
      this.deps.log(`setup for ${repo}: step ${out.removed.n} removed${req.by ? ` by ${req.by}` : ""}: ${out.removed.line}`);
      return { removed: out.removed, ...this.setupView(readSetup(this.deps.home, repo)) };
    } catch (e) {
      throw new ApiError(400, (e as Error).message);
    }
  }

  // ---- Claude accounts ----

  /** Changes when an account is added, removed or given a new token. Not reversible to a token. */
  private accountsKey(): string {
    return createHash("sha256").update(JSON.stringify(this.accounts())).digest("hex").slice(0, 16);
  }

  private accounts(): Account[] {
    return this.deps.config.accounts.map((id) => ({ id, token: this.deps.accountTokens[id] }));
  }

  /** The account a new delegation should use: the first free one, else the one that frees first. */
  private accountFor(m: Machine): AccountId | undefined {
    const accounts = machineAccounts(m, this.deps.config);
    const until = (a: AccountId) => this.state.accounts?.[a]?.limitedUntil ?? 0;
    return nextFreeAccount(this.state, this.deps.now(), accounts) ?? [...accounts].sort((a, b) => until(a) - until(b))[0];
  }

  private waitView(m: Machine, now: number) {
    const wait = accountWait(this.state, m, now, this.deps.config);
    if (!wait) return {};
    return "until" in wait ? { waitingForAccountUntil: new Date(wait.until).toISOString() } : { cannotWaitForAccount: wait.blocked };
  }

  /** An account for a log line: its id, and its label when it has one. */
  private acct(id: AccountId): string {
    const label = this.deps.accountLabels?.[id];
    return label ? `${id} (${label})` : id;
  }

  /** What the last probe found, for status: verified is true only for a probe that said ok. */
  private probeView(id: AccountId, now: number) {
    const p = this.state.accounts?.[id]?.probe;
    if (!p) return { verified: false, probe: "not checked yet" };
    const ago = Math.round((now - p.at) / MINUTE);
    return { verified: p.kind === "ok", probe: `${p.kind}, ${ago} min ago${p.note && p.kind !== "ok" ? `: ${p.note}` : ""}` };
  }

  private probeDue(id: AccountId, now: number, poolBusy: boolean): boolean {
    if (this.probeNow.has(id)) return true;
    const a = this.state.accounts?.[id];
    const p = a?.probe;
    if (!p) return true;
    const since = now - p.at;
    const { accountDisabledMinutes } = this.deps.config;
    switch (p.kind) {
      case "ok":
        return poolBusy && since >= PROBE_OK_EVERY_MS;
      case "limit":
        // Once the block is over, confirm before handing the account out again; not before.
        return poolBusy && now >= (a?.limitedUntil ?? p.at) && since >= 5 * MINUTE;
      case "disabled":
        return since >= accountDisabledMinutes * MINUTE;
      case "auth":
        return since >= PROBE_AUTH_EVERY_MS;
      default:
        return since >= PROBE_ERROR_EVERY_MS;
    }
  }

  /**
   * Asks one due account, one at a time, what it can do, and keeps the answer in state: threads then
   * get only an account known to work, instead of finding out by failing. A probe costs about 0.01 cent.
   */
  private probeAccounts(): void {
    const probe = this.deps.probe;
    if (!probe || this.probing || !this.deps.config.accounts.length) return;
    const now = this.deps.now();
    const poolBusy = Object.values(this.state.machines).some((m) => m.phase.kind === "leased");
    const id = this.deps.config.accounts.find((a) => this.deps.accountTokens[a] && this.probeDue(a, now, poolBusy));
    if (!id) return;
    this.probing = true;
    this.launch(`probe:${id}`, async () => {
      try {
        const result = await probe(this.deps.accountTokens[id]);
        this.probeNow.delete(id);
        this.applyProbe(id, result);
      } catch (e) {
        this.deps.log(`probe of ${id} failed: ${(e as Error).message}`);
      } finally {
        this.probing = false;
      }
    });
  }

  private applyProbe(id: AccountId, r: ProbeResult): void {
    const now = this.deps.now();
    const { accountRetryMinutes, accountDisabledMinutes } = this.deps.config;
    const account = ((this.state.accounts ??= {})[id] ??= {});
    const before = account.probe?.kind;
    account.probe = { at: now, kind: r.kind, note: r.note };
    const block = (until: number, flags: { disabled?: boolean; auth?: boolean }) => {
      account.limitedUntil = until;
      if (flags.disabled) account.disabled = true;
      else delete account.disabled;
      if (flags.auth) account.auth = true;
      else delete account.auth;
      account.probeBlocked = true;
    };
    if (r.kind === "ok") {
      if (account.probeBlocked) {
        for (const k of ["limitedUntil", "disabled", "auth", "probeBlocked"] as const) delete account[k];
        this.deps.log(`${this.acct(id)} works again (a probe answered)`);
      }
    } else if (r.kind === "limit") {
      block(r.resetsAt ?? Math.max(account.limitedUntil ?? 0, now + accountRetryMinutes * MINUTE), {});
    } else if (r.kind === "disabled") {
      block(Math.max(account.limitedUntil ?? 0, now + accountDisabledMinutes * MINUTE), { disabled: true });
    } else if (r.kind === "auth") {
      block(Math.max(account.limitedUntil ?? 0, now + AUTH_BLOCK_MINUTES * MINUTE), { auth: true });
    }
    if (before !== r.kind) this.deps.log(`${this.acct(id)}: ${before ?? "unknown"} -> ${r.kind}${r.note ? ` (${r.note})` : ""}`);
    this.save();
  }

  /**
   * A running machine whose accounts differ from the secrets (an account was added or removed
   * after it came up) gets the current list, at most once a minute per machine.
   */
  private syncAccounts(): void {
    const want = this.deps.config.accounts;
    if (!want.length) return;
    const key = this.accountsKey();
    const now = this.deps.now();
    for (const m of Object.values(this.state.machines)) {
      if (m.phase.kind !== "leased" && m.phase.kind !== "idle") continue;
      if (m.accounts && m.accounts.join() === want.join() && m.accountsKey === key) continue;
      if (now - (this.lastAccountPush.get(m.id) ?? 0) < LIMIT_SCAN_EVERY_MS) continue;
      this.lastAccountPush.set(m.id, now);
      const id = m.id;
      this.launch(`accounts:${id}`, async () => {
        try {
          await pushAccounts(this.remote, id, this.accounts());
        } catch (e) {
          this.deps.log(`machine ${id}: giving it the current Claude accounts failed: ${(e as Error).message}`);
          return;
        }
        const cur = this.state.machines[id];
        if (!cur) return;
        cur.accounts = [...want];
        cur.accountsKey = key;
        this.save();
        this.deps.log(`machine ${id}: Claude accounts now ${want.join(", ")}`);
      });
    }
  }

  /** Each leased machine, at most once a minute: find threads stopped on a usage limit. */
  private scanForLimits(): void {
    if (!this.deps.config.accounts.length) return;
    const now = this.deps.now();
    for (const m of Object.values(this.state.machines)) {
      if (m.phase.kind !== "leased") {
        this.lastLimitScan.delete(m.id);
        continue;
      }
      if (now - (this.lastLimitScan.get(m.id) ?? 0) < LIMIT_SCAN_EVERY_MS) continue;
      this.lastLimitScan.set(m.id, now);
      const lease = this.state.leases[m.phase.leaseId];
      if (lease) this.launch(`scan:${m.id}`, () => this.scanMachine(m.id, lease));
    }
  }

  /**
   * Records the threads that hit a usage limit, and marks each newly limited account as limited
   * for accountRetryMinutes. plan() then continues them on the next free account.
   */
  private async scanMachine(id: MachineId, lease: Lease): Promise<void> {
    let found: Awaited<ReturnType<typeof scanLimits>>;
    try {
      found = await scanLimits(this.remote, id);
    } catch (e) {
      this.deps.log(`limit scan of ${id} failed: ${(e as Error).message}`);
      const gone = this.state.machines[id];
      if (gone && /timeout|timed out|aborted/i.test((e as Error).message)) this.noAnswer(gone, lease);
      return;
    }
    const m = this.state.machines[id];
    if (m?.unresponsiveSince) {
      this.deps.log(`machine ${id} answers again`);
      delete m.unresponsiveSince;
      this.save();
    }
    if (m?.phase.kind !== "leased" || m.phase.leaseId !== lease.id) return;
    const { accounts, accountRetryMinutes, accountDisabledMinutes } = this.deps.config;
    const now = this.deps.now();
    const known = new Set((m.limitedThreads ?? []).map((t) => t.runId));
    const continued = new Set(m.continuedRuns ?? []);
    // Threads of an earlier lease on this machine are not this holder's: leave them alone.
    const ours = (t: (typeof found)[number]) => Date.parse(t.requestedAt) >= lease.grantedAt - CLOCK_SKEW_MS;
    const limited = found.filter((t) => accounts.includes(t.account) && !continued.has(t.runId) && ours(t));
    for (const t of limited) {
      if (known.has(t.runId)) continue;
      const account = ((this.state.accounts ??= {})[t.account] ??= {});
      const minutes = t.auth ? AUTH_BLOCK_MINUTES : t.disabled ? accountDisabledMinutes : accountRetryMinutes;
      const until = now + minutes * MINUTE;
      // The longer block decides what the account is shown as: a plain usage limit after an old
      // "disabled" must not keep the flag, but a disabled notice inside a usage-limit window sets it.
      if (until >= (account.limitedUntil ?? 0)) {
        account.limitedUntil = until;
        if (t.disabled) account.disabled = true;
        else delete account.disabled;
        if (t.auth) account.auth = true;
        else delete account.auth;
        // An auth failure is often just this machine's stale copy of the login: ask the account
        // now (a probe that says ok lifts the block), and give the machine the current logins.
        if (t.auth) {
          account.probeBlocked = true;
          this.probeNow.add(t.account);
          delete m.accountsKey;
        }
      }
      this.deps.log(`thread ${t.threadId} on ${id} stopped on ${t.auth ? "a login failure" : t.disabled ? "disabled access" : "the usage limit"} of ${this.acct(t.account)} ("${t.notice}"); ${t.account} skipped until ${new Date(account.limitedUntil).toISOString()}`);
    }
    m.limitedThreads = limited.map(({ threadId, runId, account }) => ({ threadId, runId, account }));
    if (!m.limitedThreads.length) delete m.limitedThreads;
    this.step();
  }

  private async continueThread(a: Extract<Action, { kind: "continueThread" }>): Promise<void> {
    const key = `continue:${a.machineId}:${a.threadId}`;
    let out: { skipped?: string };
    try {
      out = await continueOnAccount(this.remote, a.machineId, a);
    } catch (e) {
      this.continueRetryAt.set(key, this.deps.now() + MINUTE);
      this.deps.log(`continuing thread ${a.threadId} on ${a.machineId} with ${a.account} failed: ${(e as Error).message}`);
      return;
    }
    this.continueRetryAt.delete(key);
    const m = this.state.machines[a.machineId];
    if (!m) return;
    m.continuedRuns = [...(m.continuedRuns ?? []), a.runId].slice(-50);
    m.limitedThreads = m.limitedThreads?.filter((t) => t.runId !== a.runId);
    if (!m.limitedThreads?.length) delete m.limitedThreads;
    this.deps.log(out.skipped ? `thread ${a.threadId} on ${a.machineId} not continued: ${out.skipped}` : `thread ${a.threadId} on ${a.machineId} continues on ${a.account}`);
    this.save();
  }

  // ---- reconcile with Lizard ----

  private async reconcile(): Promise<void> {
    if (this.createsInFlight > 0) return;
    const before = this.createsDone;
    let live: Set<MachineId>;
    try {
      live = new Set(await this.deps.lizard.list());
    } catch (e) {
      this.deps.log(`Lizard list failed: ${(e as Error).message}`);
      return;
    }
    if (this.createsInFlight > 0 || this.createsDone !== before) return;
    for (const id of live) {
      if (this.state.machines[id] || this.running.has(`orphan:${id}`) || this.orphansKilled.has(id)) continue;
      this.deps.log(`killing orphan sandbox ${id}`);
      this.launch(`orphan:${id}`, async () => {
        try {
          await this.deps.lizard.kill(id);
          this.orphansKilled.add(id);
        } catch (e) {
          this.deps.log(`orphan kill ${id} failed: ${(e as Error).message}`);
        }
      });
    }
    for (const m of Object.values(this.state.machines)) {
      if (live.has(m.id) || m.phase.kind === "closing" || m.id.startsWith(PENDING)) continue;
      // A listing can lag or miss a sandbox. Drop a machine only when Lizard confirms it is gone.
      let alive: boolean;
      try {
        alive = await this.deps.lizard.alive(m.id);
      } catch (e) {
        this.deps.log(`cannot tell whether ${m.id} is alive, keeping it: ${(e as Error).message}`);
        continue;
      }
      const current = this.state.machines[m.id];
      if (alive || !current || current.phase.kind === "closing") continue;
      this.deps.log(`machine ${m.id} is gone at Lizard; dropping it`);
      if (BRINGING_UP.has(current.phase.kind)) this.settleCreate(m.id, "lost", `${m.id} vanished at Lizard during bring-up (${current.phase.kind})`);
      if (current.phase.kind === "leased") delete this.state.leases[current.phase.leaseId];
      this.setPhase(current, { kind: "closing" });
      this.launch(`close:${m.id}`, () => this.finishClose(m.id));
    }
  }

  // ---- helpers ----

  private launch(key: string, fn: () => Promise<void>): void {
    if (this.running.has(key)) return;
    const p = fn()
      .catch((e) => this.deps.log(`${key}: ${(e as Error).stack ?? e}`))
      .finally(() => {
        this.running.delete(key);
        this.save();
      });
    this.running.set(key, p);
  }

  private isResetting(ticketId: string): boolean {
    return Object.values(this.state.machines).some((m) => m.phase.kind === "resetting" && m.phase.ticketId === ticketId);
  }

  private async waitUntil(ticketId: string, maxSeconds: number, done: (v: TicketView) => boolean): Promise<TicketView> {
    const until = Date.now() + maxSeconds * 1000;
    for (;;) {
      const v = this.view(ticketId);
      const left = until - Date.now();
      if (done(v) || left <= 0) return v;
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          this.changes.off("change", finish);
          resolve();
        };
        const timer = setTimeout(finish, left);
        this.changes.on("change", finish);
      });
    }
  }

  private ticket(id: string): Ticket {
    const t = this.state.tickets.find((x) => x.id === id);
    if (!t) throw new ApiError(404, `no ticket ${id}`);
    return t;
  }

  private replaceTicket(t: Ticket): void {
    this.state.tickets = this.state.tickets.map((x) => (x.id === t.id ? t : x));
  }

  private endTicket(t: Ticket, status: "cancelled" | "expired", error: string): void {
    const { id, repo, ref, holder, enqueuedAt } = t;
    this.replaceTicket({ id, repo, ref, holder, enqueuedAt, status, endedAt: this.deps.now(), error });
    this.deps.log(`ticket ${id} ${status}: ${error}`);
  }

  private endLease(leaseId: string, how: "released" | "expired"): void {
    const lease = this.state.leases[leaseId];
    delete this.state.leases[leaseId];
    if (lease) {
      const size = this.state.machines[lease.machineId]?.size;
      if (size) this.launch(`job:${leaseId}`, () => this.finishJob(lease, size));
    }
    const m = this.state.machines[lease.machineId];
    if (m) {
      delete m.limitedThreads;
      delete m.continuedRuns;
      if (m.putFiles?.length) {
        this.launch(`put-clean:${m.id}`, () => this.cleanPuts(m.id).catch((e) => this.deps.log(`removing put files on ${m.id} failed; the next grant tries again: ${(e as Error).message}`)));
      }
    }
    if (m?.phase.kind === "leased" && m.phase.leaseId === leaseId) this.setPhase(m, { kind: "idle", since: this.deps.now() });
    this.deps.log(`lease ${leaseId} ${how}`);
  }

  /** Marks a create as having become ready, or lost before that (which feeds the breaker). Once only. */
  private settleCreate(id: MachineId, outcome: "ready" | "lost", reason?: string): void {
    const r = this.state.creates?.find((x) => x.machineId === id && x.outcome === "pending");
    if (!r) return;
    const now = this.deps.now();
    Object.assign(r, { outcome, settledAt: now }, reason ? { reason } : {});
    if (outcome !== "lost") return;
    const b = createBackoff(this.state, now);
    const pause = b ? `creates back off ${Math.round((b.until - now) / MINUTE)} min (${b.failures} in a row)` : "no backoff";
    this.deps.log(`machine ${id} for ${r.repo} never became ready: ${reason}; ${pause}`);
  }

  private setPhase(m: Machine, phase: MachinePhase): void {
    m.phase = phase;
    this.save();
  }

  private async openProxy(m: Machine): Promise<void> {
    const [lo, hi] = this.deps.config.proxyPortRange;
    const taken = new Set(Object.values(this.state.machines).filter((x) => x.id !== m.id).map((x) => x.proxyPort));
    const candidates = m.proxyPort ? [m.proxyPort] : Array.from({ length: hi - lo + 1 }, (_, i) => lo + i).filter((p) => !taken.has(p));
    for (const port of candidates) {
      try {
        const proxy = await startProxy({ port, upstream: new URL(`https://${m.hostname}`), accessToken: m.accessToken!, extraHosts: this.deps.config.publicBind });
        this.proxies.set(m.id, proxy);
        m.proxyPort = port;
        this.save();
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
      }
    }
    throw new Error(`no free proxy port in ${lo}-${hi}`);
  }

  /**
   * A linked machine whose proxy did not reopen at start (its port was busy) gets another try each
   * tick, on the same port: the devbox T3 link and the machine's front Host both name that port.
   */
  private reopenProxies(): void {
    for (const m of Object.values(this.state.machines)) {
      if (this.proxies.has(m.id) || !m.environmentId || !m.proxyPort || !m.hostname || !m.accessToken) continue;
      // Bring-up opens its own proxy; only machines past it are retried here.
      if (!["idle", "resetting", "leased"].includes(m.phase.kind)) continue;
      this.launch(`proxy:${m.id}`, () => this.openProxy(m).catch((e) => this.deps.log(`proxy for ${m.id} on port ${m.proxyPort} did not reopen: ${e.message}`)));
    }
  }

  private async closeProxy(id: MachineId): Promise<void> {
    const proxy = this.proxies.get(id);
    this.proxies.delete(id);
    await proxy?.close();
  }

  private accrueUsage(): void {
    const now = this.deps.now();
    const since = this.state.usageAccruedAt ?? now;
    const charged = this.deps.config.createChargeMinutes * MINUTE;
    let ms = 0;
    for (const m of Object.values(this.state.machines)) {
      if (!m.id.startsWith(PENDING)) ms += Math.max(0, now - Math.max(since, m.createdAt + charged)) * SIZE_WEIGHT[m.size];
    }
    const day = utcDay(now);
    this.state.usage[day] = (this.state.usage[day] ?? 0) + ms / 1000;
    this.state.usageAccruedAt = now;
    for (const d of Object.keys(this.state.usage)) if (d < utcDay(now - 7 * 24 * 60 * MINUTE)) delete this.state.usage[d];
  }

  private pruneTickets(now: number): void {
    if (this.state.creates) this.state.creates = this.state.creates.filter((r) => r.outcome === "pending" || now - r.at < 24 * 60 * MINUTE);
    this.state.tickets = this.state.tickets.filter((t) => {
      if (t.status === "queued") return true;
      if (t.status === "granted") return !!this.state.leases[t.leaseId] || now - t.enqueuedAt < 24 * 60 * MINUTE;
      return now - t.endedAt < 60 * MINUTE;
    });
  }

  private save(): void {
    const tmp = `${this.files.state}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.files.state);
    this.changes.emit("change");
  }
}

/**
 * A path under the sandbox user's home, as a path relative to it: "~/a/b", "/home/<user>/a/b" and
 * "a/b" all give "a/b". Anything else, or a "." or ".." part, is refused.
 */
export function homeRelative(path: string, user: string): string {
  if (/[\0\n\r]/.test(path)) throw new ApiError(400, "the path has a control character");
  let rel = path;
  if (rel.startsWith("~/")) rel = rel.slice(2);
  else if (rel.startsWith(`/home/${user}/`)) rel = rel.slice(`/home/${user}/`.length);
  else if (rel.startsWith("/") || rel.startsWith("~")) throw new ApiError(400, `the path must be under the home folder (~/ or /home/${user}/)`);
  const parts = rel.split("/").filter((p) => p !== "");
  if (!parts.length || parts.some((p) => p === "." || p === "..")) throw new ApiError(400, "the path must name a file under the home folder, with no . or .. parts");
  return parts.join("/");
}
