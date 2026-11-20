import { readFileSync } from "node:fs";
import type { ExecResult, Lizard } from "./lizard.ts";
import type { LocalT3 } from "./t3local.ts";
import type { AccountId, LimitedThread, MachineId, RepoKey } from "./types.ts";

/** T3 Code on the machine. Bound to 127.0.0.1: only the front proxy reaches it. */
export const T3_PORT = 3773;
/** The machine front proxy. This is the port Lizard exposes. */
export const FRONT_PORT = 3774;
/** On the machine: what the front proxy sets as Host, i.e. the devbox proxy's 127.0.0.1:<port>. */
export const FRONT_HOST_FILE = "front-host";
export const FRONT_JS = readFileSync(new URL("./machine/front.mjs", import.meta.url), "utf8");
export const ACCOUNTS_JS = readFileSync(new URL("./machine/accounts.mjs", import.meta.url), "utf8");
/** T3 thread statuses that mean an agent is still working on the machine. */
export const BUSY_STATUSES: ReadonlySet<string> = new Set(["waiting", "running", "starting", "queued", "preparing"]);

const INSTALL_TIMEOUT_MS = 25 * 60_000;
const HEALTH_TIMEOUT_MS = 3 * 60_000;

/** Every machine-side step is a bash script whose first line names the step. */
function script(step: string, body: string, ...args: string[]): string[] {
  const prelude = [
    `# t3lizard:${step}`,
    "set -euo pipefail",
    'D="$HOME/.t3lizard"',
    'export PATH="$HOME/.local/bin:$D/node/bin:$PATH"',
    'if [ -f "$D/env" ]; then set -a; . "$D/env"; set +a; fi',
  ];
  return ["bash", "-c", [...prelude, body].join("\n"), "t3lizard", ...args];
}

export const INSTALL_SH = `#!/usr/bin/env bash
# t3lizard machine install. Safe to run again. $1 is the exact T3 Code version.
set -euo pipefail
V="$1"
D="$HOME/.t3lizard"
exec 9>"$D/install.lock"
flock -n 9 || exit 0
trap 'echo "install failed at line $LINENO" > "$D/install.failed"' ERR
export PATH="$HOME/.local/bin:$D/node/bin:$PATH"
if [ -f "$D/env" ]; then set -a; . "$D/env"; set +a; fi

have="$(t3 --version 2>/dev/null || true)"; have="\${have#t3 v}"
if [ "$have" != "$V" ]; then
  echo "installing t3 $V"
  curl -fsSL https://t3.codes/install.sh | T3CODE_VERSION="$V" T3CODE_INSTALL_BIN_DIR="$HOME/.local/bin" sh
fi

major="$(node -v 2>/dev/null | sed -n 's/^v\\([0-9]*\\).*/\\1/p' || true)"
if [ "$major" = "" ] || [ "$major" -lt 22 ]; then
  echo "installing node 24"
  arch=x64
  if [ "$(uname -m)" = aarch64 ]; then arch=arm64; fi
  mkdir -p "$D/node"
  curl -fsSL "https://nodejs.org/dist/v24.11.1/node-v24.11.1-linux-$arch.tar.gz" | tar -xz -C "$D/node" --strip-components=1
fi

npm_g() { npm install -g --prefix "$HOME/.local" --no-fund --no-audit "$@"; }
command -v claude >/dev/null || npm_g @anthropic-ai/claude-code
command -v codex >/dev/null || npm_g @openai/codex || echo "codex install failed, continuing"

mkdir -p "$HOME/.t3/userdata"
node -e '
const fs = require("fs"); const f = process.argv[1];
let s = {}; try { s = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
s.linkedEnvironmentsEnabled = true;
fs.writeFileSync(f + ".tmp", JSON.stringify(s, null, 2)); fs.renameSync(f + ".tmp", f);
' "$HOME/.t3/userdata/settings.json"

git config --global credential.helper '!f() { test "$1" = get && echo username=x-access-token && echo "password=$GH_TOKEN"; }; f'

rm -f "$D/install.failed"
echo "$V" > "$D/install.done"
echo "install done"
`;

/**
 * Keeps one long-running command alive: `supervise.sh <name> <cmd...>`. A second copy for the same
 * name exits at once (flock), so starting it again is safe. Output goes to $D/<name>.log.
 */
export const SUPERVISE_SH = `#!/usr/bin/env bash
D="$HOME/.t3lizard"
name="$1"; shift
exec 9>"$D/$name.lock"
flock -n 9 || exit 0
export PATH="$HOME/.local/bin:$D/node/bin:$PATH"
if [ -f "$D/env" ]; then set -a; . "$D/env"; set +a; fi
while true; do
  "$@" >> "$D/$name.log" 2>&1 9>&- || true
  echo "$name exited, restarting" >> "$D/$name.log"
  sleep 2
done
`;

const START_SUPERVISED = [
  `setsid nohup bash "$D/supervise.sh" t3 t3 serve --host 127.0.0.1 --port ${T3_PORT} --base-dir "$HOME/.t3" --no-browser > /dev/null 2>&1 < /dev/null &`,
  `setsid nohup bash "$D/supervise.sh" front node "$D/front.mjs" ${FRONT_PORT} ${T3_PORT} "$D/${FRONT_HOST_FILE}" > /dev/null 2>&1 < /dev/null &`,
].join("\n");

export interface Remote {
  lizard: Lizard;
  sleep(ms: number): Promise<void>;
  log?(line: string): void;
}

async function run(r: Remote, id: MachineId, cmd: string[], timeoutMs?: number): Promise<ExecResult> {
  const res = await r.lizard.exec(id, cmd, timeoutMs);
  if (res.exitCode !== 0) {
    const step = cmd[2].match(/# t3lizard:([\w-]+)/)?.[1] ?? "step";
    throw new Error(`${step} failed (exit ${res.exitCode}): ${(res.stderr || res.stdout).trim().slice(-2000)}`);
  }
  return res;
}

function writeFile(r: Remote, id: MachineId, name: string, content: string, mode: string) {
  const body = [
    'mkdir -p "$D" && chmod 700 "$D"',
    'printf %s "$2" | base64 -d > "$D/$1.tmp"',
    'chmod "$3" "$D/$1.tmp"',
    'mv "$D/$1.tmp" "$D/$1"',
  ].join("\n");
  return run(r, id, script("write", body, name, Buffer.from(content).toString("base64"), mode));
}

export function envFile(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}='${v.replace(/'/g, `'\\''`)}'\n`)
    .join("");
}

async function pollUntil(r: Remote, timeoutMs: number, everyMs: number, check: () => Promise<boolean>, what: string) {
  for (let waited = 0; waited <= timeoutMs; waited += everyMs) {
    if (await check()) return;
    await r.sleep(everyMs);
  }
  throw new Error(`${what} did not finish in ${Math.round(timeoutMs / 60_000)} minutes`);
}

/**
 * Fails fast, with a clear message, on an image the install cannot work on. The T3 binary needs
 * glibc: on musl (Alpine, Lizard's `base` template) it fails as "t3: not found". The install
 * script itself needs flock and setsid, and would otherwise hang until its poll times out.
 */
export const PREFLIGHT_SH = `if ! getconf GNU_LIBC_VERSION > /dev/null 2>&1; then
  os="$(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || echo "unknown OS")"
  echo "no glibc on this image ($os). T3 Code needs glibc: set \\"template\\" in config.json to a glibc template such as claude" >&2
  exit 1
fi
missing=""
for tool in curl git tar gzip flock setsid timeout base64 sed grep awk; do
  command -v "$tool" > /dev/null || missing="$missing $tool"
done
if [ -n "$missing" ]; then echo "missing tools on this image:$missing" >&2; exit 1; fi
echo "$(getconf GNU_LIBC_VERSION) $(uname -m)"`;

/** Swap per machine size, in MB. A mini (2 GB, no swap) otherwise freezes outright on a heavy job. */
export const SWAP_MB: Record<string, number> = { nano: 1024, mini: 2048, small: 2048, medium: 4096, large: 4096, big: 4096 };

/**
 * Best-effort machine prep, as root where sudo works, before T3 starts:
 * - the label T3 shows for this environment (PRETTY_HOSTNAME; every Lizard machine is "e2b.local"),
 * - a swap file where the kernel allows one (Lizard's does not today),
 * - guard.sh, which keeps T3, the front proxy and their supervisors at high priority and last in
 *   line for the OOM killer, and kills the largest job process when memory is almost gone, so the
 *   machine slows a job down or fails one command instead of freezing (logged in ~/.t3lizard/guard.log).
 * Never fails the bring-up: a machine without sudo still works, it just keeps the default label.
 */
export const PREP_SH = `label="$1"; swap_mb="$2"; uid="$(id -u)"
if ! sudo -n true 2>/dev/null; then
  mkdir -p "$HOME/.local/bin"
  printf '#!/bin/sh\\n[ "$1" = --pretty ] && exec cat "%s/label"\\nexit 1\\n' "$D" > "$HOME/.local/bin/hostnamectl"
  chmod 755 "$HOME/.local/bin/hostnamectl"; printf '%s\\n' "$label" > "$D/label"
  echo "no sudo: label through a hostnamectl shim, no swap or guard"; exit 0
fi
printf 'PRETTY_HOSTNAME="%s"\\n' "$label" | sudo tee /etc/machine-info > /dev/null
if [ "$swap_mb" -gt 0 ] && ! sudo grep -q '^/swapfile ' /proc/swaps; then
  if [ ! -f /swapfile ]; then
    free_mb="$(df -Pm / | awk 'NR==2 {print $4}')"
    if [ "\${free_mb:-0}" -gt $((swap_mb * 3)) ]; then
      sudo fallocate -l "\${swap_mb}M" /swapfile 2>/dev/null || sudo dd if=/dev/zero of=/swapfile bs=1M count="$swap_mb" status=none
      sudo chmod 600 /swapfile && sudo env PATH="/usr/sbin:/sbin:$PATH" mkswap /swapfile > /dev/null
    fi
  fi
  # Lizard's kernel refuses swap today; drop the file then, so it does not hold disk for nothing.
  [ -f /swapfile ] && { sudo env PATH="/usr/sbin:/sbin:$PATH" swapon /swapfile 2>/dev/null || { echo "swapon refused"; sudo rm -f /swapfile; }; }
fi
sudo setsid nohup bash "$D/guard.sh" "$uid" "$D/guard.log" > /dev/null 2>&1 < /dev/null &
echo "prep done: $(grep -c . /proc/swaps) swap line(s)"`;

/** Runs as root. Protects T3's own processes; their children (agents, builds) are reset to normal. */
export const GUARD_SH = `#!/usr/bin/env bash
# Every 2 s: keep T3's own processes protected (their children reset to normal), and when memory is
# almost gone, kill the largest other non-root process before the machine freezes. Lizard machines
# have no swap, so a full machine thrashes for minutes before the kernel OOM killer acts.
exec 9>/run/t3lizard-guard.lock
flock -n 9 || exit 0
uid="$1"; log="$2"
peakf="\${log%/*}/mem-peak"
total_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
floor_kb=$(awk '/MemTotal/ {f = int($2 / 20); print (f < 153600 ? 153600 : f)}' /proc/meminfo)
while true; do
  prot=" $(pgrep -f 't3 serve --host 127\\.0\\.0\\.1|front\\.mjs|supervise\\.sh|t3lizard-guard|/usr/bin/envd' | tr '\\n' ' ') "
  for p in $(pgrep -u "$uid"); do
    f="/proc/$p/oom_score_adj"
    [ -w "$f" ] || continue
    if [[ "$prot" == *" $p "* ]]; then
      echo -900 > "$f" 2>/dev/null; renice -n -5 -p "$p" > /dev/null 2>&1
    else
      a="$(cat "$f" 2>/dev/null)"; [ "\${a:-0}" -lt 0 ] && echo 0 > "$f" 2>/dev/null
      n="$(ps -o ni= -p "$p" 2>/dev/null | tr -d ' ')"; [ "\${n:-0}" -lt 0 ] 2>/dev/null && renice -n 0 -p "$p" > /dev/null 2>&1
    fi
  done
  avail_kb=$(awk '/MemAvailable/ {print $2}' /proc/meminfo)
  # Highest memory use (percent) since the daemon last reset mem-peak: it reads and zeroes it per lease.
  used_pct=$(( (total_kb - avail_kb) * 100 / total_kb ))
  peak=$(cat "$peakf" 2>/dev/null || echo 0)
  if [ "$used_pct" -gt "\${peak:-0}" ] 2>/dev/null; then echo "$used_pct" > "$peakf"; chown "$uid" "$peakf" 2>/dev/null; fi
  if [ "$avail_kb" -lt "$floor_kb" ]; then
    victim=$(ps -eo pid=,uid=,rss= --sort=-rss | awk -v prot="$prot" '$2 != 0 && index(prot, " " $1 " ") == 0 {print $1; exit}')
    if [ -n "$victim" ]; then
      what="$(ps -o rss=,args= -p "$victim" | cut -c1-160)"
      kill -9 "$victim" 2>/dev/null && echo "$(date -u +%FT%TZ) memory low ($((avail_kb / 1024)) MB free): killed $victim: $what" >> "$log"
    fi
  fi
  sleep 2
done
`;

/** What T3 shows for the machine, e.g. "t3lizard aldrent · arrow-universe-1yxp (mini)". */
export function machineLabel(repo: RepoKey, id: MachineId, size: string): string {
  return `t3lizard ${repo.split("/").pop()} · ${id} (${size})`;
}

export interface Account {
  id: AccountId;
  token: string;
}

/**
 * Steps 1-3: secrets, install, Claude accounts, `t3 serve` supervisor. Each step converges when re-run.
 * Account tokens never go to the env file: each lives only in its own T3 provider instance.
 */
export async function install(
  r: Remote,
  id: MachineId,
  secrets: Record<string, string>,
  t3Version: string,
  accounts: Account[],
  machine: { label: string; size: string } = { label: id, size: "small" },
): Promise<void> {
  await run(r, id, script("preflight", PREFLIGHT_SH));
  await writeFile(r, id, "env", envFile(secrets), "600");
  await writeFile(r, id, "install.sh", INSTALL_SH, "700");
  await writeFile(r, id, "supervise.sh", SUPERVISE_SH, "700");
  await writeFile(r, id, "front.mjs", FRONT_JS, "600");
  await writeFile(r, id, "accounts.mjs", ACCOUNTS_JS, "600");
  await writeFile(r, id, "guard.sh", GUARD_SH, "755");

  await run(
    r,
    id,
    script(
      "install-start",
      'rm -f "$D/install.failed"\nif ! grep -qxF "$1" "$D/install.done" 2>/dev/null; then setsid nohup bash "$D/install.sh" "$1" > "$D/install.log" 2>&1 < /dev/null & fi',
      t3Version,
    ),
  );
  const poll = script(
    "install-poll",
    'if grep -qxF "$1" "$D/install.done" 2>/dev/null; then echo done\nelif [ -f "$D/install.failed" ]; then echo failed; tail -n 30 "$D/install.log"\nelse echo running; fi',
    t3Version,
  );
  await pollUntil(r, INSTALL_TIMEOUT_MS, 10_000, async () => {
    const out = (await run(r, id, poll)).stdout;
    if (out.startsWith("failed")) throw new Error(`install failed:\n${out.slice("failed".length).trim()}`);
    return out.startsWith("done");
  }, "install");

  if (accounts.length) {
    await writeFile(r, id, "accounts.json", JSON.stringify(accounts), "600");
    await run(r, id, script("accounts", 'node "$D/accounts.mjs" configure "$D/accounts.json"'));
  }
  // Before serve-start: T3 reads its label once, when it starts.
  const prep = await r.lizard.exec(id, script("prep", PREP_SH, machine.label, String(SWAP_MB[machine.size] ?? 2048)), 300_000);
  if (prep.exitCode !== 0) r.log?.(`machine ${id}: prep failed (continuing): ${(prep.stderr || prep.stdout).trim().slice(-300)}`);
  await run(r, id, script("serve-start", START_SUPERVISED));
  const health = script("health", `curl -fsS -m 5 http://127.0.0.1:${T3_PORT}/.well-known/t3/environment > /dev/null`);
  await pollUntil(r, HEALTH_TIMEOUT_MS, 3_000, async () => (await r.lizard.exec(id, health, 30_000)).exitCode === 0, "t3 serve start");
}

/**
 * Gives a running machine the current account list. T3 reloads settings.json while it runs, so
 * an account added to the secrets works on the machine without a restart (live test, 2026-11-21).
 */
export async function pushAccounts(r: Remote, id: MachineId, accounts: Account[]): Promise<void> {
  await writeFile(r, id, "accounts.mjs", ACCOUNTS_JS, "600");
  await writeFile(r, id, "accounts.json", JSON.stringify(accounts), "600");
  await run(r, id, script("accounts", 'node "$D/accounts.mjs" configure "$D/accounts.json"'));
}

export function cloneUrl(repo: RepoKey): string {
  return `https://${repo}.git`;
}

/** Step 4: clone the repo and register it with the machine's T3. Returns its path and T3 project id. */
export async function setupProject(r: Remote, id: MachineId, repo: RepoKey): Promise<{ workspacePath: string; projectId: string }> {
  const body = `dir="$HOME/$2"
if [ ! -d "$dir/.git" ]; then git clone "$1" "$dir"; fi
idf="$D/project-id"
if [ ! -s "$idf" ]; then
  out="$(t3 project add "$dir" --base-dir "$HOME/.t3" 2>&1)" || { echo "$out" >&2; exit 1; }
  printf '%s\\n' "$out" | grep -oE 'Added project [0-9a-f-]{36}' | awk '{print $3}' > "$idf.tmp" || true
  if [ ! -s "$idf.tmp" ]; then echo "no project id in: $out" >&2; exit 1; fi
  mv "$idf.tmp" "$idf"
fi
echo "WORKSPACE=$dir"
echo "PROJECT=$(cat "$idf")"`;
  const name = repo.split("/").pop() ?? "repo";
  const out = (await run(r, id, script("project", body, cloneUrl(repo), name), 600_000)).stdout;
  const kv = Object.fromEntries(out.split("\n").flatMap((l) => (l.includes("=") ? [l.split(/=(.*)/s).slice(0, 2)] : [])));
  if (!kv.WORKSPACE || !kv.PROJECT) throw new Error(`project setup printed no workspace or project id: ${out.trim()}`);
  return { workspacePath: kv.WORKSPACE, projectId: kv.PROJECT };
}

/** How much of the setup output reaches the daemon log, and how much of it a failure quotes. */
const SETUP_LOG_BYTES = 64 * 1024;
const SETUP_FAIL_LINES = 25;

/**
 * Step 4b: the repo's own setup script (~/.t3lizard/repos/<owner>/<name>/setup.sh on the devbox),
 * run in the checkout as the sandbox user. An exec is capped at 10 minutes, so it runs in the
 * background under a lock and `timeout`, and this polls for its exit code. A second start while
 * one runs (a daemon restart) only polls. Returns the output; a non-zero exit throws with its
 * last lines, so the bring-up fails and the create backoff applies.
 */
export async function runRepoSetup(
  r: Remote,
  id: MachineId,
  workspacePath: string,
  setupScript: string,
  timeoutMs: number,
  onOutput: (log: string) => void = () => {},
): Promise<void> {
  await writeFile(r, id, "repo-setup.sh", setupScript, "700");
  const seconds = String(Math.ceil(timeoutMs / 1000));
  const start = `exec 9>"$D/repo-setup.lock"
if ! flock -n 9; then echo "already running"; exit 0; fi
rm -f "$D/repo-setup.exit" "$D/repo-setup.log"
cd "$1"
setsid nohup bash -c 'timeout -k 10 "$1" bash "$2/repo-setup.sh" > "$2/repo-setup.log" 2>&1 9>&-; echo $? > "$2/repo-setup.exit.tmp"; mv "$2/repo-setup.exit.tmp" "$2/repo-setup.exit"' repo-setup "$2" "$D" < /dev/null > /dev/null 2>&1 &`;
  await run(r, id, script("repo-setup-start", start, workspacePath, seconds));
  const poll = script("repo-setup-poll", 'if [ -f "$D/repo-setup.exit" ]; then echo "exit=$(cat "$D/repo-setup.exit")"; else echo running; fi');
  let exit = -1;
  // The machine-side timeout stops the script; the devbox waits a minute longer for its exit code.
  await pollUntil(r, timeoutMs + 60_000, Math.min(5_000, Math.max(500, timeoutMs / 20)), async () => {
    const m = (await run(r, id, poll)).stdout.match(/^exit=(\d+)/);
    if (m) exit = Number(m[1]);
    return !!m;
  }, "repo setup");
  const log = (await run(r, id, script("repo-setup-log", `tail -c ${SETUP_LOG_BYTES} "$D/repo-setup.log" 2>/dev/null || true`))).stdout;
  onOutput(log);
  if (exit !== 0) {
    const limit = timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)} minutes` : `${Math.round(timeoutMs / 1000)} s`;
    const why = exit === 124 || exit === 137 ? `timed out after ${limit}` : `exit ${exit}`;
    const tail = log.trimEnd().split("\n").slice(-SETUP_FAIL_LINES).join("\n");
    throw new Error(`repo setup failed (${why}):\n${tail}`);
  }
}

/**
 * Step 5b: tell the machine's front proxy which Host to give T3: the devbox proxy's exact
 * 127.0.0.1:<port>, the URL the devbox links to. T3 builds its origin from Host, and MCP OAuth
 * (resource) and DPoP (htu) only pass when that origin equals the URL the devbox client signs.
 * Waits until T3 answers through the front proxy.
 */
export async function configureFront(r: Remote, id: MachineId, devboxPort: number): Promise<string> {
  const host = `127.0.0.1:${devboxPort}`;
  await writeFile(r, id, FRONT_HOST_FILE, `${host}\n`, "600");
  const health = script("front-health", `curl -fsS -m 5 http://127.0.0.1:${FRONT_PORT}/.well-known/t3/environment > /dev/null`);
  await pollUntil(r, HEALTH_TIMEOUT_MS, 3_000, async () => (await r.lizard.exec(id, health, 30_000)).exitCode === 0, "front proxy start");
  return host;
}

/** Step 6: pair the machine's T3 with the local one through the proxy. Retries while the route warms up. */
export async function pairAndLink(r: Remote, t3: LocalT3, id: MachineId, proxyPort: number, attempts = 5): Promise<string> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const out = (await run(r, id, script("pair", 't3 auth pairing create --base-dir "$HOME/.t3" --json --ttl 10m --label "$1"', `t3lizard ${id}`))).stdout;
      const code = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)).credential;
      if (typeof code !== "string") throw new Error(`no pairing credential in: ${out.trim()}`);
      return await t3.link(`http://127.0.0.1:${proxyPort}`, code);
    } catch (e) {
      last = e;
      if (i < attempts - 1) await r.sleep(5_000);
    }
  }
  throw last;
}

export type ResetResult = { ok: true } | { ok: false; badRef: string };

/** Point the checkout at `ref` before a lease is handed out. Keeps ignored files (node_modules) warm. */
export async function resetCheckout(r: Remote, id: MachineId, workspacePath: string, ref: string): Promise<ResetResult> {
  const body = 'cd "$1"\ngit fetch origin "$2" || exit 10\ngit checkout --force --detach FETCH_HEAD\ngit clean -ffd';
  const res = await r.lizard.exec(id, script("reset", body, workspacePath, ref), 600_000);
  if (res.exitCode === 10) return { ok: false, badRef: `cannot fetch ${ref}: ${res.stderr.trim().slice(-500)}` };
  if (res.exitCode !== 0) throw new Error(`reset failed (exit ${res.exitCode}): ${(res.stderr || res.stdout).trim().slice(-2000)}`);
  return { ok: true };
}

/**
 * The machine's T3 threads updated since `sinceIso`, each with its messages (t3 thread show --json),
 * as one gzipped tar in base64. Saved on the devbox before the machine is gone.
 */
export async function exportThreads(r: Remote, id: MachineId, workspacePath: string, sinceIso: string): Promise<Buffer> {
  // A machine brought up by an older t3lizard has an accounts.mjs without `export`.
  await writeFile(r, id, "accounts.mjs", ACCOUNTS_JS, "600");
  const body = `out="$D/export"; rm -rf "$out"; mkdir -p "$out"
node "$D/accounts.mjs" export "$2" "$out" > /dev/null
tar -C "$out" -czf - . | base64 -w0`;
  const out = (await run(r, id, script("export", body, workspacePath, sinceIso), 180_000)).stdout.trim();
  return Buffer.from(out, "base64");
}

/** How many of the machine's T3 threads are still working. */
export async function busyThreads(r: Remote, id: MachineId, workspacePath: string): Promise<number> {
  // The CLI's list leaves sub-agent threads out, and every delegated job is one: ask T3's MCP tools.
  const viaMcp = await r.lizard.exec(id, script("busy", 'node "$D/accounts.mjs" busy'), 120_000);
  const m = viaMcp.exitCode === 0 ? viaMcp.stdout.match(/"busy":(\d+)/) : null;
  if (m) return Number(m[1]);
  const out = (await run(r, id, script("threads", 't3 thread list --json --project "$1" --base-dir "$HOME/.t3"', workspacePath))).stdout;
  const rows = JSON.parse(out.trim() || "[]") as { status?: unknown }[];
  return rows.filter((t) => BUSY_STATUSES.has(String(t.status))).length;
}

/** Threads on the machine whose latest run failed on a usage limit, with the account it ran on. */
export async function scanLimits(r: Remote, id: MachineId): Promise<(LimitedThread & { notice: string; requestedAt: string })[]> {
  const out = (await run(r, id, script("scan", 'node "$D/accounts.mjs" scan'), 120_000)).stdout;
  return JSON.parse(out.trim()).limited;
}

/** Moves a limited thread to `account` and sends "continue". Skips a thread that moved on from `runId`. */
export async function continueOnAccount(r: Remote, id: MachineId, t: LimitedThread): Promise<{ skipped?: string }> {
  const out = (await run(r, id, script("continue", 'node "$D/accounts.mjs" continue "$1" "$2" "$3"', t.threadId, t.runId, t.account), 120_000)).stdout;
  return JSON.parse(out.trim());
}
