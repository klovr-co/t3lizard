# t3lizard design

## Goal

Agent threads on the devbox send heavy work (build, full typecheck, pre-push gate, long tests) to Lizard (lizard.build) cloud sandboxes. Each sandbox runs a T3 Code server linked to the devbox's T3 Code as an environment, so a thread can `delegate_task` with `target: { environmentId, projectId }`. Machines come from a per-repo pool: at most 4 per repo, a FIFO queue when all are busy, and machines close when nothing needs them.

The T3 side follows the design of [t3boat](https://github.com/trevize-dev/t3boat), which does the same on boat.dev sandboxes: install T3 on the machine, pair it, and link it as an environment. The code here is our own.

## Why one daemon, not one MCP server per session

t3boat runs a copy inside every agent session (15-17 at once). Each copy tracks only the machines it created, so cleanup and limits break across sessions. t3lizard has one long-lived daemon that owns every machine, lease and queue. It is the only writer of state. MCP servers and the CLI are thin clients.

## Parts

1. `t3lizardd` daemon (systemd user unit, `Restart=always`). Owns state, runs the scheduler tick, runs the token proxies, talks to Lizard.
2. HTTP API on a unix socket `~/.t3lizard/daemon.sock` (JSON). Clients: the CLI and the MCP server.
3. `t3lizard` CLI: `daemon`, `acquire`, `wait`, `release`, `renew`, `status`, `close <machine>`, `doctor`.
4. `t3lizard-mcp` stdio MCP server with tools `pool_acquire`, `pool_wait`, `pool_release`, `pool_renew`, `pool_status`. Each call is one HTTP request to the daemon. No state in the MCP server.

## Data shapes (core types, decide these first)

```ts
type RepoKey = string            // normalized origin, e.g. "github.com/acme/webapp"
type MachineId = string          // Lizard sandbox id

type MachinePhase =
  | { kind: "creating" }                       // Lizard create called
  | { kind: "installing" }                     // install script running
  | { kind: "linking" }                        // proxy up, pairing + `t3 environment link`
  | { kind: "idle"; since: number }            // ready, no lease
  | { kind: "resetting"; ticketId: string }    // granted, checkout being reset to the ticket's ref
  | { kind: "leased"; leaseId: string }        // one job at a time
  | { kind: "closing" }                        // unlink + kill in progress
  | { kind: "failed"; error: string }          // reaped on the next tick

interface Machine {
  id: MachineId; repo: RepoKey; size: Size; createdAt: number; deadline: number;
  phase: MachinePhase;
  proxyPort?: number; hostname?: string; accessToken?: string;  // proxy 127.0.0.1:proxyPort -> https://hostname; proxyPort never changes for a machine
  frontHost?: string;                                            // Host the machine's front proxy gives T3: "127.0.0.1:<proxyPort>"
  environmentId?: string; projectId?: string; workspacePath?: string;
  limitedThreads?: LimitedThread[];   // last scan: threads stopped on a usage limit, waiting to continue
  continuedRuns?: string[];           // runs already continued, so a scan that raced a continue never repeats it
}

type AccountId = string           // a T3 provider instance on every machine: "claudeAgent_acct<N>"
interface AccountState { limitedUntil?: number }   // skipped until then, then tried again
interface LimitedThread { threadId: string; runId: string; account: AccountId }

interface Lease { id: string; machineId: MachineId; repo: RepoKey; ref: string; holder: string; grantedAt: number; expiresAt: number }

type Ticket =
  | { id: string; repo: RepoKey; ref: string; holder: string; enqueuedAt: number; status: "queued" }
  | { id: string; repo: RepoKey; ref: string; holder: string; enqueuedAt: number; status: "granted"; leaseId: string }
  | { id: string; repo: RepoKey; ref: string; holder: string; enqueuedAt: number; status: "cancelled" | "expired"; endedAt: number; error?: string }

interface State {
  machines: Record<MachineId, Machine>;
  leases: Record<string, Lease>;
  tickets: Ticket[];                            // FIFO order; queued tickets per repo served oldest first
  usage: Record<string /* UTC day */, number /* machine-seconds */>;
  usageAccruedAt?: number;                      // last time usage was added up
  createsPausedUntil?: number;                  // set from Lizard limit/payment errors
  lastLizardError?: { at: number; message: string; code?: string; url?: string };
  accounts?: Record<AccountId, AccountState>;
}
```

The `phase` union is the machine's state machine. No parallel booleans.

## Scheduler: a pure function

`plan(state, now, config) => Action[]` with no I/O. The daemon applies actions and writes state. Unit tests drive `plan` directly.

```ts
type Action =
  | { kind: "grant"; ticketId: string; machineId: MachineId }      // idle machine of the ticket's repo
  | { kind: "create"; repo: RepoKey }                              // queued ticket, no idle machine, repo count < perRepoCap, total < totalCap, budget left
  | { kind: "extend"; machineId: MachineId; deadline: number }   // leased or resetting machine near its Lizard deadline
  | { kind: "expireLease"; leaseId: string }                      // past expiresAt and the machine shows no busy thread (checked by the daemon before applying)
  | { kind: "close"; machineId: MachineId; reason: "idle" | "recycle" | "deadline" | "failed" | "orphan" | "manual" }
  | { kind: "expireTicket"; ticketId: string }                    // queued longer than ticketMaxWaitMinutes
  | { kind: "continueThread"; machineId: MachineId; threadId: string; runId: string; account: AccountId }  // limited thread, next free account
  | { kind: "extendLease"; leaseId: string; expiresAt: number }  // every account limited: keep the lease until one frees
```

Rules:
- Grant oldest queued ticket per repo first. One lease per machine.
- Count `creating | installing | linking` machines as capacity already coming, so a tick never over-creates.
- Count every machine in state toward the caps, `closing` and `failed` included: Lizard still runs them, and the trial refuses a second Small until the first is gone.
- Cross-repo: when a repo's queue is blocked only by `totalCap`, close an idle machine of a repo with no queue (reason `idle`) instead of waiting out `idleCloseMinutes`. A machine already `closing` counts as a slot on its way, so one tick never closes two for one ticket. Without this, on the trial (1 machine) a second repo waits up to 10 minutes behind an idle machine nobody wants.
- Never grant a machine within 5 minutes of its deadline.
- Close an idle machine when idle >= `idleCloseMinutes` AND the repo has no queued ticket.
- Recycle: close an idle machine older than `recycleMinutes`.
- Deadline: close any machine within 5 minutes of its Lizard deadline that is not leased; a leased (or resetting) one gets an `extend` action instead: the new deadline is `min(createdAt + maxLifetimeMinutes, deadline + lifetimeMinutes)`, applied with `setTimeout`. The trial caps lifetime at 1 hour from creation, so there `maxLifetimeMinutes = lifetimeMinutes` and nothing extends.
- Budget: no `create` when today's machine-hours >= `dailyMachineHours`. Queued tickets then wait for existing machines. `status` shows the reason.
- Accounts: a leased machine's limited thread gets `continueThread` on the next account after its own that is not limited, wrapping round to its own last. With none free, the machine waits for the account that frees first, plus 10 minutes (`ACCOUNT_WAIT_MARGIN_MS`): an `extendLease` when the lease ends sooner, an `extend` when the machine's deadline is sooner, and no `expireLease` meanwhile. It never waits past `createdAt + maxLifetimeMinutes` or past `dailyMachineHours` (counting the wait); then nothing is kept and `status` shows why.

## Lizard adapter

One module, `src/lizard.ts`, wraps `@lizard-build/sdk` (`Sandbox.create`, `Sandbox.connect`, `Sandbox.list({ projectId })`, `process.exec` with `timeoutMs` up to 600000, `fs.write`, `exposePort`, `setTimeout`, `kill`). Everything else depends on an interface, so tests use a fake.

- Create with template `config.template` (default `claude`: Debian 12, glibc, user `user`), `metadata: { t3lizard: "1", repo }`, `size` from config, `timeoutMs` = `lifetimeMinutes`. Not `base`: it is Alpine (musl), and the T3 binary needs glibc (it fails as `t3: not found`). No create-time `envs`: secrets go only to the machine's env file (step 1), so they live in one place with mode 600 and are not part of the sandbox's Lizard config. Every machine script sources that file.
- `config.project` must be the exact Lizard project id: `Sandbox.list` filters by `projectId`.
- Every exec runs as `config.sandboxUser` (default `user`, the template's unprivileged account), so `$HOME` is that user's home and the provider CLIs do not run as root.
- The adapter takes argv arrays only (`bash -c <script> t3lizard <args...>`), so refs, paths and secrets are passed as arguments and never spliced into shell text.
- Exec is capped at 600 s. Long steps (install) run in the background with `nohup ... > log 2>&1 &` and the daemon polls a done-marker file.
- Reconcile each tick: `Sandbox.list({ projectId })`, then keep sandboxes whose metadata has `t3lizard=1`. The real list rows carry no `metadata` (live test, 2026-11-20), so ownership comes from `getInfo()`, once per sandbox id (metadata is fixed at create, so the answer is cached). A sandbox whose `getInfo` fails is not ours that round, so a sandbox is never killed on doubt. Rows with status `stopped` or `crashed` are skipped.
- A sandbox Lizard has and state does not is an orphan: kill it (once; a listing that still shows it does not kill it again). A machine state has and the list does not is only gone when `getInfo` confirms it (`NotFoundError`, or status `stopped`/`crashed`): then unlink and drop it. A lagging list never drops a live machine.
- Errors: `LimitExceededError` (`SANDBOX_LIMIT_REACHED`, `SANDBOX_RATE_LIMITED` with `retryAfterS`, `WORKSPACE_SANDBOX_LIMIT`) pauses creates until the retry time; `PaymentRequiredError` stops creates and surfaces its message and url in `status`. Never retry in a tight loop.

## Machine bring-up (idempotent steps, each safe to re-run)

0. Preflight: fail at once with a clear message when the image has no glibc (`getconf GNU_LIBC_VERSION`) or lacks a tool the scripts need (curl, git, tar, gzip, flock, setsid, base64, sed, grep, awk).
1. Write `~/.t3lizard/env` on the machine (secrets: `GH_TOKEN`, others listed in config `forwardEnv`), mode 600. Claude account tokens never go there (see "Claude accounts"), even when `forwardEnv` lists them.
2. Install script: T3 Code at the devbox's exact version (`t3 --version` locally) via `https://t3.codes/install.sh`, Node 24 if missing, `claude` and `codex` CLIs if missing, `linkedEnvironmentsEnabled: true` in `~/.t3/userdata/settings.json`, git credential helper that reads `GH_TOKEN`. Ends by writing a done marker.
2b. Claude accounts: write `~/.t3lizard/accounts.json` (mode 600), then `node ~/.t3lizard/accounts.mjs configure` merges them into `~/.t3/userdata/settings.json` (mode 600) and deletes the file. Runs before `t3 serve` starts.
3. `supervise.sh <name> <cmd...>` keeps a command running (flock per name so only one runs, restart after 2 s, output in `~/.t3lizard/<name>.log`), started with nohup. Two are started: `t3 serve --host 127.0.0.1 --port 3773 --base-dir ~/.t3 --no-browser`, and the front proxy `node ~/.t3lizard/front.mjs 3774 3773 ~/.t3lizard/front-host` (see "Machine front proxy").
4. Clone the repo into `~/<repo-name>` from `https://<RepoKey>.git` (the git credential helper supplies `GH_TOKEN`), `t3 project add`, parse the project id and save it to `~/.t3lizard/project-id` on the machine. A re-run reads that file, since `t3 project add` has no list command to look the id up again.
5. `exposePort(3774)` (the front proxy, never T3 itself) -> hostname + access token. Start a local proxy on `127.0.0.1:<port>` (port range from config, stored in state) that forwards HTTP and WebSocket upgrades to `https://<hostname>` and adds header `X-Lizard-Access-Token`. Keep the token only in daemon memory and state (state file mode 600).
5b. Write `127.0.0.1:<proxyPort>` to `~/.t3lizard/front-host` on the machine (mode 600) and wait until T3 answers through the front proxy. Store it as `frontHost`.
6. `t3 auth pairing create --json` on the machine, then locally `t3 environment link http://127.0.0.1:<port> --pairing-code <code> --access full-access`, retry a few times while the route warms up. Store `environmentId`.

On daemon start: re-open proxies for every live machine from state before the first tick, so existing T3 links keep working. A proxy reopens only on its machine's own `proxyPort`, because both the devbox T3 link and the machine's `front-host` name that port. If the port is busy at start, each tick tries again on the same port.

## Machine front proxy

Found in the second live test (2026-11-20): `t3 environment link` failed with `PeerLinkError: This server only issues tokens for https://<name>.sandbox.us-east-1.onlizard.com/mcp`. The T3 server builds its origin from the request's Host (upgraded to https when `x-forwarded-proto: https`; it ignores `X-Forwarded-Host`). MCP OAuth requires `resource = <origin>/mcp`, and DPoP checks `htu` against the same origin. The devbox client signs for `http://127.0.0.1:<proxyPort>`, while Lizard's edge sends `Host: <name>.sandbox…onlizard.com` and `x-forwarded-proto: https`. The devbox proxy cannot change the Host, because the edge routes by Host, and `exposePort` always needs the access token, so the devbox cannot link to the onlizard URL directly.

So `src/machine/front.mjs` (plain JS, `node:` modules only, written to the machine at install) sits between the edge and T3:
- Listens on `0.0.0.0:3774`, the exposed port. T3 listens on `127.0.0.1:3773` only.
- Sets `Host` to the contents of `~/.t3lizard/front-host` (`127.0.0.1:<proxyPort>`), read per connection, so a change needs no restart. It answers 503 until the file exists.
- Drops `Forwarded`, `X-Forwarded-Proto`, `-Host`, `-Port`, `-Prefix`, `-For`, `X-Real-IP` and `X-Lizard-Access-Token`. T3 then builds `http://127.0.0.1:<proxyPort>`, the URL the devbox signs for. The Lizard token never reaches T3.
- Passes WebSocket upgrades as raw byte pipes and streams responses (SSE) as they come, with no server timeouts.

## Claude accounts

Goal: an agent on a machine does not die when one Claude account hits its 5-hour limit. Accounts are the secrets `CLAUDE_CODE_OAUTH_TOKEN` (account 1) and `CLAUDE_CODE_OAUTH_TOKEN_<N>`. Account N is the provider instance `claudeAgent_acct<N>` on every machine, and that id is the account's name everywhere (`state.accounts`, `status`, the lease).

How an instance gets its own token (read from the T3 0.1.11 bundle). A provider instance has an `environment` list, `[{ name, value, sensitive }]`, that T3 merges over the server's env (`mergeProviderInstanceEnvironment`) for the Claude process, the SDK adapter, the capability probe and account detection. The other options are weaker: `binaryPath` could point at a wrapper that exports the token, but T3's own calls would not see it; a token in `<homePath>/settings.json` `env` reaches only the Claude CLI; and a separate `homePath` per account changes the continuation key (`claude:home:<path>`), so a switch would hand over a summary instead of resuming the session. So each instance gets only `environment: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", value, sensitive: true }]` and no `homePath`: all accounts share `~/.claude`, and T3's switch policy (`decideProviderSessionTransition`) resumes the same Claude session on the other account (`restart_and_resume`). `sensitive` keeps the value out of what clients, the linked devbox included, are shown. Environment values stay in `settings.json`; T3 moves only `field` secrets to its secret store. The plain `claudeAgent` instance is disabled, so no thread runs on whatever auth the machine has.

`autoResumeLimitedThreads` stays off. T3's resume fires only while the limited run is still the thread's latest, so it does not interfere when t3lizard continues on another account. But when every account is limited, both would resume the same thread: T3 on its own account at that account's reset, t3lizard on whichever account frees first. One writer is simpler.

How t3lizard switches a thread (read from the bundle, then run against the real T3 0.1.11 binary on a scratch base dir with fake tokens). The CLI's `t3 thread` has only `list`, `start`, `send` and `show`; `send` cannot change the provider. The MCP tool `t3_thread_configure` with `modelSelection: { ...current, instanceId }` dispatches `provider.switch`. MCP refuses any change to a thread whose runtime mode is above the caller's, and delegated threads run `full-access`. A token from `t3 auth session issue --subject mcp-client` gets `approval-required`. So `accounts.mjs` signs in through T3's MCP OAuth flow: `t3 auth session issue --ttl 5m` gives a local bearer that may approve; then `POST /oauth/mcp/register`, `/oauth/mcp/approval` (gives a csrf token), `/oauth/mcp/decision` with `{ _tag: "browser-session", access: "full-access", csrfToken }`, and `/oauth/mcp/token` with PKCE. The 30-day token is cached in `~/.t3lizard/mcp-token` (mode 600) and replaced once if refused.

The loop:
- Each tick, each leased machine is scanned at most once a minute: `accounts.mjs scan` lists failed threads (`t3_thread_list`) and reads the latest run's activity (`t3_thread_read`, `view: "activity"`). A run counts as limited when one of its items says "usage limit reached" (T3's notice) or "You've hit your … limit" (Claude's reply). A plain "rate limit reached" error does not. Runs requested before the lease began belong to an earlier holder and are ignored.
- A newly limited run marks its account limited for `accountRetryMinutes` (default 30). t3lizard does not parse the reset time from the notice: an account that is still limited when tried again just fails at once and is skipped again.
- `plan()` emits `continueThread`. `accounts.mjs continue` re-reads the thread and stops if its latest run moved on; otherwise it switches the instance (keeping model and options) and sends "Continue where you left off." with `clientRequestId: t3lizard-continue-<runId>`, so a retry is not sent twice. A failed continue is retried after a minute.
- Lease release or expiry drops the machine's `limitedThreads` and `continuedRuns`.

The lease view's `providerInstanceId` is the first free account, else the one that frees first. Agents pass it in `delegate_task`'s target.

## Lease hand-out (grant)

Before a lease is returned, the daemon moves the machine to `resetting` and resets its checkout to the ticket's ref: `git fetch origin <ref> && git checkout --force --detach FETCH_HEAD && git clean -ffd` (keeps ignored files such as node_modules for a warm cache). The ref must already be pushed. A failed `git fetch` is the ticket's fault (ref not pushed): the ticket is `cancelled` with the error and the machine goes back to `idle`. Any other reset failure marks the ticket `cancelled` and the machine `failed`. On daemon start a `resetting` machine goes back to `idle` and its ticket, still `queued`, is granted again on the next tick.

Release: the client calls `release(leaseId)`. A crashed client: the lease expires after `leaseMinutes` (default 90, `renew` extends it), and only if the machine's T3 shows no busy thread (statuses preparing, queued, starting, running, waiting via `t3 thread list --json`).

## API (unix socket, JSON)

- `POST /acquire { repo, ref, holder }` -> `{ ticketId, status: "granted", lease: { leaseId, environmentId, projectId, workspacePath, machineId } }` or `{ ticketId, status: "queued", position, reason? }`
- `POST /wait { ticketId, maxSeconds <= 300 }` -> same shape; long-poll, returns early on grant
- `POST /release { leaseId } | { ticketId }`: ends a lease, or cancels a queued ticket (an agent that stops waiting), `POST /renew { leaseId }`
- `/wait` on a ticket whose lease ended answers `status: "released"`; a cancelled or expired ticket answers its status and `error`.
- `GET /status` -> pools per repo (machines with phase, age, limited threads and how long they wait for an account; queue; leases), today's machine-hours vs budget, why creates are blocked, last Lizard error, and `accounts: [{ id, free, limitedUntil? }]`
- A granted lease carries `providerInstanceId`, the Claude account to delegate to.
- `POST /close { machineId }`

`repo` given as an origin URL or a path to a local checkout (daemon reads `git remote get-url origin`). The key keeps the owner and repo case as the origin has it.

`/acquire` waits (up to 2 minutes) only when it granted an idle machine at once, so the caller gets the lease after the checkout reset. Otherwise it answers `queued` at once.

## Daemon internals

- A `create` action first inserts a `pending:<uuid>` machine in phase `creating`, so the next tick counts it, then swaps in the Lizard id. On restart a leftover `pending:` machine is dropped; if Lizard did create it, reconcile kills it as an orphan.
- Reconcile is skipped while a create is in flight or finished during the list call, so a fresh sandbox is never mistaken for an orphan.
- Each background operation (create, bring-up, grant, extend, lease check, close) is keyed so the same one never runs twice at once. After each await it re-reads the machine and stops if the phase moved on (a close or reconcile won).
- A failed bring-up marks the machine `failed` and closes it at once.
- Create circuit breaker (live test, 2026-11-20: a machine dropped right after create made the daemon create 7 sandboxes in 90 s). Every create that Lizard answers is kept in `state.creates` (24 h) as `pending`, then `ready` (reached idle) or `lost` (bring-up failed, vanished at Lizard, or closed before ready). `plan()` reads it:
  - Backoff: after N machines in a row (any repo) that never became ready, no creates for 2, 5, then 15 minutes (`CREATE_BACKOFF_MINUTES`) after the last loss. One ready machine resets the count.
  - Hourly cap: at most `createsPerRepoPerHour` (default 3) creates per repo in any rolling hour, short-lived ones included. One tick never plans past it.
  - Both show as the queued ticket's `reason` and in `status`.
  - A Lizard create error is not a create (no machine was made); it pauses creates as before.
- Usage: each create adds `createChargeMinutes` (default 10) to the UTC day's bucket at once, so a loop of short-lived machines still runs into `dailyMachineHours`. Each tick (and each close) then adds every machine's time since `usageAccruedAt`, skipping its first `createChargeMinutes`. Machines bill while the daemon is down, so that time counts too.
- Ended tickets are pruned after an hour, granted ones a day after their lease ends.

## Config `~/.t3lizard/config.json`

```json
{
  "project": "<lizard project id>",
  "template": "claude",
  "size": "small",
  "perRepoCap": 4,
  "totalCap": 1,
  "idleCloseMinutes": 10,
  "recycleMinutes": 240,
  "lifetimeMinutes": 60,
  "maxLifetimeMinutes": 60,
  "leaseMinutes": 90,
  "ticketMaxWaitMinutes": 60,
  "dailyMachineHours": 20,
  "createsPerRepoPerHour": 3,
  "createChargeMinutes": 10,
  "proxyPortRange": [47300, 47399],
  "forwardEnv": ["GH_TOKEN"],
  "accountRetryMinutes": 30
}
```

Trial defaults shown (trial: 1 small machine at a time, 1 hour lifetime). `totalCap` defaults to 1 because the trial refuses a second Small (403 `TRIAL_SIZE_RUNNING`); raise it after the first payment. Two more keys: `sandboxUser` (default `"user"`) and `tickSeconds` (default 15). `T3LIZARD_HOME` overrides `~/.t3lizard`. Secrets live in `~/.t3lizard/secrets.env` (mode 600): `LIZARD_API_KEY`, the forwarded env, and the Claude accounts `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN_2`, ... Never log secret values.

## Files

- `~/.t3lizard/state.json`: written by the daemon only, atomic (write temp + rename), mode 600.
- `~/.t3lizard/daemon.log`
- `systemd/t3lizard.service` user unit (not installed by the build).

## Stack

Node 24 runs `.ts` files directly (type stripping), so no build step. Use only erasable TypeScript (no enums, no parameter properties, no namespaces). Tests: `node --test`. Dependencies: `@lizard-build/sdk@1.0.22`, `@modelcontextprotocol/sdk`, `zod`. No proxy library: node `http`, `https`, `tls` and `net` are enough.

## Out of scope for v1

Snapshot/restore for faster starts, multiple jobs per machine, the xstack skill and CLAUDE.md changes, the monitor change.
