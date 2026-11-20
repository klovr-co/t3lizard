// t3lizard account helper. Runs on the machine; plain JS with node: modules only.
//
//   node accounts.mjs configure <accounts.json>   one claudeAgent_acct<N> provider instance per account
//   node accounts.mjs scan                         JSON: threads whose latest run failed on a usage limit
//   node accounts.mjs busy                         JSON: threads still working, sub-agents included
//   node accounts.mjs export <sinceIso> <outDir>   threads updated since then, with messages, as JSON files
//   node accounts.mjs continue <thread> <run> <account>
//                                                  switch the thread to that account and send "continue"
//
// scan and continue use T3's MCP tools. The T3 CLI has no command that changes a thread's provider
// instance, and only a full-access MCP client may change a full-access thread. Such a client comes
// from T3's MCP OAuth flow, approved with a short-lived local bearer session. Its token is cached.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

export const CONTINUE_MESSAGE = "Continue where you left off.";
const ACCOUNT_INSTANCE = /^claudeAgent_acct\d+$/;
/**
 * T3's limit notice ("Claude usage limit reached. This turn is paused until ...") or Claude's own
 * reply ("You've hit your session limit · resets ..."). A plain API rate limit (429) is not one.
 */
const LIMIT_TEXT = /usage limit reached|you['\u2019]ve hit your [\w-]+ limit/i;

/** Settings with one enabled provider instance per account, each holding only its own token. */
export function applyAccounts(settings, accounts) {
  const instances = { ...settings.providerInstances };
  for (const id of Object.keys(instances)) if (ACCOUNT_INSTANCE.test(id)) delete instances[id];
  // The plain instance would run on whatever auth the machine has. Threads must name an account.
  instances.claudeAgent = { ...instances.claudeAgent, driver: "claudeAgent", enabled: false };
  for (const { id, token } of accounts) {
    // No homePath: every account shares ~/.claude, so T3 resumes the same Claude session after a switch.
    instances[id] = {
      driver: "claudeAgent",
      displayName: `Claude ${id.slice("claudeAgent_".length)}`,
      enabled: true,
      environment: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", value: token, sensitive: true }],
    };
  }
  // T3's own auto-resume would resume a waiting thread at its reset on the same account,
  // racing t3lizard, which resumes it on whichever account frees first.
  return { ...settings, providerInstances: instances, autoResumeLimitedThreads: false };
}

/** The limit message among a run's timeline items, if the run failed on a usage limit. */
export function limitNotice(runId, items) {
  const hit = items.find((i) => i.runId === runId && LIMIT_TEXT.test(`${i.title ?? ""}\n${i.text ?? ""}`));
  return hit && (hit.text ?? hit.title);
}

function writePrivate(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, text, { mode: 0o600 });
  chmodSync(`${file}.tmp`, 0o600);
  renameSync(`${file}.tmp`, file);
}

export function configure(baseDir, accountsFile) {
  const settingsFile = join(baseDir, "userdata", "settings.json");
  let settings = {};
  try {
    settings = JSON.parse(readFileSync(settingsFile, "utf8"));
  } catch {}
  writePrivate(settingsFile, JSON.stringify(applyAccounts(settings, JSON.parse(readFileSync(accountsFile, "utf8"))), null, 2));
  rmSync(accountsFile, { force: true });
}

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${new URL(url).pathname} answered ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

/** A full-access MCP client token, through T3's MCP OAuth flow (register, approve, exchange). */
export async function issueMcpToken({ origin, t3, baseDir }) {
  const { stdout } = await run(t3, ["auth", "session", "issue", "--base-dir", baseDir, "--ttl", "5m", "--label", "t3lizard approver", "--token-only"]);
  const bearer = { authorization: `Bearer ${stdout.trim()}` };
  const redirectUri = "http://127.0.0.1/t3lizard";
  const { client_id } = await postJson(`${origin}/oauth/mcp/register`, { client_name: "t3lizard", redirect_uris: [redirectUri] });
  const verifier = randomBytes(32).toString("base64url");
  const authorization = {
    response_type: "code",
    client_id,
    redirect_uri: redirectUri,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: randomBytes(16).toString("base64url"),
    resource: `${origin}/mcp`,
  };
  const { csrfToken } = await postJson(`${origin}/oauth/mcp/approval`, authorization, bearer);
  if (!csrfToken) throw new Error("the approver session may not approve MCP clients");
  const decision = { _tag: "browser-session", access: "full-access", csrfToken };
  const { redirectTo } = await postJson(`${origin}/oauth/mcp/decision`, { authorization, decision }, bearer);
  const code = new URL(redirectTo).searchParams.get("code");
  if (!code) throw new Error(`approval gave no code: ${new URL(redirectTo).searchParams.get("error") ?? redirectTo}`);
  const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id, code_verifier: verifier, resource: `${origin}/mcp` });
  const res = await fetch(`${origin}/oauth/mcp/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(`token exchange answered ${res.status}: ${body.error_description ?? body.error ?? ""}`);
  return body.access_token;
}

class Unauthorized extends Error {}

/** JSON-RPC payloads from a streamable-HTTP MCP response: plain JSON or server-sent events. */
async function payloads(res) {
  const text = await res.text();
  if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) return text.trim() ? [JSON.parse(text)].flat() : [];
  return text
    .split(/\r?\n\r?\n/)
    .map((event) => event.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n"))
    .filter(Boolean)
    .map((data) => JSON.parse(data));
}

/** A minimal MCP client: initialize once, then tools/call. Returns each tool's structuredContent. */
export async function mcpSession(endpoint, token) {
  let sessionId;
  let protocolVersion;
  let next = 0;
  const send = async (message) => {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
      },
      body: JSON.stringify(message),
    });
    sessionId = res.headers.get("mcp-session-id") ?? sessionId;
    if (res.status === 401 || res.status === 403) throw new Unauthorized(`MCP answered ${res.status}`);
    if (!res.ok) throw new Error(`MCP answered ${res.status}: ${(await res.text()).slice(0, 500)}`);
    return payloads(res);
  };
  const request = async (method, params) => {
    const id = `t3lizard-${next++}`;
    const reply = (await send({ jsonrpc: "2.0", id, method, params })).find((p) => p.id === id);
    if (!reply || reply.error) throw new Error(`MCP ${method} failed: ${JSON.stringify(reply?.error ?? "no reply")}`);
    return reply.result;
  };
  const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t3lizard", version: "0.1.0" } });
  protocolVersion = init.protocolVersion;
  await send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return {
    async call(name, args) {
      const result = await request("tools/call", { name, arguments: args });
      if (result.isError) throw new Error(`${name}: ${result.content?.map((c) => c.text).join(" ") ?? "failed"}`);
      return result.structuredContent;
    },
  };
}

/** An MCP session on the machine's T3. Reuses the cached token; a refused one is replaced once. */
export async function connect(opts) {
  const endpoint = `${opts.origin}/mcp`;
  let token;
  try {
    token = readFileSync(opts.tokenFile, "utf8").trim();
  } catch {}
  if (token) {
    try {
      return await mcpSession(endpoint, token);
    } catch (e) {
      if (!(e instanceof Unauthorized)) throw e;
    }
  }
  token = await issueMcpToken(opts);
  writePrivate(opts.tokenFile, token);
  return mcpSession(endpoint, token);
}

/** Threads whose latest run failed on a usage limit, with the account (provider instance) it ran on. */
export async function scan(tools) {
  const limited = [];
  for (let cursor = 0; cursor !== null; ) {
    const page = await tools.call("t3_thread_list", { allProjects: true, statuses: ["failed"], includeSubagents: true, limit: 100, cursor });
    for (const t of page.threads) {
      if (!t.latestRunId) continue;
      const read = await tools.call("t3_thread_read", { threadId: t.threadId, view: "activity", beforePosition: 2 ** 31 - 1, limit: 30, runLimit: 5, maxCharsPerItem: 2000 });
      const latest = read.recentRuns.find((r) => r.runId === t.latestRunId);
      if (latest?.status !== "failed") continue;
      const notice = limitNotice(latest.runId, read.items);
      if (notice) limited.push({ threadId: t.threadId, runId: latest.runId, account: latest.providerInstanceId, requestedAt: latest.requestedAt, notice });
    }
    cursor = page.nextCursor;
  }
  return limited;
}

/** Moves the thread to `account` and continues it, unless it moved on from `runId`. Safe to repeat. */
export async function continueThread(tools, threadId, runId, account) {
  const { thread } = await tools.call("t3_thread_read", { threadId, limit: 1, runLimit: 1 });
  if (thread.latestRunId !== runId || thread.status !== "failed") return { threadId, skipped: `thread is ${thread.status} at run ${thread.latestRunId}` };
  const { modelSelection } = await tools.call("t3_thread_configure", { threadId });
  if (modelSelection.instanceId !== account) await tools.call("t3_thread_configure", { threadId, modelSelection: { ...modelSelection, instanceId: account } });
  const sent = await tools.call("t3_thread_send", { threadId, message: CONTINUE_MESSAGE, mode: "auto", clientRequestId: `t3lizard-continue-${runId}` });
  return { threadId, account, runId: sent.runId, delivery: sent.delivery };
}

/** Threads (sub-agents included) still working: the T3 CLI's list leaves sub-agent threads out. */
export async function busy(tools) {
  const statuses = ["waiting", "running", "starting", "queued", "preparing"];
  let n = 0;
  for (let cursor = 0; cursor !== null; ) {
    const page = await tools.call("t3_thread_list", { allProjects: true, statuses, includeSubagents: true, limit: 100, cursor });
    n += page.threads.length;
    cursor = page.nextCursor;
  }
  return n;
}

/**
 * Every thread (sub-agents included) updated since `since`, with its messages oldest first, written
 * to <outDir>/<n>.json as { thread, messages: [{ role, text }] }. Returns how many were written.
 */
export async function exportThreads(tools, since, outDir) {
  mkdirSync(outDir, { recursive: true });
  let written = 0;
  for (let cursor = 0; cursor !== null; ) {
    const page = await tools.call("t3_thread_list", { allProjects: true, includeSubagents: true, limit: 100, cursor });
    for (const t of page.threads) {
      if ((t.updatedAt ?? "") < since) continue;
      const messages = [];
      let thread = t;
      for (let after = -1; after !== null; ) {
        const read = await tools.call("t3_thread_read", { threadId: t.threadId, view: "messages", afterPosition: after, limit: 100, maxCharsPerItem: 20000 });
        thread = read.thread ?? thread;
        for (const it of read.items ?? []) {
          if (it.type !== "user_message" && it.type !== "assistant_message") continue;
          messages.push({ role: it.type === "user_message" ? "user" : "assistant", text: (it.text ?? "") + (it.textTruncated ? "\n[cut at 20,000 characters]" : "") });
        }
        after = read.hasMore && read.nextPosition !== undefined && read.nextPosition !== null && read.nextPosition !== after ? read.nextPosition : null;
      }
      written++;
      writeFileSync(join(outDir, `${written}.json`), JSON.stringify({ thread, messages }));
    }
    cursor = page.nextCursor;
  }
  return written;
}

export async function main(argv, env = process.env) {
  const baseDir = env.T3LIZARD_T3_BASE_DIR ?? join(homedir(), ".t3");
  const opts = {
    origin: env.T3LIZARD_T3_ORIGIN ?? "http://127.0.0.1:3773",
    t3: env.T3LIZARD_T3_CLI ?? "t3",
    baseDir,
    tokenFile: env.T3LIZARD_MCP_TOKEN_FILE ?? join(homedir(), ".t3lizard", "mcp-token"),
  };
  const [cmd, ...args] = argv;
  if (cmd === "configure") return configure(baseDir, args[0]);
  if (cmd === "scan") return { limited: await scan(await connect(opts)) };
  if (cmd === "continue") return continueThread(await connect(opts), args[0], args[1], args[2]);
  if (cmd === "busy") return { busy: await busy(await connect(opts)) };
  if (cmd === "export") return { written: await exportThreads(await connect(opts), args[0], args[1]) };
  throw new Error(`usage: accounts.mjs configure <file> | scan | continue <thread> <run> <account>`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then(
    (out) => out !== undefined && process.stdout.write(`${JSON.stringify(out)}\n`),
    (e) => {
      process.stderr.write(`${e.message}\n`);
      process.exitCode = 1;
    },
  );
}
