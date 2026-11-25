# xstack-cloud

xstack-cloud (formerly t3lizard) gives [T3 Code](https://t3.codes) agent threads a T3 Code environment on a cloud machine:
[InstaBox](https://instabox.sh) or [Lizard](https://lizard.build), chosen by `provider` in the config.
Agents use it for heavy work: builds, full typechecks, pre-push gates and long test runs.
The old `t3lizard` and `t3lizard-mcp` commands still work, as aliases.
Source: https://github.com/klovr-co/xstack-cloud

One daemon owns every machine, lease and queue.
The CLI and the MCP server are thin clients. Each call is one request to the daemon.

Each repo has its own pool.
A pool holds at most `perRepoCap` machines (default 4). All pools together use a size ladder: by default 1 medium and 2 small on InstaBox, 1 small and 2 mini on Lizard.
When every machine is busy, requests wait in a FIFO queue.
A machine that stays idle for `idleCloseMinutes` closes, but only when nothing is queued.

Agents on a machine use several Claude accounts in turn.
When a thread hits one account's usage limit, xstack-cloud continues it on the next account.
When every account is limited, the thread waits, and the machine is kept until an account frees.

See [DESIGN.md](DESIGN.md) for the full design.

## Install

You need Node 24 and the T3 Code CLI (`t3`) on the devbox.

```sh
git clone https://github.com/klovr-co/xstack-cloud ~/t3lizard
cd ~/t3lizard
npm install
mkdir -m 700 -p ~/.t3lizard
```

The checkout stays at `~/t3lizard` and the data at `~/.t3lizard`: the systemd unit and the xstack plugin's MCP entry use those paths.
Write the config and the secrets file (see below). Then check them:

```sh
bin/xstack-cloud doctor
```

Run the daemon as a systemd user service:

```sh
cp systemd/xstack-cloud.service ~/.config/systemd/user/
# Edit the node path and T3LIZARD_T3_CLI in the copy first.
systemctl --user daemon-reload
systemctl --user enable --now xstack-cloud
journalctl --user -u xstack-cloud -f
```

`T3LIZARD_T3_CLI` must point at the local `t3` binary.
systemd does not see your shell PATH, and an npx cache path can change.
Install `t3` somewhere stable and use `which t3` to find it.

For a quick run without systemd: `bin/xstack-cloud daemon`.

## Config

The config file is `~/.t3lizard/config.json`. Every key is optional, except `project` on Lizard.

On InstaBox:

```json
{
  "provider": "instabox",
  "sizes": [{ "size": "medium", "max": 4 }, { "size": "small", "max": 4 }],
  "execConcurrency": 24
}
```

On Lizard, with more keys:

```json
{
  "provider": "lizard",
  "project": "<lizard project id>",
  "template": "claude",
  "sizes": [{ "size": "small", "max": 1 }, { "size": "mini", "max": 2 }],
  "perRepoCap": 4,
  "idleCloseMinutes": 10,
  "recycleMinutes": 240,
  "lifetimeMinutes": 60,
  "maxLifetimeMinutes": 60,
  "leaseMinutes": 90,
  "ticketMaxWaitMinutes": 60,
  "dailySmallMachineHours": 20,
  "createsPerRepoPerHour": 20,
  "createChargeMinutes": 10,
  "proxyPortRange": [47300, 47399],
  "forwardEnv": ["GH_TOKEN"],
  "sandboxUser": "user",
  "tickSeconds": 15,
  "accountRetryMinutes": 30,
  "setupTimeoutMinutes": 20
}
```

- `provider` is `lizard` (the default, so older configs are unchanged) or `instabox`.
- `template` must be a glibc image. The default is `agent-browser` (Debian 13) on InstaBox and `claude` (Debian 12) on Lizard. Lizard's `base` template is Alpine (musl), and T3 Code does not run there. Bring-up checks this first and fails with a clear message.
- InstaBox has three sizes: small (2 vCPU, 4 GiB), medium (4, 8 GiB) and large (8, 16 GiB). A config with another size is refused.
- `releaseIdleMinutes` (default 5, 0 to turn off): once every thread and command on a leased machine has finished, the lease is released after this many minutes, as if its holder had released it. A lease on which nothing has run yet is kept for 15 minutes, then released the same way.
- `execConcurrency` (InstaBox only, default 24, at most 64) is how many commands the daemon runs on machines at once. A Pro workspace allows 64 across every daemon on it; the free plan 32.
- `sandboxTag` (default `t3lizard`) marks this daemon's machines. Two daemons on one account need different tags, or each kills the other's machines as orphans.
- `sizes` is the size ladder: at most `max` machines of each size at once. A ticket that needs a new machine gets the largest size with room. The oldest ticket gets the largest idle machine. The lease and `status` show the size.
- `dailySmallMachineHours` is a hard budget, in small-machine-hours. An hour of a small machine counts 1, a medium 2, a mini 0.5, a nano 0.25 (both providers price sizes in this ratio). The daemon creates no machine once today's total (UTC) reaches it.
- Each create counts at least `createChargeMinutes` (times its weight) against that budget, even when the machine lives for seconds.
- Older configs still load. `size` and `totalCap` become `sizes: [{ "size": ..., "max": totalCap }]`. `dailyMachineHours` is the older name of `dailySmallMachineHours`.
- `createsPerRepoPerHour` caps creates per repo in any rolling hour.
- When a machine never becomes ready (bring-up fails, or it vanishes), creates back off for 2, then 5, then 15 minutes. One machine that becomes ready resets this. The reason shows on the queued ticket and in `status`.
- `lifetimeMinutes` is a machine's first deadline. Near it, a leased machine is extended up to `maxLifetimeMinutes`. An idle one closes. Lizard enforces the deadline. InstaBox cannot extend one, so the daemon closes machines itself, and InstaBox deletes each machine `maxLifetimeMinutes` + 30 minutes after create in case the daemon is down.
- `leaseMinutes` is how long a lease lives without `renew`. A lease only expires when the machine's T3 shows no busy thread.
- `accountRetryMinutes` is how long a Claude account that hit its usage limit is skipped. Then it is tried again.
- `T3LIZARD_HOME` moves `~/.t3lizard` somewhere else. Keep the path short: the socket path must fit in 107 bytes.

## Secrets

Secrets live in `~/.t3lizard/secrets.env`. It must be mode 600.

```sh
INSTABOX_API_KEY=...             # provider instabox
LIZARD_API_KEY=...               # provider lizard
GH_TOKEN=...
CLAUDE_CODE_OAUTH_TOKEN=...      # Claude account 1
CLAUDE_CODE_OAUTH_TOKEN_2=...    # account 2; add _3, _4 for more
```

The provider's API key stays on the devbox.
The keys listed in `forwardEnv` go to each machine, in `~/.t3lizard/env` (mode 600).
`GH_TOKEN` lets the machine clone and fetch the repo.

Each Claude token becomes its own T3 provider instance on every machine: `claudeAgent_acct1`, `claudeAgent_acct2`, and so on.
An instance holds only its own token. No Claude token goes to the machine-wide env file.
The plain `claudeAgent` instance is turned off on machines.
New accounts reach machines created after a daemon restart.
The daemon never logs secret values.

The daemon keeps each machine's port access token in `state.json`, which is mode 600.

### A secret for one job: `xstack-cloud put`

Some jobs need a login or an `.env` file that other repos' machines must never get, for example a staging sign-in.
Do not add those to `forwardEnv`: that sends them to every machine.
Instead, the lease holder writes the file onto its own leased machine:

```sh
infisical export --format=dotenv ... | xstack-cloud put <leaseId> ~/.config/app/secrets.env
xstack-cloud put <leaseId> ~/<repo>/apps/app/.env.local --mode 640 < apps/app/.env.local
```

- It reads the content from stdin, so the value never shows in a command line, a tool argument or a transcript.
- Only a live lease's id works.
- The daemon removes every file `put` wrote when the lease ends, and hands the machine to the next job only after that works. If the removal fails, the machine is closed.
- Files the job makes from them (a browser state with session cookies, say) are not removed. The job deletes them before the lease ends.
- The path must be under the machine's home: `~/x`, `<home>/x` or `x`. Home is `/data/home` on InstaBox and `/home/user` on Lizard. A relative path is under home, not the checkout: for a file in the checkout, give `lease.workspacePath` plus the file. A `..` part, or a symlink that leads out, is refused.
- The file is written to a temp file with umask 077, given the mode (default `600`; a mode that gives others any access, or a setuid bit, is refused), then moved into place. At most 64 KB.
- The daemon logs the path, the size and the holder, never the content. The content is not saved in `state.json`, and no answer or error quotes it.
- There is no MCP tool for this on purpose: a tool argument is saved in the agent's transcript.

## How agents use it

Register the MCP server with each agent:

```sh
claude mcp add xstack-cloud -- ~/t3lizard/bin/xstack-cloud-mcp.py
```

`bin/xstack-cloud-mcp.py` is plain Python (about 12 MB per agent session). `bin/xstack-cloud-mcp` is the same server in Node.

The MCP server gives agents these instructions:

1. Push the commit you want to test. The machine checks out the ref, so it must exist on origin.
2. Call `pool_acquire` with `repo` (origin URL or a local checkout path), `ref` and `holder`.
   You get a lease, or a queue ticket with a position and a reason.
3. While queued, call `pool_wait` with the ticket id. Each call waits 30 seconds by default (at most 300). Keep it short: messages to the agent only arrive between tool calls.
4. When granted, call `delegate_task` with `target: { environmentId, projectId, providerInstanceId }` from the lease, and a Claude model.
   `providerInstanceId` is the Claude account to use: the first one not limited.
   Do not ask for a worktree. The lease is a whole machine, already checked out at your ref.
   If the thread stops on a usage limit, keep the lease. xstack-cloud continues the same thread on another account.
5. Call `pool_release` with the lease id as soon as the work is done.

6. When a job fails because a tool or system package is missing, call `pool_setup_add` with one install line and a reason.
   The next machine for that repo then has it. Then install it by hand on the current machine and carry on.

Other tools: `pool_renew` extends a lease. `pool_status` shows pools, queues, leases, budget, and each Claude account with `limitedUntil`.

## Per-repo machine setup

Each repo can have a setup script on the devbox: `~/.t3lizard/repos/<owner>/<name>/setup.sh`.
Bring-up runs it on every new machine for that repo, as user `user`, in the checkout, after the clone.
The machine is handed out only after it succeeds.

- Every step must be safe to run twice. Guard installs, for example `command -v bun >/dev/null || ...`.
- It stops after `setupTimeoutMinutes` (default 20). Its output goes to the daemon log.
- A failure fails the bring-up and quotes the script's last lines. The create backoff then applies.
- Put new binaries in `~/.local/bin`. That folder is on PATH for T3 threads.

Add, show and remove steps:

```sh
xstack-cloud setup add github.com/klovr-co/aldrent --reason "needs jq" -- 'command -v jq >/dev/null || sudo -n apt-get install -y jq'
xstack-cloud setup show github.com/klovr-co/aldrent
xstack-cloud setup remove github.com/klovr-co/aldrent 3
```

Each step gets a comment with the date and the reason. `history.jsonl` next to the script records every add and remove.
A change applies to machines created after it.
`examples/repos/klovr-co/aldrent/setup.sh` is the seeded aldrent script: bun from the official install script.

## When a Claude account hits its limit

Once a minute, the daemon checks each leased machine for threads whose last run stopped on a usage limit.
It marks that account limited for `accountRetryMinutes` and continues the thread on the next account that is not limited.
The thread keeps its context: all accounts share one Claude home, so T3 resumes the same session.

When every account is limited, the thread waits for the account that frees first.
The lease and the machine are kept until then, plus 10 minutes.
They are never kept past `maxLifetimeMinutes` or past the daily budget. `status` shows the reason when that stops a wait.

T3's own `autoResumeLimitedThreads` stays off on machines, so only xstack-cloud resumes threads.
To switch a thread's account, the machine helper signs in to its T3 as a full-access MCP client.
The `t3` CLI cannot change a thread's account. See DESIGN.md, "Claude accounts".

## CLI

```text
xstack-cloud daemon                          run the daemon
xstack-cloud acquire <repo> <ref> [--holder <name>]
xstack-cloud wait <ticketId> [--max <seconds>]
xstack-cloud release <leaseId|ticketId>
xstack-cloud renew <leaseId>
xstack-cloud status
xstack-cloud close <machineId>
xstack-cloud doctor
xstack-cloud setup add <repo> [--reason <why>] -- <shell line>
xstack-cloud setup show <repo>
xstack-cloud setup remove <repo> <step>
```

Each command prints JSON from the daemon. `t3lizard` is an alias of `xstack-cloud`.

## Provider limits

InstaBox Pro runs up to 100 machines at once. Measured on the account:
- Tested live (2026-11-25): exec with `argv`, an 87 KB argument sent through stdin, a 330 s command with keepalive, a lease from a template in 41 s and from a snapshot in 21 s, and the T3 link and a delegated thread on the machine.

- 64 commands at once per Pro workspace (32 on the free plan). Over it InstaBox answers 429 `quota_exceeded`; the daemon waits and retries for about a minute.
- 30 machine starts a minute. Over it InstaBox answers 429 `rate_limited`; creates pause until its Retry-After.
- A command runs at most 10 minutes.
- A snapshot takes about 3.5 minutes to build. A machine starts from one in about 6 s.
- Machines run in AWS us-west-2.

The Lizard trial runs 1 small, 2 mini and 2 nano machines at once, each for at most one hour.
One more of a size fails with 403 `TRIAL_SIZE_RUNNING`.
So the default ladder is 1 small and 2 mini, with `lifetimeMinutes: 60` and `maxLifetimeMinutes: 60`.
Nano (0.5 vCPU, 1 GB) is left out: it is too small for builds.
After the first payment, add `medium` or raise the counts, and raise `maxLifetimeMinutes`.

## Tests

```sh
node --test
```

Every test uses a fake provider, a fake InstaBox HTTP API and a fake local `t3`.
The fake provider answers like Lizard's API: its list rows have no metadata, and `getInfo` does. No test makes a network call or touches `~/.t3`.

## Not proven yet

These need a live test with a real API key:

- a real usage limit: the scan's match on the notice text, the switch, and that the agent that delegated the thread gets the continued run's result;
- whether `t3 environment link` accepts an `http://127.0.0.1:<port>` URL;
- the bring-up script on a real Lizard machine;
- the proxy against Lizard's real HTTPS and WebSocket route, through the machine's front proxy;

## How a machine is reached

```text
devbox T3 --> 127.0.0.1:<port> (xstack-cloud proxy, adds the port token: Lizard header or InstaBox cookie)
          --> https://<port>-<name>.instabox.tech or https://<name>.sandbox...onlizard.com (provider edge)
          --> machine :3774 (front proxy: Host = 127.0.0.1:<port>, forwarded headers and token dropped)
          --> machine 127.0.0.1:3773 (T3)
```

T3 builds its own URL from the Host header. Its sign-in checks only pass when that URL is the one the devbox linked to.
So the front proxy gives T3 the devbox URL.
Each machine keeps its devbox port for its whole life, also across daemon restarts.

## Migrating from t3lizard

The data dir (`~/.t3lizard`), the `T3LIZARD_*` env vars and the machine tag are unchanged, so a running pool carries over.

1. `git pull` in `~/t3lizard`. The repo is now https://github.com/klovr-co/xstack-cloud.
2. Re-register the MCP server: `claude mcp remove t3lizard`, then `claude mcp add xstack-cloud -- ~/t3lizard/bin/xstack-cloud-mcp.py`. The old paths still run.
3. Swap the unit: `systemctl --user disable --now t3lizard`, install `systemd/xstack-cloud.service` as above, `systemctl --user enable --now xstack-cloud`.
4. To move to InstaBox, let `status` show no machines first, then set `"provider": "instabox"` and add `INSTABOX_API_KEY`. A daemon that switches with Lizard machines in its state forgets them without killing them; Lizard ends them at their deadline.

## Another machine

One daemon runs on each computer that runs T3. Lease machines link to that computer's T3, so a teammate cannot `delegate_task` through another computer's daemon.
Several daemons can share one InstaBox account:

1. `git clone https://github.com/klovr-co/xstack-cloud ~/t3lizard`, then `npm install`. The xstack plugin's MCP entry runs `~/t3lizard/bin/xstack-cloud-mcp.py`.
2. Install Node 24 and the `t3` CLI.
3. Write `~/.t3lizard/config.json` with `"provider": "instabox"` and a `sandboxTag` no other daemon uses. Two daemons with one tag kill each other's machines.
4. Split the account's limits: `execConcurrency` so all daemons sum to 64 at most (24 each for two leaves headroom), and each size's `max` so all daemons together run at most 100 machines.
5. Add the secrets: `INSTABOX_API_KEY` (from Infisical, or your own key), `GH_TOKEN`, the Claude tokens, and a git identity for commits made on machines (`GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL`, listed in `forwardEnv`).
6. Install the systemd unit (see Install). It reads the Infisical project id from `~/.t3lizard/systemd.env` (`INFISICAL_PROJECT_ID=<id>`). Then run `bin/xstack-cloud doctor`.
7. Update the xstack plugin to get the MCP tools.

## Credits

xstack-cloud is modelled on [t3boat](https://github.com/trevize-dev/t3boat), which runs T3 Code work on boat.dev sandboxes.
The T3 bring-up (install, pairing, `t3 environment link`) and the idle cleanup follow its design.
The code is written from scratch.
xstack-cloud adds a shared daemon with a per-repo pool and queue, a token proxy for private ports, Claude account rotation and a daily budget.

## License

MIT. See [LICENSE](LICENSE).
