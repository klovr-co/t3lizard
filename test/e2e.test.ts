import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const run = promisify(execFile);
const root = join(import.meta.dirname, "..");

test("the CLI and the MCP server drive a daemon running on fakes", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "t3lizard-e2e-"));
  const env = { ...process.env, T3LIZARD_HOME: home };
  const daemon = spawn(process.execPath, [join(root, "scripts/fake-daemon.ts")], { env, stdio: "ignore" });
  t.after(() => daemon.kill("SIGTERM"));
  for (let i = 0; i < 100 && !existsSync(join(home, "daemon.sock")); i++) await new Promise((r) => setTimeout(r, 50));

  const cli = async (...args: string[]) => JSON.parse((await run(join(root, "bin/t3lizard"), args, { env })).stdout);
  const queued = await cli("acquire", "https://github.com/acme/app.git", "main", "--holder", "e2e");
  assert.equal(queued.status, "queued");
  const granted = await cli("wait", queued.ticketId, "--max", "20");
  assert.equal(granted.status, "granted");
  assert.equal(granted.lease.providerInstanceId, "claudeAgent_acct1");
  assert.equal((await cli("status")).pools["github.com/acme/app"].leases[0].holder, "e2e");
  const put = (stdin: string, ...args: string[]) =>
    new Promise<any>((resolve, reject) => {
      const c = execFile(join(root, "bin/t3lizard"), ["put", ...args], { env }, (e, out) => (e ? reject(e) : resolve(JSON.parse(out))));
      c.stdin!.end(stdin);
    });
  const putOut = await put("A_SECRET=value\n", granted.lease.leaseId, "~/.config/app/secrets.env", "--mode", "600");
  assert.deepEqual(putOut, { path: "/home/user/.config/app/secrets.env", bytes: 15, mode: "600" });
  assert.deepEqual(await cli("release", granted.lease.leaseId), { released: true });
  await assert.rejects(put("x", granted.lease.leaseId, "~/x"), /no lease/);

  const raw = async (...args: string[]) => (await run(join(root, "bin/t3lizard"), args, { env })).stdout;
  const added = await cli("setup", "add", "https://github.com/acme/app.git", "--reason", "needs bun", "--", "command", "-v", "bun", ">/dev/null", "||", "curl -fsSL https://bun.sh/install | bash");
  assert.equal(added.added, true);
  assert.equal(added.steps[0].line, "command -v bun >/dev/null || curl -fsSL https://bun.sh/install | bash");
  const shown = await raw("setup", "show", "https://github.com/acme/app.git");
  assert.match(shown, /^github\.com\/acme\/app: .*repos\/acme\/app\/setup\.sh\n\n1\. \d{4}-\d{2}-\d{2}: needs bun \(cli:/);

  const client = new Client({ name: "e2e", version: "0" });
  await client.connect(new StdioClientTransport({ command: join(root, "bin/t3lizard-mcp"), env: env as Record<string, string> }));
  t.after(() => client.close());
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((x) => x.name).sort(), ["pool_acquire", "pool_exec", "pool_exec_wait", "pool_release", "pool_renew", "pool_setup_add", "pool_status", "pool_wait"]);
  assert.match(client.getInstructions() ?? "", /fails because a tool or system package is missing, add the install step with\s+pool_setup_add/);
  const viaSetup = await client.callTool({ name: "pool_setup_add", arguments: { repo: "https://github.com/acme/app.git", line: "command -v jq >/dev/null || sudo -n apt-get install -y jq", reason: "jq missing in e2e", holder: "mcp" } });
  const setupOut = JSON.parse((viaSetup.content as { text: string }[])[0].text);
  assert.equal(setupOut.added, true);
  assert.equal(setupOut.step, 2);
  assert.match(client.getInstructions() ?? "", /delegate_task with target \{ environmentId, projectId, providerInstanceId \}/);
  const viaMcp = await client.callTool({ name: "pool_acquire", arguments: { repo: "https://github.com/acme/app.git", ref: "main", holder: "mcp" } });
  const lease = JSON.parse((viaMcp.content as { text: string }[])[0].text);
  assert.equal(lease.status, "granted", "the idle machine is granted at once");
  const released = await client.callTool({ name: "pool_release", arguments: { leaseId: lease.lease.leaseId } });
  assert.deepEqual(JSON.parse((released.content as { text: string }[])[0].text), { released: true });
});
