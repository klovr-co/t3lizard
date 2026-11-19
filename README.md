# t3lizard

t3lizard gives [T3 Code](https://t3.codes) agent threads a T3 Code environment on a [Lizard](https://lizard.build) cloud machine.
Agents use it for heavy work: builds, full typechecks, pre-push gates and long test runs.

One daemon owns every machine, lease and queue.
The CLI and the MCP server are thin clients. Each call is one request to the daemon.

Each repo has its own pool.
A pool holds at most `perRepoCap` machines (default 4), and all pools together hold at most `totalCap`.
When every machine is busy, requests wait in a FIFO queue.
A machine that stays idle for `idleCloseMinutes` closes, but only when nothing is queued.

Agents on a machine use several Claude accounts in turn.
When a thread hits one account's usage limit, t3lizard continues it on the next account.
When every account is limited, the thread waits, and the machine is kept until an account frees.

See [DESIGN.md](DESIGN.md) for the full design.

## Install

You need Node 24 and the T3 Code CLI (`t3`) on the devbox.

```sh
cd ~/t3lizard
npm install
mkdir -m 700 -p ~/.t3lizard
```

Write the config and the secrets file (see below). Then check them:

```sh
bin/t3lizard doctor
```

Run the daemon as a systemd user service:

```sh
cp systemd/t3lizard.service ~/.config/systemd/user/
# Edit the node path and T3LIZARD_T3_CLI in the copy first.
systemctl --user daemon-reload
systemctl --user enable --now t3lizard
journalctl --user -u t3lizard -f
```

`T3LIZARD_T3_CLI` must point at the local `t3` binary.
systemd does not see your shell PATH, and an npx cache path can change.
Install `t3` somewhere stable and use `which t3` to find it.

For a quick run without systemd: `bin/t3lizard daemon`.

## Config

The config file is `~/.t3lizard/config.json`. Every key is optional except `project`.

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
  "sandboxUser": "user",
  "tickSeconds": 15,
  "accountRetryMinutes": 30
}
```

- `template` must be a glibc image. The default, `claude`, is Debian 12. Lizard's `base` template is Alpine (musl), and T3 Code does not run there. Bring-up checks this first and fails with a clear message.
- `dailyMachineHours` is a hard budget. The daemon creates no machine once today's machine-hours (UTC) reach it.
- Each create counts at least `createChargeMinutes` against that budget, even when the machine lives for seconds.
- `createsPerRepoPerHour` caps creates per repo in any rolling hour.
- When a machine never becomes ready (bring-up fails, or it vanishes), creates back off for 2, then 5, then 15 minutes. One machine that becomes ready resets this. The reason shows on the queued ticket and in `status`.
- `lifetimeMinutes` is the Lizard timeout set at create. Near the deadline, a leased machine is extended up to `maxLifetimeMinutes`. An idle one closes.
- `leaseMinutes` is how long a lease lives without `renew`. A lease only expires when the machine's T3 shows no busy thread.
- `accountRetryMinutes` is how long a Claude account that hit its usage limit is skipped. Then it is tried again.
- `T3LIZARD_HOME` moves `~/.t3lizard` somewhere else. Keep the path short: the socket path must fit in 107 bytes.

## Secrets

Secrets live in `~/.t3lizard/secrets.env`. It must be mode 600.

```sh
LIZARD_API_KEY=...
GH_TOKEN=...
CLAUDE_CODE_OAUTH_TOKEN=...      # Claude account 1
CLAUDE_CODE_OAUTH_TOKEN_2=...    # account 2; add _3, _4 for more
```

`LIZARD_API_KEY` stays on the devbox.
The keys listed in `forwardEnv` go to each machine, in `~/.t3lizard/env` (mode 600).
`GH_TOKEN` lets the machine clone and fetch the repo.

Each Claude token becomes its own T3 provider instance on every machine: `claudeAgent_acct1`, `claudeAgent_acct2`, and so on.
An instance holds only its own token. No Claude token goes to the machine-wide env file.
The plain `claudeAgent` instance is turned off on machines.
New accounts reach machines created after a daemon restart.
The daemon never logs secret values.

The daemon keeps each machine's Lizard access token in `state.json`, which is mode 600.

## How agents use it

Register the MCP server with each agent:

```sh
claude mcp add t3lizard -- ~/t3lizard/bin/t3lizard-mcp
```

The MCP server gives agents these instructions:

1. Push the commit you want to test. The machine checks out the ref, so it must exist on origin.
2. Call `pool_acquire` with `repo` (origin URL or a local checkout path), `ref` and `holder`.
   You get a lease, or a queue ticket with a position and a reason.
3. While queued, call `pool_wait` with the ticket id. Each call waits up to 300 seconds.
4. When granted, call `delegate_task` with `target: { environmentId, projectId, providerInstanceId }` from the lease, and a Claude model.
   `providerInstanceId` is the Claude account to use: the first one not limited.
   Do not ask for a worktree. The lease is a whole machine, already checked out at your ref.
   If the thread stops on a usage limit, keep the lease. t3lizard continues the same thread on another account.
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
t3lizard setup add github.com/klovr-co/aldrent --reason "needs jq" -- 'command -v jq >/dev/null || sudo -n apt-get install -y jq'
t3lizard setup show github.com/klovr-co/aldrent
t3lizard setup remove github.com/klovr-co/aldrent 3
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

T3's own `autoResumeLimitedThreads` stays off on machines, so only t3lizard resumes threads.
To switch a thread's account, the machine helper signs in to its T3 as a full-access MCP client.
The `t3` CLI cannot change a thread's account. See DESIGN.md, "Claude accounts".

## CLI

```text
t3lizard daemon                          run the daemon
t3lizard acquire <repo> <ref> [--holder <name>]
t3lizard wait <ticketId> [--max <seconds>]
t3lizard release <leaseId|ticketId>
t3lizard renew <leaseId>
t3lizard status
t3lizard close <machineId>
t3lizard doctor
t3lizard setup add <repo> [--reason <why>] -- <shell line>
t3lizard setup show <repo>
t3lizard setup remove <repo> <step>
```

Each command prints JSON from the daemon.

## Trial limits

The Lizard trial runs one Small machine at a time, for at most one hour.
A second Small fails with 403 `TRIAL_SIZE_RUNNING`.
So the defaults are `totalCap: 1`, `lifetimeMinutes: 60` and `maxLifetimeMinutes: 60`.
Other repos queue behind the one machine.
After the first payment, raise `totalCap` and `maxLifetimeMinutes`.

## Tests

```sh
node --test
```

Every test uses a fake Lizard and a fake local `t3`.
The fake answers like the real API: its list rows have no metadata, and `getInfo` does. No test makes a network call or touches `~/.t3`.

## Not proven yet

These need a live test with a real API key:

- a real usage limit: the scan's match on the notice text, the switch, and that the agent that delegated the thread gets the continued run's result;
- whether `t3 environment link` accepts an `http://127.0.0.1:<port>` URL;
- the bring-up script on a real Lizard machine;
- the proxy against Lizard's real HTTPS and WebSocket route, through the machine's front proxy.

## How a machine is reached

```text
devbox T3 --> 127.0.0.1:<port> (t3lizard proxy, adds the Lizard token)
          --> https://<name>.sandbox...onlizard.com (Lizard edge)
          --> machine :3774 (front proxy: Host = 127.0.0.1:<port>, forwarded headers and token dropped)
          --> machine 127.0.0.1:3773 (T3)
```

T3 builds its own URL from the Host header. Its sign-in checks only pass when that URL is the one the devbox linked to.
So the front proxy gives T3 the devbox URL.
Each machine keeps its devbox port for its whole life, also across daemon restarts.

## Credits

t3lizard is modelled on [t3boat](https://github.com/trevize-dev/t3boat), which runs T3 Code work on boat.dev sandboxes.
The T3 bring-up (install, pairing, `t3 environment link`) and the idle cleanup follow its design.
The code is written from scratch.
t3lizard adds a shared daemon with a per-repo pool and queue, a token proxy for Lizard's private ports, Claude account rotation and a daily budget.

## License

MIT. See [LICENSE](LICENSE).
