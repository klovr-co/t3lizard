import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCOUNTS_JS, busyThreads, configureFront, execPoll, execStart, FRONT_JS, install, pairAndLink, PREFLIGHT_SH, putFile, removePutFiles, resetCheckout, runRepoSetup, setupProject } from "../src/bringup.ts";
import { realLocalT3 } from "../src/t3local.ts";
import { FakeLizard, FakeT3, noSleep } from "./fakes.ts";

async function machine() {
  const lizard = new FakeLizard();
  const { id } = await lizard.create("github.com/acme/app", "small", 3_600_000);
  return { lizard, id, m: lizard.machines.get(id)!, r: { lizard, sleep: noSleep } };
}

test("install writes the secrets file with mode 600, waits for the install, then for t3 serve", async () => {
  const { r, id, m } = await machine();
  let polls = 0;
  r.lizard.on["install-poll"] = () => ({ stdout: ++polls < 3 ? "running\n" : "done\n", stderr: "", exitCode: 0 });
  let healthChecks = 0;
  r.lizard.on.health = () => ({ stdout: "", stderr: "", exitCode: ++healthChecks < 2 ? 7 : 0 });

  await install(r, id, { GH_TOKEN: "gh'x" }, "0.1.11", [{ id: "claudeAgent_acct1", token: "tok-1" }]);

  assert.deepEqual(m.files.get("env"), { content: "GH_TOKEN='gh'\\''x'\n", mode: "600" });
  assert.deepEqual(m.files.get("accounts.json"), { content: '[{"id":"claudeAgent_acct1","token":"tok-1"}]', mode: "600" }, "tokens go only to the account instances");
  assert.deepEqual(m.files.get("accounts.mjs"), { content: ACCOUNTS_JS, mode: "600" });
  assert.ok(m.steps.indexOf("accounts") < m.steps.indexOf("serve-start"), "accounts are configured before T3 starts");
  assert.match(m.files.get("install.sh")!.content, /T3CODE_VERSION="\$V"/);
  assert.match(m.files.get("supervise.sh")!.content, /flock -n 9 \|\| exit 0/);
  assert.deepEqual(m.files.get("front.mjs"), { content: FRONT_JS, mode: "600" });
  assert.equal(polls, 3);
  assert.deepEqual(m.steps.slice(-3), ["serve-start", "health", "health"]);
});

test("install configures Antigravity before serve-start when provided", async () => {
  const { r, id, m } = await machine();
  const tok = JSON.stringify({ token: { access_token: "a", refresh_token: "r" }, auth_method: "consumer" });
  await install(
    r,
    id,
    { GH_TOKEN: "x" },
    "0.1.12",
    [{ id: "claudeAgent_acct1", token: "tok-1" }],
    { label: id, size: "small" },
    { token: tok, defaultModel: "gemini-4-neon", makeDefault: true },
  );
  assert.deepEqual(
    JSON.parse(m.files.get("antigravity.json")!.content),
    { instanceId: "antigravity", token: tok, defaultModel: "gemini-4-neon", makeDefault: true },
  );
  assert.equal(m.files.get("antigravity.json")!.mode, "600");
  assert.ok(m.steps.indexOf("antigravity") > 0);
  assert.ok(m.steps.indexOf("antigravity") < m.steps.indexOf("serve-start"), "Antigravity is configured before T3 starts");
  assert.match(m.files.get("install.sh")!.content, /antigravity-cli-auto-updater/);
});

test("install reports the log when the install script failed", async () => {
  const { r, id } = await machine();
  r.lizard.on["install-poll"] = () => ({ stdout: "failed\ncurl: (6) Could not resolve host\n", stderr: "", exitCode: 0 });
  await assert.rejects(install(r, id, {}, "0.1.11", []), /install failed:\ncurl: \(6\)/);
});

test("serve-start supervises T3 on 127.0.0.1:3773 and the front proxy on 3774", async () => {
  const { r, id } = await machine();
  let started = "";
  const exec = r.lizard.exec.bind(r.lizard);
  r.lizard.exec = async (mid, cmd, ms) => {
    if (cmd[2].includes("# t3lizard:serve-start")) started = cmd[2];
    return exec(mid, cmd, ms);
  };
  await install(r, id, {}, "0.1.11", []);
  assert.match(started, /supervise\.sh" t3 t3 serve --host 127\.0\.0\.1 --port 3773 /, "T3 is reachable only through the front proxy");
  assert.match(started, /supervise\.sh" front node "\$D\/front\.mjs" 3774 3773 "\$D\/front-host"/);
});

test("configureFront writes the devbox Host for the front proxy and waits for it", async () => {
  const { r, id, m } = await machine();
  let checks = 0;
  r.lizard.on["front-health"] = () => ({ stdout: "", stderr: "", exitCode: ++checks < 3 ? 7 : 0 });
  assert.equal(await configureFront(r, id, 47305), "127.0.0.1:47305");
  assert.deepEqual(m.files.get("front-host"), { content: "127.0.0.1:47305\n", mode: "600" });
  assert.equal(checks, 3);
});

test("install stops at the preflight on an image without glibc and writes nothing", async () => {
  const { r, id, m } = await machine();
  r.lizard.on.preflight = () => ({ stdout: "", stderr: "no glibc on this image (Alpine Linux v3.24). T3 Code needs glibc", exitCode: 1 });
  await assert.rejects(install(r, id, { GH_TOKEN: "x" }, "0.1.11", []), /preflight failed \(exit 1\): no glibc on this image \(Alpine/);
  assert.deepEqual(m.steps, ["preflight"]);
  assert.equal(m.files.size, 0);
});

test("the preflight script passes on glibc and explains a musl image in a real shell", async () => {
  const { spawnSync } = await import("node:child_process");
  const ok = spawnSync("bash", ["-c", PREFLIGHT_SH], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^glibc \d/);

  const bin = mkdtempSync(join(tmpdir(), "t3lizard-musl-"));
  writeFileSync(join(bin, "getconf"), "#!/bin/sh\necho 'getconf: Unrecognized variable' >&2\nexit 1\n");
  chmodSync(join(bin, "getconf"), 0o755);
  const musl = spawnSync("bash", ["-c", PREFLIGHT_SH], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(musl.status, 1);
  assert.match(musl.stderr, /no glibc on this image .*set "template" in config\.json to a glibc template such as claude/);
});

test("setupProject returns the workspace path and T3 project id", async () => {
  const { r, id, m } = await machine();
  let args: string[] = [];
  r.lizard.on.project = (_m, a) => {
    args = a;
    return undefined;
  };
  assert.deepEqual(await setupProject(r, id, "github.com/acme/app"), {
    workspacePath: "/home/user/app",
    projectId: "11111111-2222-3333-4444-555555555555",
  });
  assert.deepEqual(args, ["https://github.com/acme/app.git", "app"]);
  assert.deepEqual(m.steps, ["project"]);
});

test("pairAndLink links the proxy URL with a fresh pairing code per attempt", async () => {
  const { r, id } = await machine();
  const t3 = new FakeT3();
  t3.failLinks = 2;
  const envId = await pairAndLink(r, t3, id, 47301);
  assert.equal(envId, "env-1");
  const link = t3.links.get("env-1")!;
  assert.equal(link.url, "http://127.0.0.1:47301");
  assert.equal(link.code, `pair-${id}-3`);
});

test("resetCheckout tells a missing ref apart from a broken machine", async () => {
  const { r, id } = await machine();
  assert.deepEqual(await resetCheckout(r, id, "/home/user/app", "main"), { ok: true });
  r.lizard.on.reset = () => ({ stdout: "", stderr: "fatal: couldn't find remote ref nope", exitCode: 10 });
  const bad = await resetCheckout(r, id, "/home/user/app", "nope");
  assert.equal(bad.ok, false);
  r.lizard.on.reset = () => ({ stdout: "", stderr: "disk full", exitCode: 1 });
  await assert.rejects(resetCheckout(r, id, "/home/user/app", "main"), /disk full/);
});

test("busyThreads counts only working threads", async () => {
  const { r, id } = await machine();
  r.lizard.threads = [{ status: "running" }, { status: "idle" }, { status: "waiting" }, { status: "completed" }];
  assert.equal(await busyThreads(r, id, "/home/user/app"), 2);
});

test("realLocalT3 parses version and link output from the t3 CLI", async () => {
  const dir = mkdtempSync(join(tmpdir(), "t3lizard-cli-"));
  const cli = join(dir, "t3");
  writeFileSync(
    cli,
    `#!/bin/sh
case "$1 $2" in
  "--version "*) echo "t3 v0.1.11-nightly.20261119.4928" ;;
  "environment link") echo "Linked lizard sb-1 (env-abc) with full-access access, until 2026-12-01T00:00:00Z." ;;
  "environment unlink") echo "Environment not found: $3" >&2; exit 1 ;;
esac
`,
  );
  chmodSync(cli, 0o755);
  const t3 = realLocalT3(cli);
  assert.equal(await t3.version(), "0.1.11-nightly.20261119.4928");
  assert.equal(await t3.link("http://127.0.0.1:47300", "code"), "env-abc");
  await t3.unlink("env-gone");
});

test("the reset and thread scripts work in a real shell against a real git repo", async () => {
  const { execFileSync, spawnSync } = await import("node:child_process");
  const { mkdirSync } = await import("node:fs");
  const { envFile } = await import("../src/bringup.ts");
  const home = mkdtempSync(join(tmpdir(), "t3lizard-home-"));
  const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, env: { ...process.env, HOME: home }, encoding: "utf8" });
  const origin = join(home, "origin");
  mkdirSync(origin);
  git(origin, "init", "-q", "-b", "main");
  git(origin, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "one");
  const ws = join(home, "app");
  git(home, "clone", "-q", origin, ws);
  git(origin, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "two");
  writeFileSync(join(ws, "stray.txt"), "x");

  mkdirSync(join(home, ".t3lizard"));
  writeFileSync(join(home, ".t3lizard", "env"), envFile({ GH_TOKEN: "a'b c$x" }));
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  const fakeT3 = join(home, ".local", "bin", "t3");
  writeFileSync(fakeT3, `#!/bin/sh\n[ "$GH_TOKEN" = 'a'"'"'b c$x' ] || exit 3\necho '[{"status":"running"},{"status":"idle"}]'\n`);
  chmodSync(fakeT3, 0o755);

  const lizard = new FakeLizard();
  lizard.exec = async (_id, cmd) => {
    const res = spawnSync(cmd[0], cmd.slice(1), { env: { HOME: home, PATH: process.env.PATH }, encoding: "utf8" });
    return { stdout: res.stdout, stderr: res.stderr, exitCode: res.status ?? 1 };
  };
  const r = { lizard, sleep: noSleep };

  assert.deepEqual(await resetCheckout(r, "sb", ws, "main"), { ok: true });
  assert.equal(git(ws, "log", "-1", "--format=%s").trim(), "two");
  assert.equal(spawnSync("test", ["-e", join(ws, "stray.txt")]).status, 1);
  assert.equal((await resetCheckout(r, "sb", ws, "no-such-branch")).ok, false);
  assert.equal(await busyThreads(r, "sb", ws), 1);
});

test("runRepoSetup runs the repo script in the checkout in a real shell: output, failure, timeout, no double run", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdirSync, readFileSync, existsSync } = await import("node:fs");
  const home = mkdtempSync(join(tmpdir(), "t3lizard-reposetup-"));
  const ws = join(home, "app");
  mkdirSync(ws);
  const lizard = new FakeLizard();
  lizard.exec = async (_id, cmd) => {
    const res = spawnSync(cmd[0], cmd.slice(1), { env: { HOME: home, PATH: process.env.PATH }, encoding: "utf8" });
    return { stdout: res.stdout, stderr: res.stderr, exitCode: res.status ?? 1 };
  };
  const r = { lizard, sleep: (ms: number) => new Promise<void>((res) => setTimeout(res, Math.min(ms, 50))) };
  const outputs: string[] = [];

  const ok = "#!/usr/bin/env bash\nset -euo pipefail\necho \"in $(pwd)\"\necho ran >> ran.txt\necho done-ok\n";
  await runRepoSetup(r, "sb", ws, ok, 30_000, (log) => outputs.push(log));
  assert.equal(outputs[0], `in ${ws}\ndone-ok\n`, "runs in the checkout; output goes to the caller");
  assert.equal(readFileSync(join(ws, "ran.txt"), "utf8"), "ran\n");
  await runRepoSetup(r, "sb", ws, ok, 30_000);
  assert.equal(readFileSync(join(ws, "ran.txt"), "utf8"), "ran\nran\n", "a second bring-up runs it again");

  const bad = "#!/usr/bin/env bash\nset -euo pipefail\nfor i in $(seq 1 40); do echo line-$i; done\nno-such-tool-xyz install\n";
  const err = await runRepoSetup(r, "sb", ws, bad, 30_000).catch((e) => e as Error);
  assert.match(err.message, /^repo setup failed \(exit 127\):\n/);
  assert.match(err.message, /no-such-tool-xyz: command not found$/);
  assert.doesNotMatch(err.message, /line-10\n/, "only the last lines are quoted");
  assert.match(err.message, /line-40/);

  const slow = "#!/usr/bin/env bash\necho starting\nsleep 30\n";
  const late = await runRepoSetup(r, "sb", ws, slow, 1_000).catch((e) => e as Error);
  assert.match(late.message, /^repo setup failed \(timed out after 1 s\):\nstarting$/);

  // A daemon restart while the script still runs: the second start only waits for the first.
  const counted = "#!/usr/bin/env bash\necho x >> runs.txt\nsleep 1\n";
  const first = runRepoSetup(r, "sb", ws, counted, 30_000);
  await new Promise((res) => setTimeout(res, 300));
  await runRepoSetup(r, "sb", ws, counted, 30_000);
  await first;
  assert.equal(readFileSync(join(ws, "runs.txt"), "utf8"), "x\n");
  assert.equal(existsSync(join(home, ".t3lizard", "repo-setup.sh")), true);
});

test("execStart saves the command as a script and runs it in the checkout under a timeout; execPoll reads the tail", async () => {
  const { r, id, m } = await machine();
  await execStart(r, id, "/home/user/app", "abc12345", "bun run typecheck\necho done", 600);
  assert.deepEqual(m.files.get("exec/abc12345.sh"), { content: "bun run typecheck\necho done", mode: "700" });
  assert.ok(m.steps.includes("exec-start"));
  r.lizard.execRunsFor = 1;
  r.lizard.execOutput = "line 1\nline 2\n";
  const running = await execPoll(r, id, "abc12345");
  assert.equal(running.status, "running");
  assert.equal(running.exitCode, undefined);
  r.lizard.execExit = 2;
  const done = await execPoll(r, id, "abc12345");
  assert.deepEqual({ status: done.status, exitCode: done.exitCode, output: done.output, truncated: done.truncated }, { status: "exited", exitCode: 2, output: "line 1\nline 2\n", truncated: false });
  await assert.rejects(execPoll(r, id, "nope"), /no exec nope/);
});

test("a running exec counts as work, so the lease cannot expire under it", async () => {
  const { r, id } = await machine();
  r.lizard.threads = [];
  r.lizard.execRunsFor = 5;
  await execStart(r, id, "/home/user/app", "e1", "sleep 1", 600);
  assert.equal(await busyThreads(r, id, "/home/user/app"), 1);
  r.lizard.execRunsFor = 0;
  assert.equal(await busyThreads(r, id, "/home/user/app"), 0);
});

test("putFile writes under the home folder in a real shell, with the mode, and never follows a link out", async () => {
  const home = mkdtempSync(join(tmpdir(), "t3lizard-put-"));
  const outside = mkdtempSync(join(tmpdir(), "t3lizard-out-"));
  symlinkSync(outside, join(home, "escape"));
  mkdirSync(join(home, "afolder"));
  // Runs each machine script in bash on this machine, with HOME at the temp folder.
  const lizard = new FakeLizard();
  lizard.exec = async (_id, cmd) => {
    try {
      const stdout = execFileSync(cmd[0], cmd.slice(1), { env: { HOME: home, PATH: process.env.PATH }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { stdout, stderr: "", exitCode: 0 };
    } catch (e) {
      const x = e as { status: number; stdout: string; stderr: string };
      return { stdout: x.stdout, stderr: x.stderr, exitCode: x.status };
    }
  };
  const r = { lizard, sleep: noSleep };
  const secret = "S3CRET-value\nline two\n";
  const b64 = Buffer.from(secret).toString("base64");

  const { path, rel } = await putFile(r, "sb-1", ".config/test-org/secrets.env", b64, "600");
  assert.ok(path.endsWith("/.config/test-org/secrets.env"));
  assert.equal(rel, ".config/test-org/secrets.env");
  assert.equal((await putFile(r, "sb-1", "top.env", b64, "600")).rel, "top.env", "a file right in home");
  // Through a link inside home, the resolved place is reported, so cleanup removes that one.
  symlinkSync(join(home, ".config"), join(home, "cfg"));
  assert.equal((await putFile(r, "sb-1", "cfg/via-link.env", b64, "600")).rel, ".config/via-link.env");
  assert.equal(readFileSync(path, "utf8"), secret);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(home, ".config/test-org")).mode & 0o777, 0o700, "new folders are private");

  await putFile(r, "sb-1", ".config/test-org/secrets.env", Buffer.from("v2").toString("base64"), "640");
  assert.equal(readFileSync(path, "utf8"), "v2");
  assert.equal(statSync(path).mode & 0o777, 0o640);

  await assert.rejects(putFile(r, "sb-1", "escape/x.env", b64, "600"), (e: Error) => /leaves the home folder/.test(e.message) && !e.message.includes(b64));
  assert.throws(() => readFileSync(join(outside, "x.env")));
  await assert.rejects(putFile(r, "sb-1", "afolder", b64, "600"), /is a folder/);

  // Cleanup removes the file, and never a file a link leads to outside home.
  writeFileSync(join(outside, "keep.txt"), "keep");
  writeFileSync(join(home, ".config/test-org/.t3lizard-put.AbC123"), "left by a killed write");
  await removePutFiles(r, "sb-1", [".config/test-org/secrets.env", "top.env", "escape/keep.txt", "never-written"]);
  assert.throws(() => readFileSync(path));
  assert.throws(() => readFileSync(join(home, "top.env")));
  assert.throws(() => readFileSync(join(home, ".config/test-org/.t3lizard-put.AbC123")), "temp files go too");
  assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "keep");
});
