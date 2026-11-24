import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore: plain JS module that runs on the machine
import { applyAccounts, busy, configureCodex, CONTINUE_MESSAGE, isDisabledNotice, limitNotice, main, isAuthNotice, STALL_MS } from "../src/machine/accounts.mjs";

const NOTICE = "Claude usage limit reached. This turn is paused until the 5-hour limit resets in 2h 2m.";

type Thread = { threadId: string; status: string; latestRunId: string; instanceId: string; items: { runId: string; type: string; title: string | null; text: string | null }[] };

/**
 * A stand-in for the machine's T3: the MCP OAuth endpoints (approval needs the approver bearer and
 * gives a csrf token; the token exchange checks PKCE) and an MCP endpoint that answers with
 * server-sent events and refuses any token it did not issue.
 */
async function fakeT3(threads: Thread[], opts: { backgroundWork?: boolean } = {}) {
  let backgroundWork = opts.backgroundWork ?? false;
  const calls: { name: string; args: any }[] = [];
  const issued = new Set<string>();
  const codes = new Map<string, string>();
  let n = 0;
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    const auth = req.headers.authorization ?? "";
    if (req.url === "/oauth/mcp/register") return json(201, { client_id: `client-${JSON.parse(raw).client_name}` });
    if (req.url === "/oauth/mcp/approval") return json(200, auth === "Bearer approver-token" ? { csrfToken: "csrf-1", clientName: "t3lizard" } : { clientName: "t3lizard" });
    if (req.url === "/oauth/mcp/decision") {
      const { authorization, decision } = JSON.parse(raw);
      if (auth !== "Bearer approver-token" || decision.csrfToken !== "csrf-1" || decision.access !== "full-access") return json(400, { message: "bad decision" });
      const code = `code-${++n}`;
      codes.set(code, authorization.code_challenge);
      return json(200, { redirectTo: `${authorization.redirect_uri}?code=${code}&state=${authorization.state}` });
    }
    if (req.url === "/oauth/mcp/token") {
      const form = new URLSearchParams(raw);
      const challenge = createHash("sha256").update(form.get("code_verifier")!).digest("base64url");
      if (codes.get(form.get("code")!) !== challenge) return json(400, { error: "invalid_grant" });
      const token = `mcp-${++n}`;
      issued.add(token);
      return json(200, { access_token: token, token_type: "Bearer", expires_in: 2592000, scope: "orchestration:read" });
    }
    if (req.url !== "/mcp") return json(404, {});
    if (!issued.has(auth.replace("Bearer ", ""))) return json(401, { error: "invalid_token" });
    const msg = JSON.parse(raw);
    if (!("id" in msg)) return void res.writeHead(202).end();
    const sse = (result: unknown) => {
      res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "s-1" });
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n\n`);
    };
    if (msg.method === "initialize") return sse({ protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "t3" } });
    const { name, arguments: args } = msg.params;
    calls.push({ name, args });
    const tool = (structuredContent: unknown) => sse({ content: [], structuredContent });
    const thread = threads.find((t) => t.threadId === args.threadId);
    switch (name) {
      case "t3_thread_list": {
        const rows = threads.filter((t) => args.statuses.includes(t.status));
        return tool({ projectId: null, currentThreadId: null, threads: rows.map((t) => ({ threadId: t.threadId, status: t.status, latestRunId: t.latestRunId })), nextCursor: null, total: rows.length });
      }
      case "t3_thread_read":
        return tool({
          thread: { threadId: thread!.threadId, status: thread!.status, latestRunId: thread!.latestRunId },
          recentRuns: [{ runId: thread!.latestRunId, status: thread!.status, providerInstanceId: thread!.instanceId, requestedAt: "2026-11-19T12:00:00.000Z" }],
          items: thread!.items,
        });
      case "t3_thread_interrupt":
        backgroundWork = false;
        return tool({ threadId: thread!.threadId });
      case "t3_thread_configure":
        if (args.modelSelection) {
          if (backgroundWork) return sse({ isError: true, content: [{ type: "text", text: "The session still has background agents or commands running; stop them first." }] });
          thread!.instanceId = args.modelSelection.instanceId;
          return tool({ sequence: 7 });
        }
        return tool({ threadId: thread!.threadId, modelSelection: { instanceId: thread!.instanceId, model: "claude-opus-5-5", options: [{ id: "effort", value: "xhigh" }] } });
      case "t3_thread_send":
        thread!.status = "running";
        thread!.latestRunId = "run-2";
        return tool({ threadId: thread!.threadId, messageId: "m-2", runId: "run-2", status: "running", delivery: "started" });
    }
    return sse({ isError: true, content: [{ type: "text", text: `no tool ${name}` }] });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, calls, issued, close: () => new Promise((r) => (server.closeAllConnections(), server.close(r))) };
}

function machineEnv(origin: string) {
  const dir = mkdtempSync(join(tmpdir(), "t3lizard-accounts-"));
  const t3 = join(dir, "t3");
  writeFileSync(t3, '#!/bin/sh\ncase "$*" in "auth session issue"*) echo approver-token ;; *) exit 9 ;; esac\n', { mode: 0o755 });
  return { dir, env: { T3LIZARD_T3_ORIGIN: origin, T3LIZARD_T3_CLI: t3, T3LIZARD_T3_BASE_DIR: join(dir, ".t3"), T3LIZARD_MCP_TOKEN_FILE: join(dir, "mcp-token") } };
}

const limitedThread = (): Thread => ({
  threadId: "t-1",
  status: "failed",
  latestRunId: "run-1",
  instanceId: "claudeAgent_acct1",
  items: [
    { runId: "run-1", type: "system_notice", title: NOTICE, text: NOTICE },
    { runId: "run-1", type: "assistant_message", title: null, text: "You’ve hit your session limit · resets 9:40pm (UTC)" },
    { runId: "run-1", type: "error", title: null, text: "Claude API rate limit reached. Try again later." },
  ],
});

test("configure gives each account its own instance and token, and disables the plain one", () => {
  const dir = mkdtempSync(join(tmpdir(), "t3lizard-settings-"));
  const accountsFile = join(dir, "accounts.json");
  writeFileSync(accountsFile, JSON.stringify([{ id: "claudeAgent_acct1", token: "tok-1" }, { id: "claudeAgent_acct2", token: "tok-2" }]));
  const before = { linkedEnvironmentsEnabled: true, providerInstances: { codex: { driver: "codex" }, claudeAgent_acct9: { driver: "claudeAgent" } } };
  const settingsFile = join(dir, ".t3", "userdata", "settings.json");
  main(["configure", accountsFile], { T3LIZARD_T3_BASE_DIR: join(dir, ".t3") });
  const s = JSON.parse(readFileSync(settingsFile, "utf8"));
  assert.equal(statSync(settingsFile).mode & 0o777, 0o600);
  assert.throws(() => readFileSync(accountsFile), "the token file is removed");
  assert.equal(s.providerInstances.claudeAgent.enabled, false);
  assert.equal(s.autoResumeLimitedThreads, false);
  assert.deepEqual(s.providerInstances.claudeAgent_acct2.environment, [{ name: "CLAUDE_CODE_OAUTH_TOKEN", value: "tok-2", sensitive: true }]);
  assert.equal(s.providerInstances.claudeAgent_acct1.config, undefined, "no homePath: accounts share ~/.claude so a switch resumes the session");

  const first = applyAccounts(before, [{ id: "claudeAgent_acct1", token: "tok-1" }, { id: "claudeAgent_acct2", token: "tok-2" }]);
  const again = applyAccounts(first, [{ id: "claudeAgent_acct2", token: "tok-2b" }]);
  assert.deepEqual(Object.keys(again.providerInstances).sort(), ["claudeAgent", "claudeAgent_acct2", "codex"], "accounts no longer configured are removed");
  assert.equal(again.linkedEnvironmentsEnabled, true);
});

test("a limit notice marks the run; a plain rate-limit error or another run does not", () => {
  const t = limitedThread();
  assert.equal(limitNotice("run-1", t.items), NOTICE);
  assert.equal(limitNotice("run-1", t.items.slice(2)), undefined);
  assert.equal(limitNotice("run-0", t.items), undefined);
  assert.ok(limitNotice("run-1", [t.items[1]]));
});

test("scan signs in once through MCP OAuth, caches the token and finds the limited thread", async (t) => {
  const healthy: Thread = { threadId: "t-2", status: "failed", latestRunId: "r", instanceId: "claudeAgent_acct2", items: [{ runId: "r", type: "error", title: null, text: "tool crashed" }] };
  const t3 = await fakeT3([limitedThread(), healthy]);
  t.after(t3.close);
  const { env } = machineEnv(t3.origin);

  const out = await main(["scan"], env);
  assert.deepEqual(out, { limited: [{ threadId: "t-1", runId: "run-1", account: "claudeAgent_acct1", requestedAt: "2026-11-19T12:00:00.000Z", notice: NOTICE, disabled: false, auth: false }] });
  assert.equal(readFileSync(env.T3LIZARD_MCP_TOKEN_FILE, "utf8"), [...t3.issued][0]);
  assert.equal(statSync(env.T3LIZARD_MCP_TOKEN_FILE).mode & 0o777, 0o600);

  await main(["scan"], env);
  assert.equal(t3.issued.size, 1, "the cached token is reused");

  t3.issued.clear();
  await main(["scan"], env);
  assert.equal(t3.issued.size, 1, "a refused token is replaced");
});

test("continue switches the thread's account, keeps its model, sends continue once", async (t) => {
  const thread = limitedThread();
  const t3 = await fakeT3([thread]);
  t.after(t3.close);
  const { env } = machineEnv(t3.origin);

  const out = await main(["continue", "t-1", "run-1", "claudeAgent_acct2"], env);
  assert.deepEqual(out, { threadId: "t-1", account: "claudeAgent_acct2", runId: "run-2", delivery: "started" });
  const configure = t3.calls.find((c) => c.name === "t3_thread_configure" && c.args.modelSelection);
  assert.deepEqual(configure?.args.modelSelection, { instanceId: "claudeAgent_acct2", model: "claude-opus-5-5", options: [{ id: "effort", value: "xhigh" }] });
  const send = t3.calls.find((c) => c.name === "t3_thread_send");
  assert.equal(send?.args.message, CONTINUE_MESSAGE);
  assert.equal(send?.args.clientRequestId, "t3lizard-continue-run-1");

  const repeat = await main(["continue", "t-1", "run-1", "claudeAgent_acct2"], env);
  assert.match(repeat.skipped, /running at run run-2/);
  assert.equal(t3.calls.filter((c) => c.name === "t3_thread_send").length, 1);
});

test("continue stops background work that blocks the account switch, then switches", async (t) => {
  const thread = limitedThread();
  const t3 = await fakeT3([thread], { backgroundWork: true });
  t.after(t3.close);
  const { env } = machineEnv(t3.origin);

  const out = await main(["continue", "t-1", "run-1", "claudeAgent_acct2"], env);
  assert.equal(out.account, "claudeAgent_acct2");
  const names = t3.calls.map((c) => c.name).filter((n) => n === "t3_thread_interrupt" || n === "t3_thread_configure" || n === "t3_thread_send");
  assert.deepEqual(names, ["t3_thread_configure", "t3_thread_configure", "t3_thread_interrupt", "t3_thread_configure", "t3_thread_send"]);
  assert.deepEqual(t3.calls.find((c) => c.name === "t3_thread_interrupt")?.args, { threadId: "t-1", stop: true });
});

test("an admin-disabled account is a limit notice that is marked disabled", () => {
  const text = "Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access";
  const items = [{ runId: "run-1", title: "error", text }];
  assert.equal(limitNotice("run-1", items), text);
  assert.equal(isDisabledNotice(text), true);
  assert.equal(isDisabledNotice(NOTICE), false);
});

test("configure-antigravity writes the hashed OAuth profile, enables Antigravity, sets defaultModelSelection, and preserves Claude instances", () => {
  const dir = mkdtempSync(join(tmpdir(), "t3lizard-ag-"));
  const accountsFile = join(dir, "accounts.json");
  writeFileSync(accountsFile, JSON.stringify([{ id: "claudeAgent_acct1", token: "tok-1" }]));
  main(["configure", accountsFile], { T3LIZARD_T3_BASE_DIR: join(dir, ".t3") });

  const agFile = join(dir, "antigravity.json");
  const tokenJson = JSON.stringify({ token: { access_token: "a", refresh_token: "r", token_type: "Bearer" }, auth_method: "consumer" });
  writeFileSync(agFile, JSON.stringify({ instanceId: "antigravity", token: tokenJson, defaultModel: "gemini-4-neon", makeDefault: true }));
  main(["configure-antigravity", agFile], { T3LIZARD_T3_BASE_DIR: join(dir, ".t3") });

  assert.throws(() => readFileSync(agFile), "the input config file is removed");
  const hash = createHash("sha256").update("antigravity").digest("hex");
  const appDir = join(dir, ".t3", "userdata", "providers", "antigravity", hash, "antigravity-acp");
  assert.equal(readFileSync(join(appDir, "antigravity-oauth-token"), "utf8"), tokenJson);
  assert.equal(statSync(join(appDir, "antigravity-oauth-token")).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(join(appDir, "settings.json"), "utf8")), { auth: { type: "oauth-personal" } });
  assert.deepEqual(JSON.parse(readFileSync(join(appDir, "cache", "acp-auth-state.json"), "utf8")), { methodId: "oauth-personal" });

  const s = JSON.parse(readFileSync(join(dir, ".t3", "userdata", "settings.json"), "utf8"));
  assert.deepEqual(s.providerInstances.antigravity, { driver: "antigravity", displayName: "Antigravity", enabled: true });
  assert.deepEqual(s.defaultModelSelection, { instanceId: "antigravity", model: "gemini-4-neon" });
  assert.equal(s.providerInstances.claudeAgent_acct1.enabled, true, "Claude instances are preserved");
});

test("a revoked or expired login is a notice marked auth, not disabled", () => {
  const t3 = "Claude could not authenticate. For subscription login, run `claude auth login` on this environment's machine, then start a new thread.";
  const claude = "Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator.";
  for (const text of [t3, claude]) {
    assert.equal(isAuthNotice(text), true);
    assert.equal(isDisabledNotice(text), false);
    assert.equal(limitNotice("r1", [{ runId: "r1", title: "Provider error", text }]), text, "the scan treats it as a notice");
  }
  assert.equal(isAuthNotice("Claude usage limit reached."), false);
  assert.equal(isAuthNotice("Your organization has disabled Claude subscription access"), false);
});

test("busy leaves out a thread that says it is running but has not changed for STALL_MS", async () => {
  const now = Date.parse("2026-11-24T07:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const threads = [
    { threadId: "fresh", status: "running", updatedAt: ago(60_000) },
    { threadId: "dead", status: "running", updatedAt: ago(STALL_MS + 60_000) },
    { threadId: "no-time", status: "running" },
  ];
  const tools = { call: async () => ({ threads, nextCursor: null }) };
  assert.equal(await busy(tools, now), 2);
});

test("configure-codex writes the login to Codex's home (mode 600), turns the Codex provider on and deletes its input", () => {
  const dir = mkdtempSync(join(tmpdir(), "t3lizard-codex-"));
  const base = join(dir, "t3");
  const input = join(dir, "codex.json");
  const auth = JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "x" } });
  writeFileSync(input, JSON.stringify({ auth }));
  configureCodex(base, input, join(dir, "codex-home"));
  assert.equal(readFileSync(join(dir, "codex-home", "auth.json"), "utf8"), auth);
  assert.equal(statSync(join(dir, "codex-home", "auth.json")).mode & 0o777, 0o600);
  const settings = JSON.parse(readFileSync(join(base, "userdata", "settings.json"), "utf8"));
  assert.deepEqual(settings.providerInstances.codex, { driver: "codex", displayName: "Codex", enabled: true });
  assert.throws(() => statSync(input));
});
