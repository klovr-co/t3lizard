import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realInstabox } from "../src/instabox.ts";
import { ProviderLimitError, ProviderPaymentError } from "../src/provider.ts";

type Call = { method: string; path: string; query: URLSearchParams; headers: Record<string, string>; body: any };
type Answer = { status?: number; body?: unknown; headers?: Record<string, string> };

/** A fake InstaBox API: `route` answers each call; every call is recorded. */
function api(route: (c: Call) => Answer | Promise<Answer>) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const call: Call = {
      method: init.method ?? "GET",
      path: u.pathname,
      query: u.searchParams,
      headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const a = await route(call);
    return new Response(a.body === undefined ? "" : JSON.stringify(a.body), { status: a.status ?? 200, headers: a.headers });
  }) as typeof fetch;
  const provider = realInstabox({
    apiKey: "ibk_secret",
    template: "agent-browser",
    maxLifetimeMs: 180 * 60_000,
    fetch,
    baseUrl: "https://api.test",
    sleep: async (ms) => void sleeps.push(ms),
  });
  return { provider, calls, sleeps };
}

const error = (status: number, code: string, headers?: Record<string, string>): Answer => ({ status, body: { error: { code, message: `${code} happened`, retryable: status === 429 } }, headers });
const ran = (stdout = ""): Answer => ({ body: { stdout, stderr: "", exitCode: 0, timedOut: false, truncated: false, oomKilled: false } });

test("create sends the size, tag and backstop deletion, waits for the operation and a first command, and returns the machine", async () => {
  let opPolls = 0;
  let execs = 0;
  const { provider, calls } = api((c) => {
    if (c.method === "POST" && c.path === "/v1/machines") return { status: 202, body: { id: "op_1", machineId: "mc_1", state: "queued" } };
    if (c.path === "/v1/operations/op_1") return { body: { id: "op_1", state: ++opPolls < 3 ? "running" : "succeeded" } };
    if (c.path === "/v1/machines/mc_1/exec") return ++execs < 2 ? error(409, "machine_not_running") : ran();
    return error(500, "unexpected");
  });
  const before = Date.now();
  const out = await provider.create("github.com/acme/app", "small", 60 * 60_000);
  assert.equal(out.id, "mc_1");
  assert.ok(out.deadline >= before + 60 * 60_000 && out.deadline <= Date.now() + 60 * 60_000);
  const create = calls[0];
  assert.deepEqual(create.body, {
    templateId: "agent-browser",
    vcpus: 2,
    memMiB: 4096,
    metadata: { t3lizard: "1", repo: "github.com/acme/app" },
    autoSuspendAfterSeconds: 0,
    deleteAfterSeconds: (180 + 30) * 60,
  });
  assert.equal(create.headers["x-api-key"], "ibk_secret");
  assert.match(create.headers["idempotency-key"], /^[0-9a-f-]{36}$/);
  assert.equal(opPolls, 3);
  assert.deepEqual(calls.filter((c) => c.path.endsWith("/exec")).map((c) => c.body.argv), [["true"], ["true"]]);
});

test("create from a snapshot sends the snapshot and no size, since a snapshot keeps the size it was taken at", async () => {
  const { provider, calls } = api((c) => {
    if (c.method === "POST" && c.path === "/v1/machines") return { status: 202, body: { id: "op_1", machineId: "mc_1" } };
    if (c.path === "/v1/operations/op_1") return { body: { state: "succeeded" } };
    return ran();
  });
  await provider.create("github.com/acme/app", "medium", 60_000, "sn_1");
  assert.equal(calls[0].body.snapshotId, "sn_1");
  // InstaBox takes a template or a snapshot, never both.
  assert.equal("templateId" in calls[0].body || "vcpus" in calls[0].body || "memMiB" in calls[0].body, false);
});

test("a machine whose start fails is deleted and the error names the reason", async () => {
  const { provider, calls } = api((c) => {
    if (c.method === "POST" && c.path === "/v1/machines") return { status: 202, body: { id: "op_1", machineId: "mc_1" } };
    if (c.path === "/v1/operations/op_1") return { body: { state: "failed", error: { code: "no_capacity" } } };
    if (c.method === "DELETE") return { body: {} };
    return error(500, "unexpected");
  });
  await assert.rejects(provider.create("github.com/acme/app", "large", 60_000), /could not start mc_1: .*no_capacity/);
  const del = calls.find((c) => c.method === "DELETE")!;
  assert.equal(del.path, "/v1/machines/mc_1");
  assert.equal(del.headers["x-confirm-delete"], "mc_1");
});

test("a size InstaBox does not have is refused before any request", async () => {
  const { provider, calls } = api(() => error(500, "unexpected"));
  await assert.rejects(provider.create("github.com/acme/app", "mini", 60_000), /InstaBox has no mini machine \(sizes: small, medium, large\)/);
  assert.equal(calls.length, 0);
});

test("exec runs argv with no shell, so every argument reaches the program as sent", async () => {
  const { provider, calls } = api((c) => {
    // What the machine would run: the argv itself, no shell in between.
    const [file, ...args] = c.body.argv as string[];
    return ran(execFileSync(file, args, { encoding: "utf8" }));
  });
  const tricky = ["a b", "it's", "$HOME", "`id`", "x\ny", ""];
  const out = await provider.exec("mc_1", ["printf", "[%s]", ...tricky], 90_500);
  assert.equal(out.stdout, tricky.map((a) => `[${a}]`).join(""));
  assert.deepEqual(out, { stdout: out.stdout, stderr: "", exitCode: 0 });
  assert.equal(calls[0].body.timeoutSeconds, 91);
  assert.equal("cmd" in calls[0].body, false);
});

test("an argv over InstaBox's 64 KiB cap goes through stdin and still reaches the program exactly", async () => {
  const { provider, calls } = api((c) => {
    const [file, ...args] = c.body.argv as string[];
    return ran(execFileSync(file, args, { input: c.body.stdin, encoding: "utf8", maxBuffer: 1 << 21 }));
  });
  const big = Buffer.alloc(64 * 1024, 7).toString("base64"); // a `put` at PUT_MAX_BYTES
  const out = await provider.exec("mc_1", ["bash", "-c", 'printf "%s|%s|%s" "${#1}" "$2" "$0"', "zero", big, "a b\nc"]);
  assert.equal(out.stdout, `${big.length}|a b\nc|zero`);
  assert.equal(Buffer.byteLength(JSON.stringify(calls[0].body.argv)) < 1024, true);
  // A small argv is sent as it is.
  await provider.exec("mc_1", ["true"]);
  assert.deepEqual(calls[1].body, { argv: ["true"], timeoutSeconds: 120 });
});

test("exec asks for keepalive, and an error sent after the 200 (keepalive's error body) is an error", async () => {
  const { provider, calls } = api(() => ({ body: { error: { code: "host_unavailable", message: "connection to the sandbox was lost" }, status: 503 } }));
  await assert.rejects(provider.exec("mc_1", ["sleep", "400"], 400_000), /503 host_unavailable: connection to the sandbox was lost/);
  assert.equal(calls[0].headers["x-instabox-exec-keepalive"], "1");
});

test("exec waits out the account's concurrent exec limit (429 quota_exceeded, no Retry-After) with growing pauses", async () => {
  let n = 0;
  const { provider, sleeps } = api(() => (++n <= 3 ? error(429, "quota_exceeded") : ran("ok")));
  assert.equal((await provider.exec("mc_1", ["true"])).stdout, "ok");
  assert.deepEqual(sleeps, [1000, 2000, 4000]);
});

test("exec gives up on the limit after about a minute of waiting", async () => {
  const { provider, sleeps } = api(() => error(429, "quota_exceeded"));
  await assert.rejects(provider.exec("mc_1", ["true"]), ProviderLimitError);
  assert.equal(sleeps.reduce((a, b) => a + b, 0), 60_000);
});

test("at most execConcurrency execs are in flight at once", async () => {
  let inFlight = 0;
  let most = 0;
  const release: (() => void)[] = [];
  const calls: unknown[] = [];
  const fetch = (async () => {
    calls.push(1);
    most = Math.max(most, ++inFlight);
    await new Promise<void>((r) => release.push(r));
    inFlight--;
    return new Response(JSON.stringify({ stdout: "", stderr: "", exitCode: 0, timedOut: false }));
  }) as typeof globalThis.fetch;
  const provider = realInstabox({ apiKey: "k", template: "t", maxLifetimeMs: 60_000, fetch, execConcurrency: 2 });
  const all = Promise.all(Array.from({ length: 5 }, () => provider.exec("mc_1", ["true"])));
  for (let done = 0; done < 5; ) {
    await new Promise((r) => setImmediate(r));
    const next = release.shift();
    if (next) {
      next();
      done++;
    }
  }
  await all;
  assert.equal(calls.length, 5);
  assert.equal(most, 2);
});

test("a command that runs out its time is reported as timed out, which the daemon reads as no answer", async () => {
  const { provider } = api(() => ({ body: { stdout: "", stderr: "", exitCode: 124, timedOut: true } }));
  await assert.rejects(provider.exec("mc_1", ["sleep", "999"], 30_000), /timed out after 30 s/);
});

test("list follows the cursor and keeps only live machines tagged as this daemon's", async () => {
  const { provider, calls } = api((c) =>
    !c.query.get("cursor")
      ? { body: { machines: [{ id: "a", state: "running", metadata: { t3lizard: "1" } }, { id: "b", state: "deleted", metadata: { t3lizard: "1" } }], nextCursor: "p2" } }
      : {
          body: {
            machines: [
              { id: "c", state: "creating", metadata: { t3lizard: "1" } },
              { id: "d", state: "running", metadata: { owner: "someone else" } },
              { id: "e", state: "error", metadata: { t3lizard: "1" } },
            ],
            nextCursor: null,
          },
        },
  );
  assert.deepEqual(await provider.list(), ["a", "c"]);
  assert.deepEqual(calls.map((c) => [c.query.get("metadata"), c.query.get("cursor")]), [["t3lizard:1", null], ["t3lizard:1", "p2"]]);
});

test("alive is false for a machine InstaBox no longer has or reports stopped, and throws when it cannot tell", async () => {
  const states: Record<string, Answer> = { a: { body: { state: "running" } }, b: { body: { state: "stopped" } }, c: { body: { state: "deleting" } }, gone: error(404, "not_found"), d: error(500, "internal") };
  const { provider } = api((c) => states[c.path.split("/").pop()!]);
  assert.equal(await provider.alive("a"), true);
  assert.equal(await provider.alive("b"), false);
  assert.equal(await provider.alive("c"), false);
  assert.equal(await provider.alive("gone"), false);
  await assert.rejects(provider.alive("d"), /500 internal/);
});

test("exposePort publishes a private port with a fresh token and returns its host", async () => {
  const { provider, calls } = api(() => ({ status: 201, body: { id: "pt_1", url: "https://3774-abc.instabox.tech", token: "ibp_tok", access: "private" } }));
  assert.deepEqual(await provider.exposePort("mc_1", 3774), { hostname: "3774-abc.instabox.tech", accessToken: "ibp_tok" });
  assert.equal(calls[0].path, "/v1/machines/mc_1/ports");
  assert.deepEqual(calls[0].body, { port: 3774, access: "private", rotateToken: true });
  assert.ok(calls[0].headers["idempotency-key"]);
  assert.deepEqual(provider.portAuth, { kind: "cookie", name: "__Host-instabox_port_auth" });
});

test("kill and deleteSnapshot treat an already missing machine or snapshot as done", async () => {
  const { provider, calls } = api(() => error(404, "not_found"));
  await provider.kill("mc_1");
  await provider.deleteSnapshot("sn_1");
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["DELETE /v1/machines/mc_1", "DELETE /v1/snapshots/sn_1"]);
  const broken = api(() => error(500, "internal"));
  await assert.rejects(broken.provider.kill("mc_1"), /500 internal/);
});

test("snapshot waits until the snapshot is ready, and fails when InstaBox says it failed", async () => {
  let polls = 0;
  const { provider, calls } = api((c) => (c.method === "POST" ? { status: 202, body: { id: "sn_1", status: "pending" } } : { body: { id: "sn_1", status: ++polls < 3 ? "pending" : "ready" } }));
  assert.equal(await provider.snapshot("mc_1", "app-small"), "sn_1");
  assert.deepEqual(calls[0].body, { name: "app-small" });
  const failed = api((c) => (c.method === "POST" ? { status: 202, body: { id: "sn_2" } } : { body: { status: "failed", error: "disk" } }));
  await assert.rejects(failed.provider.snapshot("mc_1", "x"), /snapshot sn_2 failed: "disk"/);
});

test("rate and quota limits become ProviderLimitError (Retry-After, else 60 s); payment codes become ProviderPaymentError; the key never shows", async () => {
  const limited = api(() => error(429, "rate_limited", { "Retry-After": "42" }));
  const e1 = await limited.provider.create("github.com/acme/app", "small", 60_000).catch((e) => e);
  assert.ok(e1 instanceof ProviderLimitError);
  assert.equal(e1.code, "rate_limited");
  assert.equal(e1.retryAfterS, 42);

  const quota = api(() => error(429, "quota_exceeded"));
  const e2 = await quota.provider.create("github.com/acme/app", "small", 60_000).catch((e) => e);
  assert.ok(e2 instanceof ProviderLimitError);
  assert.equal(e2.retryAfterS, 60);

  const broke = api(() => error(402, "spend_limit_reached"));
  const e3 = await broke.provider.create("github.com/acme/app", "small", 60_000).catch((e) => e);
  assert.ok(e3 instanceof ProviderPaymentError);
  assert.equal(e3.code, "spend_limit_reached");
  for (const e of [e1, e2, e3]) assert.doesNotMatch(e.message, /ibk_secret/);
});
