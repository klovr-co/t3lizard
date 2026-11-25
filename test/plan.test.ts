import { test } from "node:test";
import assert from "node:assert/strict";
import { accountWait, CREATE_BACKOFF_MINUTES, nextFreeAccount, plan, queueInfo } from "../src/plan.ts";
import type { Config, CreateRecord, Lease, Machine, MachinePhase, State, Ticket } from "../src/types.ts";

const MIN = 60_000;
const NOW = Date.parse("2026-11-19T12:00:00Z");

const config: Config = {
  project: "p",
  template: "claude",
  sizes: [{ size: "small", max: 4 }],
  perRepoCap: 4,
  idleCloseMinutes: 10,
  recycleMinutes: 240,
  lifetimeMinutes: 60,
  maxLifetimeMinutes: 180,
  leaseMinutes: 90,
  ticketMaxWaitMinutes: 60,
  dailySmallMachineHours: 20,
  createsPerRepoPerHour: 3,
  createChargeMinutes: 10,
  proxyPortRange: [47300, 47399],
  forwardEnv: [],
  sandboxUser: "user",
  tickSeconds: 15,
  accountRetryMinutes: 30,
  accounts: ["claudeAgent_acct1", "claudeAgent_acct2", "claudeAgent_acct3"],
};

function machine(id: string, repo: string, phase: MachinePhase, opts: Partial<Machine> = {}): Machine {
  return { id, repo, size: "small", createdAt: NOW - 20 * MIN, deadline: NOW + 40 * MIN, phase, ...opts };
}

function queued(id: string, repo: string, minutesAgo = 1): Ticket {
  return { id, repo, ref: "main", holder: "h", enqueuedAt: NOW - minutesAgo * MIN, status: "queued" };
}

function state(machines: Machine[], tickets: Ticket[] = [], extra: Partial<State> = {}): State {
  return {
    machines: Object.fromEntries(machines.map((m) => [m.id, m])),
    leases: {},
    tickets,
    usage: {},
    ...extra,
  };
}

const idle = (minutes: number): MachinePhase => ({ kind: "idle", since: NOW - minutes * MIN });

test("grants the oldest queued ticket of the repo to an idle machine", () => {
  const s = state([machine("m1", "a", idle(1))], [queued("t-old", "a", 5), queued("t-new", "a", 2)]);
  const actions = plan(s, NOW, config);
  assert.deepEqual(actions.filter((a) => a.kind === "grant"), [{ kind: "grant", ticketId: "t-old", machineId: "m1" }]);
});

test("never grants a machine of another repo", () => {
  const s = state([machine("m1", "b", idle(1))], [queued("t1", "a")], {});
  const actions = plan(s, NOW, { ...config, sizes: [{ size: "small", max: 2 }] });
  assert.equal(actions.some((a) => a.kind === "grant"), false);
  assert.deepEqual(actions.filter((a) => a.kind === "create"), [{ kind: "create", repo: "a", size: "small" }]);
});

test("creates one machine per unmet ticket, up to the per-repo cap", () => {
  const s = state([], [queued("t1", "a"), queued("t2", "a"), queued("t3", "a")]);
  const actions = plan(s, NOW, { ...config, perRepoCap: 2 });
  assert.equal(actions.filter((a) => a.kind === "create").length, 2);
});

test("counts machines still coming up as capacity already on the way", () => {
  const s = state(
    [machine("m1", "a", { kind: "creating" }), machine("m2", "a", { kind: "installing" }), machine("m3", "a", { kind: "linking" })],
    [queued("t1", "a"), queued("t2", "a"), queued("t3", "a"), queued("t4", "a")],
  );
  assert.deepEqual(plan(s, NOW, config).filter((a) => a.kind === "create"), [{ kind: "create", repo: "a", size: "small" }]);
  const again = state(Object.values(s.machines), s.tickets.slice(0, 3));
  assert.deepEqual(plan(again, NOW, config), []);
});

test("does not create past the total cap across repos", () => {
  const leased = (id: string) => machine(id, "b", { kind: "leased", leaseId: `l-${id}` });
  const s = state([leased("b1"), leased("b2"), leased("b3")], [queued("t1", "a"), queued("t2", "a")]);
  assert.deepEqual(plan(s, NOW, config).filter((a) => a.kind === "create"), [{ kind: "create", repo: "a", size: "small" }]);
});

test("creates nothing once today's machine-hours reach the daily budget", () => {
  const s = state([], [queued("t1", "a")], { usage: { "2026-11-19": 20 * 3600 } });
  assert.deepEqual(plan(s, NOW, config), []);
  assert.match(queueInfo(s, "t1", NOW, config).reason ?? "", /daily budget/);
  const yesterday = state([], [queued("t1", "a")], { usage: { "2026-11-18": 20 * 3600 } });
  assert.equal(plan(yesterday, NOW, config).filter((a) => a.kind === "create").length, 1);
});

test("creates nothing while Lizard has paused creates", () => {
  const s = state([], [queued("t1", "a")], { createsPausedUntil: NOW + MIN });
  assert.deepEqual(plan(s, NOW, config), []);
  assert.equal(plan(s, NOW + MIN, config).filter((a) => a.kind === "create").length, 1);
});

test("closes an idle machine after idleCloseMinutes only when its repo has no queue", () => {
  assert.deepEqual(plan(state([machine("m1", "a", idle(10))]), NOW, config), [
    { kind: "close", machineId: "m1", reason: "idle" },
  ]);
  assert.deepEqual(plan(state([machine("m1", "a", idle(9))]), NOW, config), []);
  const withQueue = state([machine("m1", "a", idle(30))], [queued("t1", "a")]);
  assert.deepEqual(plan(withQueue, NOW, config), [{ kind: "grant", ticketId: "t1", machineId: "m1" }]);
});

test("keeps an idle machine while its repo still waits for more machines", () => {
  const s = state(
    [machine("m1", "a", idle(30)), machine("m2", "a", idle(30))],
    [queued("t1", "a"), queued("t2", "a"), queued("t3", "a")],
  );
  const actions = plan(s, NOW, config);
  assert.equal(actions.filter((a) => a.kind === "close").length, 0);
  assert.equal(actions.filter((a) => a.kind === "grant").length, 2);
  assert.equal(actions.filter((a) => a.kind === "create").length, 1);
});

test("closes an idle machine of a quiet repo when another repo is blocked by the total cap", () => {
  const trial = { ...config, sizes: [{ size: "small" as const, max: 1 }] };
  const s = state([machine("b1", "b", idle(1))], [queued("t1", "a")]);
  assert.deepEqual(plan(s, NOW, trial), [{ kind: "close", machineId: "b1", reason: "idle" }]);
  const freeing = state([machine("b1", "b", { kind: "closing" }), machine("b2", "b", idle(1))], [queued("t1", "a")]);
  assert.deepEqual(plan(freeing, NOW, { ...config, sizes: [{ size: "small", max: 2 }] }), []);
  assert.deepEqual(plan(state([], [queued("t1", "a")]), NOW, trial), [{ kind: "create", repo: "a", size: "small" }]);
});

test("recycles an idle machine older than recycleMinutes, queue or not", () => {
  const old = machine("m1", "a", idle(1), { createdAt: NOW - 240 * MIN, deadline: NOW + 60 * MIN });
  assert.deepEqual(plan(state([old]), NOW, config), [{ kind: "close", machineId: "m1", reason: "recycle" }]);
  const actions = plan(state([old], [queued("t1", "a")]), NOW, config);
  assert.deepEqual(actions, [
    { kind: "close", machineId: "m1", reason: "recycle" },
    { kind: "create", repo: "a", size: "small" },
  ]);
});

test("near the deadline an idle machine closes and a leased one is extended up to maxLifetime", () => {
  const near = { createdAt: NOW - 56 * MIN, deadline: NOW + 4 * MIN };
  assert.deepEqual(plan(state([machine("m1", "a", idle(1), near)]), NOW, config), [
    { kind: "close", machineId: "m1", reason: "deadline" },
  ]);
  const leased = machine("m2", "a", { kind: "leased", leaseId: "l" }, near);
  assert.deepEqual(plan(state([leased]), NOW, config), [{ kind: "extend", machineId: "m2", deadline: NOW + 64 * MIN }]);
  const capped = machine("m3", "a", { kind: "leased", leaseId: "l" }, { createdAt: NOW - 150 * MIN, deadline: NOW + 4 * MIN });
  assert.deepEqual(plan(state([capped]), NOW, config), [{ kind: "extend", machineId: "m3", deadline: NOW + 30 * MIN }]);
  const atMax = machine("m4", "a", { kind: "leased", leaseId: "l" }, { createdAt: NOW - 176 * MIN, deadline: NOW + 4 * MIN });
  assert.deepEqual(plan(state([atMax]), NOW, config), []);
});

test("does not grant a machine that is about to hit its deadline", () => {
  const s = state([machine("m1", "a", idle(1), { deadline: NOW + 2 * MIN })], [queued("t1", "a")]);
  const actions = plan(s, NOW, config);
  assert.equal(actions.some((a) => a.kind === "grant"), false);
  assert.deepEqual(actions[0], { kind: "close", machineId: "m1", reason: "deadline" });
});

test("expires a lease past expiresAt", () => {
  const s = state([machine("m1", "a", { kind: "leased", leaseId: "l1" })]);
  s.leases.l1 = { id: "l1", machineId: "m1", repo: "a", ref: "main", holder: "h", grantedAt: NOW - 91 * MIN, expiresAt: NOW - MIN };
  assert.deepEqual(plan(s, NOW, config), [{ kind: "expireLease", leaseId: "l1" }]);
  s.leases.l1.expiresAt = NOW + MIN;
  assert.deepEqual(plan(s, NOW, config), []);
});

test("expires a ticket queued longer than ticketMaxWaitMinutes and does not create for it", () => {
  const s = state([], [queued("t1", "a", 60)]);
  assert.deepEqual(plan(s, NOW, config), [{ kind: "expireTicket", ticketId: "t1" }]);
});

test("closes failed machines and leaves closing ones alone", () => {
  const s = state([machine("m1", "a", { kind: "failed", error: "x" }), machine("m2", "a", { kind: "closing" })]);
  assert.deepEqual(plan(s, NOW, config), [{ kind: "close", machineId: "m1", reason: "failed" }]);
});

test("a ticket whose machine is resetting is neither granted again nor counted as waiting", () => {
  const s = state([machine("m1", "a", { kind: "resetting", ticketId: "t1" }), machine("m2", "a", idle(1))], [queued("t1", "a")]);
  assert.deepEqual(plan(s, NOW, config), []);
  assert.deepEqual(queueInfo(s, "t1", NOW, config).position, 1);
});

// ---- create circuit breaker ----

const SEC = 1000;
const creates = (s: State) => plan(s, NOW, config).filter((a) => a.kind === "create");
const createsAt = (s: State, t: number) => plan(s, t, config).filter((a) => a.kind === "create");

function lost(machineId: string, settledAt: number, reason: string, repo = "a"): CreateRecord {
  return { machineId, repo, at: settledAt - 10 * SEC, outcome: "lost", settledAt, reason };
}

test("a machine dropped right after create backs creates off for 2 minutes, with the reason on the ticket", () => {
  // The live-test loop: the sandbox vanished 10 s after create, and the next tick created another.
  const s = state([], [queued("t1", "a")], { creates: [lost("sb-1", NOW, "sb-1 vanished at Lizard during bring-up (installing)")] });
  assert.deepEqual(creates(s), []);
  const reason = queueInfo(s, "t1", NOW, config).reason ?? "";
  assert.match(reason, /creates back off until 2026-11-19T12:02:00\.000Z: 1 machine\(s\) in a row never became ready; last: sb-1 vanished/);
  assert.deepEqual(createsAt(s, NOW + 2 * MIN - SEC), []);
  assert.deepEqual(createsAt(s, NOW + 2 * MIN), [{ kind: "create", repo: "a", size: "small" }]);
});

test("repeated bring-up failures back creates off 2, 5, then 15 minutes, across repos", () => {
  assert.deepEqual(CREATE_BACKOFF_MINUTES, [2, 5, 15]);
  const expected = [2, 5, 15, 15];
  for (let n = 1; n <= expected.length; n++) {
    const records = Array.from({ length: n }, (_, i) => lost(`sb-${i}`, NOW - (n - 1 - i) * 30 * SEC, "bring-up of sb failed: preflight failed (exit 1): no glibc", i % 2 ? "b" : "a"));
    const s = state([], [queued("t1", "c")], { creates: records });
    assert.deepEqual(createsAt(s, NOW + expected[n - 1] * MIN - SEC), [], `after ${n} failure(s)`);
    assert.deepEqual(createsAt(s, NOW + expected[n - 1] * MIN), [{ kind: "create", repo: "c", size: "small" }], `after ${n} failure(s)`);
  }
});

test("one machine that becomes ready resets the backoff", () => {
  const ready: CreateRecord = { machineId: "sb-3", repo: "a", at: NOW - 3 * MIN, outcome: "ready", settledAt: NOW - SEC };
  const s = state([], [queued("t1", "a")], { creates: [lost("sb-1", NOW - 20 * SEC, "x", "b"), lost("sb-2", NOW - 10 * SEC, "x", "b"), ready] });
  assert.deepEqual(creates(s), [{ kind: "create", repo: "a", size: "small" }]);
  const pending: CreateRecord = { machineId: "sb-4", repo: "a", at: NOW - 30 * SEC, outcome: "pending" };
  const stillLost = state([], [queued("t1", "a")], { creates: [lost("sb-1", NOW - 10 * SEC, "x"), pending] });
  assert.deepEqual(creates(stillLost), [], "a create still coming up does not reset it");
});

test("caps creates per repo per rolling hour, short-lived machines included", () => {
  const made = (id: string, minutesAgo: number, repo = "a"): CreateRecord => ({ machineId: id, repo, at: NOW - minutesAgo * MIN, outcome: "ready", settledAt: NOW - minutesAgo * MIN + MIN });
  const s = state([], [queued("t1", "a"), queued("t2", "b")], { creates: [made("sb-1", 50), made("sb-2", 40), made("sb-3", 30)] });
  assert.deepEqual(creates(s), [{ kind: "create", repo: "b", size: "small" }], "other repos are not blocked");
  assert.match(queueInfo(s, "t1", NOW, config).reason ?? "", /3 machines created for this repo in the last hour \(cap 3\); next create after 2026-11-19T12:10:00\.000Z/);
  assert.equal(queueInfo(s, "t2", NOW, config).reason, undefined);
  assert.deepEqual(createsAt(s, NOW + 10 * MIN).filter((a) => a.kind === "create" && a.repo === "a"), [{ kind: "create", repo: "a", size: "small" }]);

  const twoMade = state([], [queued("t1", "a"), queued("t2", "a"), queued("t3", "a")], { creates: [made("sb-1", 50), made("sb-2", 40)] });
  assert.deepEqual(creates(twoMade), [{ kind: "create", repo: "a", size: "small" }], "one tick never creates past the hourly cap");
});

const A1 = "claudeAgent_acct1";
const A2 = "claudeAgent_acct2";
const A3 = "claudeAgent_acct3";

/** A leased machine whose thread t1 failed on `account`'s usage limit. */
function limitedLease(account: string, opts: Partial<Machine> = {}, lease: Partial<Lease> = {}) {
  const m = machine("m1", "r", { kind: "leased", leaseId: "l1" }, { limitedThreads: [{ threadId: "t1", runId: "run1", account }], ...opts });
  const l: Lease = { id: "l1", machineId: "m1", repo: "r", ref: "main", holder: "h", grantedAt: NOW - 10 * MIN, expiresAt: NOW + 80 * MIN, ...lease };
  return { m, l };
}

const limited = (until: Record<string, number>) => Object.fromEntries(Object.entries(until).map(([a, t]) => [a, { limitedUntil: t }]));

test("next free account counts from the one after the limited account and wraps", () => {
  const s = state([], [], { accounts: limited({ [A2]: NOW + MIN }) });
  assert.equal(nextFreeAccount(s, NOW, config.accounts, A1), A3);
  assert.equal(nextFreeAccount(s, NOW, config.accounts, A3), A1);
  assert.equal(nextFreeAccount(s, NOW, config.accounts), A1);
  assert.equal(nextFreeAccount(s, NOW + MIN, config.accounts, A1), A2, "free again once limitedUntil passes");
});

test("a thread limited on one account continues on the next free account", () => {
  const { m, l } = limitedLease(A1);
  const s = state([m], [], { leases: { l1: l }, accounts: limited({ [A1]: NOW + 30 * MIN }) });
  assert.deepEqual(plan(s, NOW, config).filter((a) => a.kind === "continueThread"), [
    { kind: "continueThread", machineId: "m1", threadId: "t1", runId: "run1", account: A2 },
  ]);
  assert.equal(accountWait(s, m, NOW, config), undefined);
});

test("a thread continues only on an account its machine was brought up with", () => {
  // A3 was added to the secrets after m1 came up, so m1's T3 has no instance for it.
  const { m, l } = limitedLease(A1, { accounts: [A1, A2] });
  const s = state([m], [], { leases: { l1: l }, accounts: limited({ [A1]: NOW + 30 * MIN, [A2]: NOW + 50 * MIN }) });
  const actions = plan(s, NOW, config);
  assert.equal(actions.some((a) => a.kind === "continueThread"), false, "A3 is free but not on m1");
  assert.deepEqual(accountWait(s, m, NOW, config), { until: NOW + 40 * MIN });
});

test("with every account limited the lease and machine are kept until the earliest frees, plus 10 minutes", () => {
  const { m, l } = limitedLease(A1, {}, { expiresAt: NOW + 30 * MIN });
  const s = state([m], [], { leases: { l1: l }, accounts: limited({ [A1]: NOW + 50 * MIN, [A2]: NOW + 90 * MIN, [A3]: NOW + 70 * MIN }) });
  const actions = plan(s, NOW, config);
  assert.equal(actions.some((a) => a.kind === "continueThread"), false);
  assert.deepEqual(actions.filter((a) => a.kind === "extendLease" || a.kind === "extend"), [
    { kind: "extend", machineId: "m1", deadline: NOW + 60 * MIN },
    { kind: "extendLease", leaseId: "l1", expiresAt: NOW + 60 * MIN },
  ]);

  // Once the earliest account frees, the thread continues there.
  const later = plan({ ...s, machines: { m1: { ...m, deadline: NOW + 60 * MIN } }, leases: { l1: { ...l, expiresAt: NOW + 60 * MIN } } }, NOW + 50 * MIN, config);
  assert.deepEqual(later.filter((a) => a.kind === "continueThread"), [{ kind: "continueThread", machineId: "m1", threadId: "t1", runId: "run1", account: A1 }]);
});

test("a waiting machine's lease does not expire, even past expiresAt", () => {
  const { m, l } = limitedLease(A1, {}, { expiresAt: NOW - MIN });
  const s = state([m], [], { leases: { l1: l }, accounts: limited({ [A1]: NOW + 20 * MIN, [A2]: NOW + 20 * MIN, [A3]: NOW + 20 * MIN }) });
  const actions = plan(s, NOW, config);
  assert.equal(actions.some((a) => a.kind === "expireLease"), false);
  assert.deepEqual(actions.find((a) => a.kind === "extendLease"), { kind: "extendLease", leaseId: "l1", expiresAt: NOW + 30 * MIN });
});

test("a machine does not wait past maxLifetimeMinutes or the daily budget", () => {
  const all = (t: number) => limited({ [A1]: t, [A2]: t, [A3]: t });
  const { m, l } = limitedLease(A1);
  const late = state([m], [], { leases: { l1: l }, accounts: all(NOW + 170 * MIN) });
  const wait = accountWait(late, m, NOW, config);
  assert.ok(wait && "blocked" in wait && wait.blocked.includes("maximum lifetime"));
  assert.equal(plan(late, NOW, config).some((a) => a.kind === "extendLease"), false);

  const spent = state([m], [], { leases: { l1: l }, accounts: all(NOW + 60 * MIN), usage: { "2026-11-19": 19.5 * 3600 } });
  const w2 = accountWait(spent, m, NOW, config);
  assert.ok(w2 && "blocked" in w2 && w2.blocked.includes("daily budget"));
  assert.equal(plan(spent, NOW, config).some((a) => a.kind === "extendLease"), false);
});

// ---- size ladder ----

const trialLadder: Config = { ...config, sizes: [{ size: "small", max: 1 }, { size: "mini", max: 2 }] };
const sized = (id: string, repo: string, size: Machine["size"], phase: MachinePhase) => machine(id, repo, phase, { size });
const leased = (id: string) => ({ kind: "leased", leaseId: `l-${id}` }) as MachinePhase;

test("the ladder: each new machine is the largest size with room", () => {
  const one = state([], [queued("t1", "a")]);
  assert.deepEqual(plan(one, NOW, trialLadder), [{ kind: "create", repo: "a", size: "small" }]);
  const four = state([], [queued("t1", "a", 4), queued("t2", "a", 3), queued("t3", "a", 2), queued("t4", "a", 1)]);
  assert.deepEqual(
    plan(four, NOW, trialLadder).filter((a) => a.kind === "create"),
    [
      { kind: "create", repo: "a", size: "small" },
      { kind: "create", repo: "a", size: "mini" },
      { kind: "create", repo: "a", size: "mini" },
    ],
    "small first, then the two minis; the fourth ticket waits",
  );
  const smallBusy = state([sized("s1", "b", "small", leased("s1"))], [queued("t1", "a")]);
  assert.deepEqual(plan(smallBusy, NOW, trialLadder), [{ kind: "create", repo: "a", size: "mini" }], "small taken: a mini now, not a wait");
  const smallComing = state([sized("s1", "a", "small", { kind: "installing" })], [queued("t1", "a"), queued("t2", "a")]);
  assert.deepEqual(plan(smallComing, NOW, trialLadder), [{ kind: "create", repo: "a", size: "mini" }], "a machine coming up counts for its size and for the queue");
});

test("a mixed pool: the oldest ticket gets the largest idle machine, and sizes serve any repo", () => {
  const s = state(
    [sized("m1", "a", "mini", idle(1)), sized("s1", "a", "small", idle(1)), sized("m2", "a", "mini", idle(1))],
    [queued("t-old", "a", 5), queued("t-new", "a", 1)],
  );
  assert.deepEqual(plan(s, NOW, trialLadder).filter((x) => x.kind === "grant"), [
    { kind: "grant", ticketId: "t-old", machineId: "s1" },
    { kind: "grant", ticketId: "t-new", machineId: "m1" },
  ]);
  // An idle mini is granted at once rather than waiting for a new small to come up.
  const miniIdle = state([sized("m1", "a", "mini", idle(1))], [queued("t1", "a")]);
  assert.deepEqual(plan(miniIdle, NOW, trialLadder).filter((x) => x.kind !== "close"), [{ kind: "grant", ticketId: "t1", machineId: "m1" }]);
  // A small for repo b, minis for repo a: both repos run at the same time.
  const two = state([sized("s1", "b", "small", leased("s1"))], [queued("ta", "a"), queued("tb", "b")]);
  assert.deepEqual(plan(two, NOW, trialLadder).filter((x) => x.kind === "create"), [
    { kind: "create", repo: "a", size: "mini" },
    { kind: "create", repo: "b", size: "mini" },
  ]);
});

test("a queue spread across sizes waits with the full ladder as the reason, and perRepoCap still holds", () => {
  const machines = [sized("s1", "a", "small", leased("s1")), sized("m1", "a", "mini", leased("m1")), sized("m2", "b", "mini", leased("m2"))];
  const s = state(machines, [queued("t1", "a", 3), queued("t2", "b", 2), queued("t3", "a", 1)]);
  assert.deepEqual(plan(s, NOW, trialLadder), []);
  assert.equal(queueInfo(s, "t1", NOW, trialLadder).reason, "no room for a new machine (small 1/1, mini 2/2); idle machines of other repos close to make room");
  assert.equal(queueInfo(s, "t3", NOW, trialLadder).position, 2);
  // The released small goes to the oldest ticket of its repo.
  const freed = state([sized("s1", "a", "small", idle(0)), machines[1], machines[2]], s.tickets);
  assert.deepEqual(plan(freed, NOW, trialLadder), [{ kind: "grant", ticketId: "t1", machineId: "s1" }]);
  // perRepoCap 1: repo a has its machine; a free mini goes to repo b only.
  const capped = state([sized("s1", "a", "small", leased("s1"))], [queued("ta", "a", 2), queued("tb", "b", 1)]);
  assert.deepEqual(plan(capped, NOW, { ...trialLadder, perRepoCap: 1 }), [{ kind: "create", repo: "b", size: "mini" }]);
});

test("the budget counts small-machine-hours, so a mini's wait costs half", () => {
  const s = state([], [queued("t1", "a")], { usage: { "2026-11-19": 20 * 3600 } });
  assert.match(queueInfo(s, "t1", NOW, trialLadder).reason ?? "", /daily budget used: 20\.00 of 20 small-machine-hours/);

  // Every account limited for 30 more minutes: waiting 40 minutes costs 0.67 on a small, 0.33 on a mini.
  const withAccounts = { ...trialLadder, accounts: ["acct1"] };
  const limited = { limitedThreads: [{ threadId: "th", runId: "r", account: "acct1" }] };
  const extra = { usage: { "2026-11-19": 19.5 * 3600 }, accounts: { acct1: { limitedUntil: NOW + 30 * MIN } } };
  const small = state([machine("s1", "a", leased("s1"), { size: "small", ...limited })], [], extra);
  const mini = state([machine("m1", "a", leased("m1"), { size: "mini", ...limited })], [], extra);
  assert.match(JSON.stringify(accountWait(small, small.machines.s1, NOW, withAccounts)), /would pass the daily budget of 20 small-machine-hours/);
  assert.deepEqual(accountWait(mini, mini.machines.m1, NOW, withAccounts), { until: NOW + 40 * MIN });
});

test("a repo with a learned minimum size gets only that size or larger, and is not granted a smaller idle machine", async () => {
  const { plan, queueInfo } = await import("../src/plan.ts");
  const { parseConfig } = await import("../src/config.ts");
  const { emptyState } = await import("../src/types.ts");
  const config = parseConfig({ project: "p", template: "claude", sizes: [{ size: "small", max: 1 }, { size: "mini", max: 2 }] });
  const repo = "github.com/o/r";
  const now = 1_000_000_000;
  const state = emptyState();
  state.repoMinSize = { [repo]: "small" };
  state.machines["m1"] = { id: "m1", repo, size: "mini", createdAt: now - 60_000, deadline: now + 3_000_000, phase: { kind: "idle", since: now - 1000 } } as any;
  state.machines["s1"] = { id: "s1", repo: "github.com/o/other", size: "small", createdAt: now - 60_000, deadline: now + 3_000_000, phase: { kind: "leased", leaseId: "L" } } as any;
  state.tickets.push({ id: "t1", repo, ref: "main", holder: "h", status: "queued", enqueuedAt: now - 1000 } as any);
  const actions = plan(state, now, config);
  assert.equal(actions.filter((a: any) => a.kind === "grant").length, 0, "no grant of the mini");
  assert.equal(actions.filter((a: any) => a.kind === "create").length, 0, "the only small is taken");
  assert.match(queueInfo(state, "t1", now, config).reason ?? "", /small or larger/);
  delete state.machines["s1"];
  const creates = plan(state, now, config).filter((a: any) => a.kind === "create");
  assert.deepEqual(creates.map((a: any) => a.size), ["small"]);
});

test("an idle machine that stopped answering is closed, never granted", async () => {
  const { plan } = await import("../src/plan.ts");
  const { parseConfig } = await import("../src/config.ts");
  const { emptyState } = await import("../src/types.ts");
  const config = parseConfig({ project: "p", template: "claude", sizes: [{ size: "small", max: 1 }, { size: "mini", max: 2 }] });
  const repo = "github.com/o/r";
  const now = 1_000_000_000;
  const state = emptyState();
  state.machines["m1"] = { id: "m1", repo, size: "small", createdAt: now - 60_000, deadline: now + 3_000_000, unresponsiveSince: now - 60_000, phase: { kind: "idle", since: now - 1000 } } as any;
  state.tickets.push({ id: "t1", repo, ref: "main", holder: "h", status: "queued", enqueuedAt: now - 1000 } as any);
  const actions = plan(state, now, config);
  assert.equal(actions.filter((a: any) => a.kind === "grant").length, 0);
  assert.ok(actions.some((a: any) => a.kind === "close" && a.machineId === "m1" && a.reason === "unresponsive"));
});

test("vCPU limit: sizes without max fill up to the limit less the reserve, preferred size first, then smaller", async () => {
  const { plan } = await import("../src/plan.ts");
  const { parseConfig } = await import("../src/config.ts");
  const { emptyState } = await import("../src/types.ts");
  const config = parseConfig({ project: "p", template: "claude", sizes: [{ size: "medium" }, { size: "small" }], vcpuLimit: 40, vcpuReserve: 4, perRepoCap: 20, createsPerRepoPerHour: 50 });
  const now = 1_000_000_000;
  const state = emptyState();
  for (let i = 0; i < 12; i++) state.tickets.push({ id: `t${i}`, repo: "github.com/o/r", ref: "main", holder: "h", status: "queued", enqueuedAt: now - 1000 } as any);
  const sizes = plan(state, now, config).filter((a: any) => a.kind === "create").map((a: any) => a.size);
  assert.deepEqual(sizes, Array(9).fill("medium"), "36 vCPU of mediums, then nothing fits");
});

test("learnSize: up after a tight job, down after 3 light ones, never below the learned minimum", async () => {
  const { learnSize } = await import("../src/plan.ts");
  const { parseConfig } = await import("../src/config.ts");
  const config = parseConfig({ project: "p", template: "claude", sizes: [{ size: "large" }, { size: "medium" }, { size: "small" }], vcpuLimit: 40 });
  const job = (size: string, extra: object = {}) => ({ repo: "r", holder: "h", size, machineId: "m", grantedAt: 0, endedAt: 1, waitedMs: 0, ...extra }) as any;
  assert.equal(learnSize(config, "medium", [job("medium", { peakMemPct: 91 })])?.size, "large");
  assert.equal(learnSize(config, "medium", [job("medium", { memKills: 1, peakMemPct: 60 })])?.size, "large");
  assert.equal(learnSize(config, "medium", [job("medium", { froze: true })])?.size, "large");
  assert.equal(learnSize(config, "medium", [job("medium", { peakMemPct: 60 })]), undefined);
  const light = [job("medium", { peakMemPct: 30 }), job("medium", { peakMemPct: 22 }), job("medium", { peakMemPct: 35 })];
  assert.equal(learnSize(config, "medium", light)?.size, "small");
  assert.equal(learnSize(config, "medium", light, "medium"), undefined, "min size holds");
  assert.equal(learnSize(config, "medium", light.slice(0, 2)), undefined, "needs 3");
  assert.equal(learnSize(config, "medium", [job("medium", { peakMemPct: 30 }), job("medium"), job("medium", { peakMemPct: 30 })]), undefined, "unknown peak is not light");
});

test("repoIdleMs: waits long enough for 3 in 4 recent gaps, within idleCloseMinutes..idleMaxMinutes", async () => {
  const { repoIdleMs, plan } = await import("../src/plan.ts");
  const { parseConfig } = await import("../src/config.ts");
  const { emptyState } = await import("../src/types.ts");
  const M = 60_000;
  const config = parseConfig({ project: "p", template: "claude", sizes: [{ size: "medium" }], vcpuLimit: 40, idleCloseMinutes: 10, idleMaxMinutes: 30 });
  const state = emptyState();
  const repo = "github.com/o/r";
  const at = (start: number, len: number) => ({ repo, holder: "h", size: "medium", machineId: "m", grantedAt: start * M, endedAt: (start + len) * M, waitedMs: 0 }) as any;
  assert.equal(repoIdleMs(state, config, repo), 10 * M, "no history: default");
  // gaps of 15, 18, 12, 16 minutes
  state.jobs = [at(0, 5), at(20, 5), at(43, 5), at(60, 5), at(81, 5)];
  assert.equal(repoIdleMs(state, config, repo), 18 * M);
  state.jobs = [at(0, 5), at(65, 5), at(130, 5), at(195, 5)]; // hour-long gaps
  assert.equal(repoIdleMs(state, config, repo), 10 * M, "gaps past the max do not raise it");
  // An idle machine of this repo at 15 minutes stays when the learned wait is 18.
  state.jobs = [at(0, 5), at(20, 5), at(43, 5), at(60, 5), at(81, 5)];
  const now = 10_000 * M;
  state.machines["m1"] = { id: "m1", repo, size: "medium", createdAt: now - 30 * M, deadline: now + 60 * M, phase: { kind: "idle", since: now - 15 * M } } as any;
  assert.ok(!plan(state, now, config).some((a: any) => a.kind === "close"));
  (state.machines["m1"].phase as any).since = now - 19 * M;
  assert.ok(plan(state, now, config).some((a: any) => a.kind === "close" && a.reason === "idle"));
});

test("over vcpuPoolMax, idle machines close instead of being handed out again; busy ones are left alone", () => {
  const leased: MachinePhase = { kind: "leased", leaseId: "l1" };
  const s = state(
    [machine("busy", "a", leased), machine("idle1", "a", idle(1)), machine("idle2", "a", idle(1))],
    [queued("t1", "a")],
    { leases: { l1: { id: "l1", machineId: "busy", ticketId: "t0", holder: "h", grantedAt: NOW - MIN, expiresAt: NOW + 60 * MIN } as Lease } },
  );
  const actions = plan(s, NOW, { ...config, vcpuPoolMax: 4 });
  const closes = actions.filter((a) => a.kind === "close").map((a) => (a as { machineId: string }).machineId);
  const grants = actions.filter((a) => a.kind === "grant").map((a) => (a as { machineId: string }).machineId);
  assert.equal(closes.length, 1, "6 vCPU in use, cap 4: one idle small closes");
  assert.ok(!closes.includes("busy"));
  assert.equal(grants.length, 1, "the other idle small still serves the queued ticket");
  assert.ok(!actions.some((a) => a.kind === "create"), "no create while at the cap");
});
