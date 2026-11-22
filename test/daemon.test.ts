import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call, serveApi } from "../src/api.ts";
import { DEFAULT_CONFIG, paths } from "../src/config.ts";
import { Daemon } from "../src/daemon.ts";
import { startDashboard } from "../src/dashboard.ts";
import { LizardLimitError } from "../src/lizard.ts";
import { normalizeOrigin } from "../src/repo.ts";
import type { Config } from "../src/types.ts";
import { addStep, readSetup } from "../src/setup.ts";
import { FakeLizard, FakeT3, noSleep } from "./fakes.ts";

const MIN = 60_000;
const REPO = "git@github.com:Acme/app.git";

async function harness(
  t: { after(fn: () => unknown): void },
  overrides: Partial<Config> = {},
  shared?: { home: string; lizard: FakeLizard; t3: FakeT3; clock: { now: number } },
  extra?: { antigravityToken?: string; probe?: (token: string) => Promise<import("../src/probe.ts").ProbeResult> },
) {
  const home = shared?.home ?? mkdtempSync(join(tmpdir(), "t3lizard-daemon-"));
  const clock = shared?.clock ?? { now: Date.parse("2026-11-19T12:00:00Z") };
  const lizard = shared?.lizard ?? new FakeLizard(() => clock.now);
  const t3 = shared?.t3 ?? new FakeT3();
  const logs: string[] = [];
  const config: Config = { ...DEFAULT_CONFIG, project: "p", perRepoCap: 2, sizes: [{ size: "small", max: 2 }], proxyPortRange: [47380, 47399], ...overrides };
  const daemon = new Daemon({
    lizard,
    t3,
    config,
    machineEnv: { GH_TOKEN: "gh-secret" },
    accountTokens: Object.fromEntries(config.accounts.map((a) => [a, `token-of-${a}`])),
    ...(extra?.antigravityToken ? { antigravityToken: extra.antigravityToken } : {}),
    ...(extra?.probe ? { probe: extra.probe } : {}),
    home,
    resolveRepo: async (r) => normalizeOrigin(r),
    now: () => clock.now,
    sleep: noSleep,
    log: (l) => logs.push(l),
  });
  await daemon.start();
  const socket = paths(home).socket;
  const server = await serveApi(daemon, socket);
  const api = (path: string, body?: unknown) => call(socket, body === undefined ? "GET" : "POST", path, body);
  const stop = async () => {
    await new Promise((r) => server.close(r));
    await daemon.stop();
  };
  let stopped = false;
  t.after(() => (stopped ? undefined : stop()));
  return {
    home, clock, lizard, t3, logs, daemon, api,
    stop: async () => {
      stopped = true;
      await stop();
    },
    advance: async (minutes: number) => {
      clock.now += minutes * MIN;
      await daemon.tick();
      await daemon.settled();
    },
  };
}

const portOpen = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });

test("acquire, queue, grant on release, then idle close", async (t) => {
  const h = await harness(t);

  const a0 = await h.api("/acquire", { repo: REPO, ref: "main", holder: "thread-a" });
  assert.equal(a0.status, "queued");
  assert.equal(a0.reason, "a machine is starting");
  await h.daemon.settled();
  const a = await h.api("/wait", { ticketId: a0.ticketId, maxSeconds: 1 });
  assert.equal(a.status, "granted");
  assert.equal(a.lease.machineId, "sb-1");
  assert.equal(a.lease.environmentId, "env-1");
  assert.equal(a.lease.projectId, "11111111-2222-3333-4444-555555555555");
  assert.equal(a.lease.workspacePath, "/home/user/app");
  const proxyPort = Number(new URL(h.t3.links.get("env-1")!.url).port);
  assert.ok(await portOpen(proxyPort), "proxy listens on the linked port");
  assert.equal(h.lizard.machines.get("sb-1")!.repo, "github.com/Acme/app");
  assert.equal(h.lizard.machines.get("sb-1")!.files.get("env")!.content, "GH_TOKEN='gh-secret'\n");
  assert.ok(h.lizard.machines.get("sb-1")!.steps.includes("reset"), "checkout reset before the lease");

  const b0 = await h.api("/acquire", { repo: REPO, ref: "feature", holder: "thread-b" });
  await h.daemon.settled();
  const b = await h.api("/wait", { ticketId: b0.ticketId, maxSeconds: 1 });
  assert.equal(b.lease.machineId, "sb-2");

  const c0 = await h.api("/acquire", { repo: REPO, ref: "main", holder: "thread-c" });
  assert.deepEqual({ status: c0.status, position: c0.position, reason: c0.reason }, {
    status: "queued",
    position: 1,
    reason: "all 2 machines for this repo are busy",
  });
  assert.equal(h.lizard.machines.size, 2, "no machine over the per-repo cap");

  const waiting = h.api("/wait", { ticketId: c0.ticketId, maxSeconds: 10 });
  assert.deepEqual(await h.api("/release", { leaseId: a.lease.leaseId }), { released: true });
  const c = await waiting;
  assert.equal(c.status, "granted");
  assert.equal(c.lease.machineId, "sb-1", "the released machine goes to the next ticket");
  assert.equal((await h.api("/wait", { ticketId: a0.ticketId, maxSeconds: 0 })).status, "released");

  await h.api("/release", { leaseId: b.lease.leaseId });
  await h.api("/release", { ticketId: c0.ticketId });
  await h.daemon.settled();

  await h.advance(9);
  assert.equal(h.lizard.killed.length, 0);
  await h.advance(1);
  assert.deepEqual(h.lizard.killed.sort(), ["sb-1", "sb-2"]);
  assert.deepEqual(h.t3.unlinked.sort(), ["env-1", "env-2"]);
  assert.deepEqual((await h.api("/status")).pools, {});
  assert.equal(await portOpen(proxyPort), false, "proxy closed with its machine");

  const stateFile = paths(h.home).state;
  assert.equal(statSync(stateFile).mode & 0o777, 0o600);
  assert.ok(statSync(stateFile).size > 0);
  assert.equal(statSync(paths(h.home).socket).mode & 0o777, 0o600);
});

test("a restarted daemon re-opens proxies, keeps leases, and drops machines Lizard lost", async (t) => {
  const first = await harness(t);
  const a0 = await first.api("/acquire", { repo: REPO, ref: "main", holder: "a" });
  await first.daemon.settled();
  const a = await first.api("/wait", { ticketId: a0.ticketId, maxSeconds: 1 });
  const port = Number(new URL(first.t3.links.get("env-1")!.url).port);
  await first.stop();
  assert.equal(await portOpen(port), false);

  const second = await harness(t, {}, first);
  assert.ok(await portOpen(port), "proxy back on the same port, so the existing T3 link still works");
  assert.equal((await second.api("/wait", { ticketId: a0.ticketId, maxSeconds: 0 })).lease.leaseId, a.lease.leaseId);

  second.lizard.machines.delete("sb-1");
  await second.advance(0);
  assert.equal((await second.api("/wait", { ticketId: a0.ticketId, maxSeconds: 0 })).status, "released");
  assert.deepEqual(second.t3.unlinked, ["env-1"]);
  assert.equal(await portOpen(port), false);
});

test("kills sandboxes Lizard has that the daemon does not know", async (t) => {
  const h = await harness(t);
  await h.lizard.create("github.com/Acme/app", "small", 60 * MIN);
  await h.advance(0);
  assert.deepEqual(h.lizard.killed, ["sb-1"]);
});

test("bring-up exposes the front proxy and points its Host at the machine's fixed devbox port before linking", async (t) => {
  const exposed: number[] = [];
  const first = await harness(t);
  const expose = first.lizard.exposePort.bind(first.lizard);
  first.lizard.exposePort = async (id, port) => (exposed.push(port), expose(id, port));
  await first.api("/acquire", { repo: REPO, ref: "main", holder: "a" });
  await first.daemon.settled();
  const m = first.lizard.machines.get("sb-1")!;
  const link = first.t3.links.get("env-1")!;
  const port = Number(new URL(link.url).port);
  assert.deepEqual(exposed, [3774]);
  assert.equal(m.files.get("front-host")!.content, `127.0.0.1:${port}\n`);
  assert.ok(m.steps.indexOf("front-health") < m.steps.lastIndexOf("pair"), "front configured before pairing");

  const frontSetups = m.steps.filter((s) => s === "front-health").length;
  await first.stop();
  // Something else holds the port while the daemon restarts: it must wait for the same port.
  const squatter = net.createServer();
  await new Promise<void>((r) => squatter.listen(port, "127.0.0.1", r));
  const second = await harness(t, {}, first);
  await second.advance(1);
  assert.ok(second.logs.some((l) => l.includes(`proxy for sb-1`) && l.includes("did not reopen")));
  await new Promise((r) => squatter.close(r));
  await second.advance(1);
  assert.ok(await portOpen(port), "reopened on the next tick");
  assert.equal(second.daemon.state.machines["sb-1"].proxyPort, port, "the port is kept across restarts");
  assert.equal(m.steps.filter((s) => s === "front-health").length, frontSetups, "no reconfigure needed");
  assert.equal(m.files.get("front-host")!.content, `127.0.0.1:${port}\n`);
});

test("never kills a sandbox someone else started in the project", async (t) => {
  const h = await harness(t);
  h.lizard.addForeign("theirs", { owner: "ci" });
  h.lizard.addForeign("unlabelled");
  await h.advance(0);
  await h.advance(1);
  assert.deepEqual(h.lizard.killed, []);
});

test("a machine missing from a lagging listing is kept while Lizard says it is alive", async (t) => {
  const h = await harness(t);
  const t0 = await h.api("/acquire", { repo: REPO, ref: "main", holder: "a" });
  await h.daemon.settled();
  h.lizard.hiddenFromList.add("sb-1");
  await h.advance(1);
  assert.equal(h.lizard.killed.length, 0);
  assert.equal((await h.api("/wait", { ticketId: t0.ticketId, maxSeconds: 0 })).status, "granted");
  assert.ok(!h.logs.some((l) => l.includes("gone at Lizard")));
});

test("a Lizard limit pauses creates until retryAfter and shows in status", async (t) => {
  const h = await harness(t);
  h.lizard.nextCreateError = new LizardLimitError("Too many sandbox starts", "SANDBOX_RATE_LIMITED", 120);
  const t0 = await h.api("/acquire", { repo: REPO, ref: "main", holder: "a" });
  await h.daemon.settled();
  const queued = await h.api("/wait", { ticketId: t0.ticketId, maxSeconds: 0 });
  assert.match(queued.reason, /paused.*Too many sandbox starts/);
  assert.equal((await h.api("/status")).lastLizardError.code, "SANDBOX_RATE_LIMITED");
  await h.advance(1);
  assert.equal(h.lizard.machines.size, 0, "no retry inside retryAfter");
  await h.advance(1);
  assert.equal((await h.api("/wait", { ticketId: t0.ticketId, maxSeconds: 0 })).status, "granted");
});

test("a ref that cannot be fetched cancels the ticket and keeps the machine", async (t) => {
  const h = await harness(t);
  h.lizard.on.reset = (_m, args) => (args[1] === "unpushed" ? { stdout: "", stderr: "fatal: couldn't find remote ref unpushed", exitCode: 10 } : undefined);
  const t0 = await h.api("/acquire", { repo: REPO, ref: "unpushed", holder: "a" });
  await h.daemon.settled();
  const v = await h.api("/wait", { ticketId: t0.ticketId, maxSeconds: 0 });
  assert.equal(v.status, "cancelled");
  assert.match(v.error, /cannot fetch unpushed/);
  const t1 = await h.api("/acquire", { repo: REPO, ref: "main", holder: "b" });
  assert.equal(t1.status, "granted", "the same machine serves the next ticket at once");
  assert.equal(t1.lease.machineId, "sb-1");
});

test("an expired lease is kept while the machine has a busy thread, then freed", async (t) => {
  const h = await harness(t, { leaseMinutes: 30, idleCloseMinutes: 60 });
  const t0 = await h.api("/acquire", { repo: REPO, ref: "main", holder: "a" });
  await h.daemon.settled();
  h.lizard.threads = [{ status: "running" }];
  await h.advance(30);
  assert.equal((await h.api("/wait", { ticketId: t0.ticketId, maxSeconds: 0 })).status, "granted");
  h.lizard.threads = [{ status: "completed" }];
  await h.advance(10);
  assert.equal((await h.api("/wait", { ticketId: t0.ticketId, maxSeconds: 0 })).status, "released");
  assert.equal((await h.api("/status")).pools["github.com/Acme/app"].machines[0].phase, "idle");
});

test("a failed bring-up closes the machine and pauses creates", async (t) => {
  const h = await harness(t);
  h.lizard.on["install-poll"] = () => ({ stdout: "failed\nnpm ERR! network\n", stderr: "", exitCode: 0 });
  const t0 = await h.api("/acquire", { repo: REPO, ref: "main", holder: "a" });
  await h.daemon.settled();
  await h.advance(0);
  assert.deepEqual(h.lizard.killed, ["sb-1"]);
  const v = await h.api("/wait", { ticketId: t0.ticketId, maxSeconds: 0 });
  assert.equal(v.status, "queued");
  assert.match(v.reason, /bring-up of sb-1 failed/);
  await h.advance(1);
  assert.equal(h.lizard.machines.size, 0);
});

test("usage is counted per machine-second and the state file keeps no other secret than the access token", async (t) => {
  const h = await harness(t, { idleCloseMinutes: 120 });
  await h.api("/acquire", { repo: REPO, ref: "main", holder: "a" });
  await h.daemon.settled();
  await h.advance(0);
  await h.advance(30);
  assert.equal((await h.api("/status")).budget.usedToday, 0.5);
  assert.equal(readFileSync(paths(h.home).state, "utf8").includes("gh-secret"), false);
});

test("machines that vanish right after create cannot loop: backoff, hourly cap and budget charge", async (t) => {
  // The live test made 7 sandboxes in 90 s. Here every sandbox is gone by its first step.
  const h = await harness(t, { ticketMaxWaitMinutes: 180, sizes: [{ size: "small", max: 1 }] });
  h.lizard.on.preflight = (m) => {
    for (const [id, x] of h.lizard.machines) if (x === m) h.lizard.machines.delete(id);
    return { stdout: "", stderr: "sandbox not found", exitCode: 1 };
  };
  let calls = 0;
  const create = h.lizard.create.bind(h.lizard);
  h.lizard.create = (...a) => (calls++, create(...a));
  const created = () => calls;
  const t0 = await h.api("/acquire", { repo: REPO, ref: "main", holder: "a" });
  await h.daemon.settled();
  await h.advance(0);
  assert.equal(created(), 1);
  const v = await h.api("/wait", { ticketId: t0.ticketId, maxSeconds: 0 });
  assert.equal(v.status, "queued");
  assert.match(v.reason, /creates back off until .*: 1 machine\(s\) in a row never became ready; last: bring-up of sb-1 failed/);

  const timeline: number[] = [];
  for (let minute = 1; minute <= 70; minute++) {
    await h.advance(1);
    timeline.push(created());
  }
  // Creates at minute 0, 2 (after 2 min), 7 (after 5 more), then the hourly cap of 3 holds until minute 60.
  assert.equal(timeline[1], 2, "second create after the 2-minute backoff");
  assert.equal(timeline[5], 2);
  assert.equal(timeline[6], 3, "third create after the 5-minute backoff");
  assert.equal(timeline[58], 3, "no fourth create inside the hour");
  assert.equal(timeline[59], 4, "the fourth create comes once the first leaves the hour");
  const status = await h.api("/status");
  assert.ok(status.budget.usedToday >= 4 * 10 / 60 - 0.01, `each create charged 10 minutes, got ${status.budget.usedToday}`);
  assert.ok(h.logs.some((l) => /never became ready: bring-up of sb-1 failed.*creates back off 2 min \(1 in a row\)/.test(l)));
});

test("a sandbox that vanishes during bring-up is dropped by reconcile and counts as a failed create", async (t) => {
  const h = await harness(t);
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const exec = h.lizard.exec.bind(h.lizard);
  h.lizard.exec = async (id, cmd, timeoutMs) => {
    if (cmd[2].includes("# t3lizard:install-poll")) await gate;
    return exec(id, cmd, timeoutMs);
  };
  await h.api("/acquire", { repo: REPO, ref: "main", holder: "a" });
  for (let i = 0; i < 20 && !h.lizard.machines.get("sb-1")?.steps.includes("install-start"); i++) await new Promise((r) => setImmediate(r));
  h.lizard.machines.delete("sb-1");
  await h.daemon.tick();
  open();
  await h.daemon.settled();
  assert.ok(h.logs.some((l) => l.includes("machine sb-1 is gone at Lizard; dropping it")));
  assert.ok(h.logs.some((l) => /sb-1 vanished at Lizard during bring-up \(installing\); creates back off 2 min/.test(l)));
  await h.advance(1);
  assert.equal(h.lizard.machines.size, 0, "no create inside the backoff");
  await h.advance(1);
  assert.equal(h.lizard.machines.size, 1, "one create after it");
});

test("a thread that hits a usage limit continues on the next account; with all limited the machine waits", async (t) => {
  const A1 = "claudeAgent_acct1";
  const A2 = "claudeAgent_acct2";
  const h = await harness(t, { accounts: [A1, A2], accountRetryMinutes: 30, leaseMinutes: 20, lifetimeMinutes: 30, maxLifetimeMinutes: 240 });
  const queued = await h.api("/acquire", { repo: REPO, ref: "main", holder: "thread-a" });
  await h.daemon.settled();
  const granted = await h.api("/wait", { ticketId: queued.ticketId, maxSeconds: 1 });
  assert.equal(granted.lease.providerInstanceId, A1);
  const m = h.lizard.machines.get("sb-1")!;
  assert.doesNotMatch(m.files.get("env")!.content, /token-of/, "no account token in the machine-wide env");
  assert.equal(m.files.get("accounts.json")!.content, JSON.stringify([{ id: A1, token: `token-of-${A1}` }, { id: A2, token: `token-of-${A2}` }]));

  const limitedOn = (runId: string, account: string) =>
    h.lizard.limited.set("sb-1", [{ threadId: "t1", runId, account, requestedAt: new Date(h.clock.now).toISOString(), notice: "Claude usage limit reached." }]);

  // acct1 hits its limit: the thread moves to acct2 and new delegations go there too.
  limitedOn("r1", A1);
  await h.advance(1);
  assert.deepEqual(h.lizard.continued, [["sb-1", "t1", "r1", A2]]);
  const s1 = await h.api("/status");
  assert.deepEqual(s1.accounts.map((a: { id: string; free: boolean }) => [a.id, a.free]), [[A1, false], [A2, true]]);
  assert.equal((await h.api("/wait", { ticketId: queued.ticketId, maxSeconds: 1 })).lease.providerInstanceId, A2);

  // A later scan that still shows r1 (it raced the continue) does not continue it again.
  await h.advance(1);
  assert.equal(h.lizard.continued.length, 1);

  // acct2 hits its limit too: nothing is free, so the lease and machine are kept until acct1 frees, plus 10 minutes.
  limitedOn("r2", A2);
  await h.advance(1);
  assert.equal(h.lizard.continued.length, 1);
  const acct1Frees = h.clock.now - 2 * MIN + 30 * MIN;
  const lease = h.daemon.state.leases[granted.lease.leaseId];
  assert.equal(lease.expiresAt, acct1Frees + 10 * MIN);
  assert.equal(h.lizard.machines.get("sb-1")!.deadline, acct1Frees + 10 * MIN);
  const s2 = await h.api("/status");
  assert.equal(s2.pools["github.com/Acme/app"].machines[0].waitingForAccountUntil, new Date(acct1Frees + 10 * MIN).toISOString());

  // Once acct1 frees, the thread continues there.
  await h.advance(28);
  assert.deepEqual(h.lizard.continued.at(-1), ["sb-1", "t1", "r2", A1]);

  // A released lease takes its limited threads with it; the next holder's scan ignores older runs.
  await h.api("/release", { leaseId: granted.lease.leaseId });
  assert.equal(h.daemon.state.machines["sb-1"].limitedThreads, undefined);
});

test("an account added after a machine came up is given to that machine while it runs", async (t) => {
  const A1 = "claudeAgent_acct1";
  const A2 = "claudeAgent_acct2";
  const first = await harness(t, { accounts: [A1] });
  const q = await first.api("/acquire", { repo: REPO, ref: "main", holder: "a" });
  await first.daemon.settled();
  const granted = await first.api("/wait", { ticketId: q.ticketId, maxSeconds: 1 });
  assert.equal(granted.lease.providerInstanceId, A1);
  await first.advance(0);
  const m = first.lizard.machines.get("sb-1")!;
  const pushes = m.steps.filter((s) => s === "accounts").length;
  assert.equal(pushes, 1, "an up-to-date machine is not pushed again");
  await first.stop();

  // A2 is added to the secrets and the daemon restarts: the leased machine gets it without a restart.
  const second = await harness(t, { accounts: [A1, A2] }, first);
  await second.advance(0);
  assert.equal(m.steps.filter((s) => s === "accounts").length, pushes + 1);
  assert.equal(m.files.get("accounts.json")!.content, JSON.stringify([{ id: A1, token: `token-of-${A1}` }, { id: A2, token: `token-of-${A2}` }]));
  await second.advance(5);
  assert.equal(m.steps.filter((s) => s === "accounts").length, pushes + 1, "pushed once");
});

test("bring-up runs the repo's setup script in the checkout after the clone and before the machine is ready", async (t) => {
  const h = await harness(t);
  addStep(h.home, "github.com/Acme/app", { line: "command -v bun >/dev/null || curl -fsSL https://bun.sh/install | bash", reason: "needs bun", now: h.clock.now });
  h.lizard.on["repo-setup-log"] = () => ({ stdout: "bun was installed successfully\n", stderr: "", exitCode: 0 });
  const t0 = await h.api("/acquire", { repo: REPO, ref: "main", holder: "a" });
  await h.daemon.settled();
  const m = h.lizard.machines.get("sb-1")!;
  assert.match(m.files.get("repo-setup.sh")!.content, /# \d{4}-\d{2}-\d{2}: needs bun\ncommand -v bun/);
  const at = (step: string) => m.steps.indexOf(step);
  assert.ok(at("project") < at("repo-setup-start") && at("repo-setup-start") < at("pair"), m.steps.join(","));
  assert.ok(h.logs.includes("setup sb-1: bun was installed successfully"));
  assert.equal((await h.api("/wait", { ticketId: t0.ticketId, maxSeconds: 1 })).status, "granted");
  assert.equal(h.daemon.state.machines["sb-1"].setupHash, readSetup(h.home, "github.com/Acme/app").hash);
});

test("a failing repo setup fails the bring-up with the script's last lines and backs creates off", async (t) => {
  const h = await harness(t);
  addStep(h.home, "github.com/Acme/app", { line: "bun install", reason: "deps", now: h.clock.now });
  h.lizard.on["repo-setup-poll"] = () => ({ stdout: "exit=127\n", stderr: "", exitCode: 0 });
  h.lizard.on["repo-setup-log"] = () => ({ stdout: "resolving\nbash: line 9: bun: command not found\n", stderr: "", exitCode: 0 });
  const t0 = await h.api("/acquire", { repo: REPO, ref: "main", holder: "a" });
  await h.daemon.settled();
  assert.deepEqual(h.lizard.killed, ["sb-1"]);
  assert.ok(h.logs.includes("setup sb-1: bash: line 9: bun: command not found"), "full output in the daemon log");
  const v = await h.api("/wait", { ticketId: t0.ticketId, maxSeconds: 0 });
  assert.match(v.reason, /creates back off .*bring-up of sb-1 failed: repo setup failed \(exit 127\):\nresolving\nbash: line 9: bun: command not found/);
});

test("a repo with no setup script skips the step", async (t) => {
  const h = await harness(t);
  await h.api("/acquire", { repo: REPO, ref: "main", holder: "a" });
  await h.daemon.settled();
  assert.ok(!h.lizard.machines.get("sb-1")!.steps.includes("repo-setup-start"));
});

test("setup add, show and remove through the API", async (t) => {
  const h = await harness(t);
  const added = await h.api("/setup/add", { repo: REPO, line: "command -v jq >/dev/null || sudo -n apt-get install -y jq", reason: "jq missing", by: "thread-7" });
  assert.equal(added.added, true);
  assert.equal(added.repo, "github.com/Acme/app");
  assert.equal(added.path, join(h.home, "repos", "Acme", "app", "setup.sh"));
  assert.equal((await h.api("/setup/add", { repo: REPO, line: "command -v jq >/dev/null || sudo -n apt-get install -y jq", reason: "again" })).added, false);
  await assert.rejects(h.api("/setup/add", { repo: REPO, line: "a\nb", reason: "r" }), /one line/);
  const shown = await h.api("/setup/show", { repo: REPO });
  assert.deepEqual(shown.steps.map((s: { line: string }) => s.line), ["command -v jq >/dev/null || sudo -n apt-get install -y jq"]);
  assert.equal(shown.history[0].by, "thread-7");
  assert.equal((await h.api("/setup/remove", { repo: REPO, step: 1 })).removed.reason, "jq missing (thread-7)");
  assert.equal((await h.api("/setup/show", { repo: REPO })).steps.length, 0);
});

test("a mini lease shows its size, status shows the ladder, and usage is weighted by size", async (t) => {
  const h = await harness(t, { sizes: [{ size: "small", max: 1 }, { size: "mini", max: 2 }], idleCloseMinutes: 120 });
  const t0 = await h.api("/acquire", { repo: REPO, ref: "main", holder: "a" });
  await h.daemon.settled();
  const t1 = await h.api("/acquire", { repo: REPO, ref: "main", holder: "b" });
  await h.daemon.settled();
  const a = await h.api("/wait", { ticketId: t0.ticketId, maxSeconds: 1 });
  const b = await h.api("/wait", { ticketId: t1.ticketId, maxSeconds: 1 });
  assert.equal(a.lease.size, "small");
  assert.equal(b.lease.size, "mini");
  assert.deepEqual([...h.lizard.machines.values()].map((m) => m.size), ["small", "mini"]);
  await h.advance(0);
  await h.advance(30);
  const status = await h.api("/status");
  assert.deepEqual(status.sizes, [{ size: "small", max: 1, inUse: 1 }, { size: "mini", max: 2, inUse: 1 }]);
  assert.deepEqual(status.pools["github.com/Acme/app"].machines.map((m: { size: string }) => m.size).sort(), ["mini", "small"]);
  assert.match(status.budget.unit, /^small-machine-hours/);
  assert.equal(status.budget.usedToday, 0.75, "30 min of small (0.5) + 30 min of mini (0.25)");
});

test("a released lease saves its machine's chats on the devbox and the pool page serves them", async (t) => {
  const h = await harness(t);
  const t0 = await h.api("/acquire", { repo: REPO, ref: "main", holder: "thread-a" });
  await h.daemon.settled();
  const granted = await h.api("/wait", { ticketId: t0.ticketId, maxSeconds: 1 });
  const out = mkdtempSync(join(tmpdir(), "t3lizard-export-"));
  writeFileSync(join(out, "1.json"), JSON.stringify({ thread: { threadId: "thread:x:1", title: "Run the gate" }, messages: [{ role: "user", text: "brief <b>" }, { role: "assistant", text: "done" }] }));
  const tgz = execFileSync("tar", ["-C", out, "-czf", "-", "."]).toString("base64");
  let since = "";
  h.lizard.on["export"] = (_m, args) => ((since = args[1]), { stdout: tgz, stderr: "", exitCode: 0 });

  await h.api("/release", { leaseId: granted.lease.leaseId });
  await h.daemon.settled();

  assert.ok(Date.parse(since) <= h.clock.now, "exports threads from the lease start, with clock skew");
  const job = h.daemon.state.jobs!.at(-1)!;
  assert.deepEqual(job.chats, [{ threadId: "thread:x:1", title: "Run the gate", file: "sb-1/thread_x_1.json", messages: 2 }]);
  const saved = JSON.parse(readFileSync(join(h.daemon.transcriptsDir(), "sb-1/thread_x_1.json"), "utf8"));
  assert.equal(saved.holder, "thread-a");
  assert.equal(saved.messages[1].text, "done");

  const [server] = await startDashboard(h.daemon, 47398, ["127.0.0.1"], () => {});
  t.after(() => new Promise((r) => server.close(r)));
  const page = await (await fetch("http://127.0.0.1:47398/chat?f=sb-1/thread_x_1.json")).text();
  assert.match(page, /Run the gate/);
  assert.match(page, /brief &lt;b&gt;/);
  assert.equal((await fetch("http://127.0.0.1:47398/chat?f=../secrets.env")).status, 400);
});

test("when Antigravity is configured, new machines install it and leases default to Antigravity while exposing a Claude fallback", async (t) => {
  const agToken = JSON.stringify({ token: { access_token: "a", refresh_token: "r" }, auth_method: "consumer" });
  const h = await harness(t, { accounts: ["claudeAgent_acct1"], defaultProvider: "antigravity", defaultModel: "gemini-4-neon" }, undefined, { antigravityToken: agToken });
  const t0 = await h.api("/acquire", { repo: REPO, ref: "main", holder: "ag-test" });
  await h.daemon.settled();
  const granted = await h.api("/wait", { ticketId: t0.ticketId, maxSeconds: 1 });
  assert.equal(granted.status, "granted");
  assert.equal(granted.lease.providerInstanceId, "antigravity");
  assert.equal(granted.lease.model, "gemini-4-neon");
  assert.equal(granted.lease.claudeProviderInstanceId, "claudeAgent_acct1");

  const m = h.lizard.machines.get("sb-1")!;
  assert.ok(m.steps.includes("antigravity"));
  assert.equal(JSON.parse(m.files.get("antigravity.json")!.content).token, agToken);

  const status = await h.api("/status");
  assert.equal(status.antigravityConfigured, true);
  assert.equal(status.defaultProvider, "antigravity");
  assert.equal(status.defaultModel, "gemini-4-neon");
  assert.equal(status.pools["github.com/Acme/app"].machines[0].antigravity, true);
});

test("exec runs a command on the leased machine with no agent, waits for it, and refuses a lease that ended", async (t) => {
  const h = await harness(t);
  const a0 = await h.api("/acquire", { repo: REPO, ref: "main", holder: "thread-a" });
  await h.daemon.settled();
  const a = await h.api("/wait", { ticketId: a0.ticketId, maxSeconds: 1 });
  const leaseId = a.lease.leaseId;

  h.lizard.execOutput = "typecheck ok\n";
  h.lizard.execRunsFor = 2;
  const r = await h.api("/exec", { leaseId, command: "bun run typecheck", timeoutMinutes: 45 });
  assert.equal(r.status, "exited");
  assert.equal(r.exitCode, 0);
  assert.equal(r.output, "typecheck ok\n");
  const started = [...h.lizard.execs.values()][0];
  assert.equal(started.command, "bun run typecheck");
  assert.equal(started.workspace, "/home/user/app");
  assert.equal(started.timeout, String(45 * 60));

  // A job longer than maxSeconds comes back running, and exec/wait picks it up.
  h.lizard.execRunsFor = 1000;
  const slow = await h.api("/exec", { leaseId, command: "sleep 600", maxSeconds: 0 });
  assert.equal(slow.status, "running");
  h.lizard.execRunsFor = 0;
  const later = await h.api("/exec/wait", { leaseId, execId: slow.execId, maxSeconds: 5 });
  assert.equal(later.status, "exited");

  await assert.rejects(h.api("/exec", { leaseId: "nope", command: "ls" }), /no lease nope/);
  await h.api("/release", { leaseId });
  await assert.rejects(h.api("/exec", { leaseId, command: "ls" }), /no lease/);
});

test("an account shows as disabled only while a disabled notice decides its block, not after a later plain usage limit", async (t) => {
  const A1 = "claudeAgent_acct1";
  const A2 = "claudeAgent_acct2";
  const h = await harness(t, { accounts: [A1, A2], accountRetryMinutes: 30, accountDisabledMinutes: 5, leaseMinutes: 120, lifetimeMinutes: 120, maxLifetimeMinutes: 240 });
  const queued = await h.api("/acquire", { repo: REPO, ref: "main", holder: "thread-a" });
  await h.daemon.settled();
  await h.api("/wait", { ticketId: queued.ticketId, maxSeconds: 1 });
  const notice = (runId: string, disabled: boolean) =>
    h.lizard.limited.set("sb-1", [{ threadId: `t-${runId}`, runId, account: A1, requestedAt: new Date(h.clock.now).toISOString(), notice: disabled ? "Your organization has disabled Claude subscription access" : "Claude usage limit reached.", disabled } as never]);
  const acct1 = async () => (await h.api("/status")).accounts.find((a: { id: string }) => a.id === A1);

  notice("r1", true);
  await h.advance(1);
  assert.equal((await acct1()).disabled, true);

  // After the disabled window, the account hits a plain usage limit: it is limited, not disabled.
  await h.advance(10);
  notice("r2", false);
  await h.advance(1);
  const a = await acct1();
  assert.equal(a.free, false);
  assert.equal(a.disabled, undefined);
});

test("a replaced account token reaches machines that are already running, not only a changed account list", async (t) => {
  const A1 = "claudeAgent_acct1";
  const h = await harness(t, { accounts: [A1], leaseMinutes: 120, lifetimeMinutes: 120, maxLifetimeMinutes: 240 });
  const queued = await h.api("/acquire", { repo: REPO, ref: "main", holder: "thread-a" });
  await h.daemon.settled();
  await h.api("/wait", { ticketId: queued.ticketId, maxSeconds: 1 });
  const m = h.lizard.machines.get("sb-1")!;
  assert.match(m.files.get("accounts.json")!.content, /token-of-claudeAgent_acct1/);

  await h.advance(2);
  assert.match(m.files.get("accounts.json")!.content, /token-of-claudeAgent_acct1/, "same token: nothing pushed");
  const pushes = () => m.steps.filter((s) => s === "accounts").length;
  const before = pushes();
  await h.advance(2);
  assert.equal(pushes(), before, "an unchanged machine is not touched again");

  (h.daemon as unknown as { deps: { accountTokens: Record<string, string> } }).deps.accountTokens[A1] = "replacement-token";
  await h.advance(2);
  assert.match(m.files.get("accounts.json")!.content, /replacement-token/);
  assert.equal(pushes(), before + 1);
  assert.doesNotMatch(readFileSync(paths(h.home).state, "utf8"), /replacement-token/, "the state file keeps only a fingerprint");
});

test("accounts are probed one per tick; broken ones are skipped, a probe that says ok lifts its own block", async (t) => {
  const [A1, A2, A3, A4] = ["claudeAgent_acct1", "claudeAgent_acct2", "claudeAgent_acct3", "claudeAgent_acct4"];
  const verdict: Record<string, import("../src/probe.ts").ProbeResult> = {
    [`token-of-${A1}`]: { kind: "ok", note: "OK" },
    [`token-of-${A2}`]: { kind: "disabled", note: "Your organization has disabled Claude subscription access" },
    [`token-of-${A3}`]: { kind: "limit", note: "You've hit your 5-hour limit", resetsAt: Date.parse("2026-11-19T14:20:00Z") },
    [`token-of-${A4}`]: { kind: "auth", note: "OAuth token revoked" },
  };
  const asked: string[] = [];
  const h = await harness(t, { accounts: [A1, A2, A3, A4] }, undefined, { probe: async (token) => (asked.push(token), verdict[token]) });
  (h.daemon as unknown as { deps: { accountLabels: Record<string, string> } }).deps.accountLabels = { [A1]: "claude-dev-klovr", [A3]: "claude-xianjun-klovr" };
  const queued = await h.api("/acquire", { repo: REPO, ref: "main", holder: "thread-a" });
  await h.daemon.settled();
  await h.api("/wait", { ticketId: queued.ticketId, maxSeconds: 1 });

  for (let i = 0; i < 4; i++) await h.advance(1);
  assert.equal(new Set(asked).size, 4, "each account asked once, one per tick");
  const acct = async (id: string) => (await h.api("/status")).accounts.find((a: { id: string }) => a.id === id);
  assert.equal((await acct(A1)).verified, true);
  assert.deepEqual([(await acct(A1)).label, (await acct(A2)).label, (await acct(A3)).label], ["claude-dev-klovr", undefined, "claude-xianjun-klovr"], "status names an account when it has a label");
  assert.match(h.logs.join("\n"), /claudeAgent_acct3 \(claude-xianjun-klovr\): unknown -> limit/);
  assert.equal((await acct(A1)).free, true);
  assert.deepEqual([(await acct(A2)).free, (await acct(A2)).disabled], [false, true]);
  const a3 = await acct(A3);
  assert.deepEqual([a3.free, a3.limitedUntil], [false, "2026-11-19T14:20:00.000Z"], "the limit lasts until the CLI's reset time");
  assert.deepEqual([(await acct(A4)).free, (await acct(A4)).authFailed], [false, true]);
  assert.match((await acct(A4)).probe, /^auth, \d+ min ago: OAuth token revoked/);
  assert.equal((await h.api("/wait", { ticketId: queued.ticketId, maxSeconds: 1 })).lease.providerInstanceId, A1, "the lease names the verified account");

  // acct4 gets a new login. After the auth recheck interval a probe says ok and the block lifts.
  verdict[`token-of-${A4}`] = { kind: "ok", note: "OK" };
  await h.advance(31); // acct2's recheck is due in the same tick, and only one probe runs per tick
  await h.advance(1);
  const a4 = await acct(A4);
  assert.deepEqual([a4.free, a4.authFailed, a4.verified], [true, undefined, true]);
  assert.match(h.logs.join("\n"), /claudeAgent_acct4 works again/);
});

test("a thread that fails to authenticate continues on another account, and a probe that says ok lifts the block", async (t) => {
  const [A1, A2] = ["claudeAgent_acct1", "claudeAgent_acct2"];
  const h = await harness(t, { accounts: [A1, A2], leaseMinutes: 120, lifetimeMinutes: 120, maxLifetimeMinutes: 240 }, undefined, {
    probe: async () => ({ kind: "ok", note: "OK" }),
  });
  const queued = await h.api("/acquire", { repo: REPO, ref: "main", holder: "thread-a" });
  await h.daemon.settled();
  await h.api("/wait", { ticketId: queued.ticketId, maxSeconds: 1 });
  await h.advance(1);
  await h.advance(1);
  const m = h.lizard.machines.get("sb-1")!;
  const pushes = () => m.steps.filter((s) => s === "accounts").length;
  const before = pushes();

  h.lizard.limited.set("sb-1", [
    { threadId: "t1", runId: "r1", account: A1, requestedAt: new Date(h.clock.now).toISOString(), notice: "Claude could not authenticate.", auth: true } as never,
  ]);
  await h.advance(1);
  assert.deepEqual(h.lizard.continued, [["sb-1", "t1", "r1", A2]], "moved to the other account straight away");
  const mid = (await h.api("/status")).accounts.find((a: { id: string }) => a.id === A1);
  assert.deepEqual([mid.free, mid.authFailed], [false, true]);

  await h.advance(1); // the probe of acct1 runs: ok, so the block lifts; the machine gets the current logins
  const after = (await h.api("/status")).accounts.find((a: { id: string }) => a.id === A1);
  assert.deepEqual([after.free, after.authFailed], [true, undefined]);
  assert.ok(pushes() > before, "the machine was given the current logins again");
});
