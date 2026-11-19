import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { parseArgs } from "node:util";
import { call, serveApi } from "./api.ts";
import { accountsFromSecrets, isAccountTokenKey, loadConfig, loadSecrets, paths, t3lizardHome } from "./config.ts";
import { Daemon } from "./daemon.ts";
import type { DaemonDeps } from "./daemon.ts";
import { realLizard } from "./lizard.ts";
import { resolveRepo } from "./repo.ts";
import { realLocalT3 } from "./t3local.ts";

const USAGE = `t3lizard: a pool of Lizard cloud machines running T3 Code, per repo.

  t3lizard daemon                          run the daemon (systemd runs this)
  t3lizard acquire <repo> <ref> [--holder <name>]
                                           ask for a machine; <repo> is an origin URL or a checkout path
  t3lizard wait <ticketId> [--max <seconds>]
                                           long-poll a queued ticket (at most 300 s)
  t3lizard release <leaseId|ticketId>      give a machine back, or stop waiting
  t3lizard renew <leaseId>                 push the lease expiry out by leaseMinutes
  t3lizard status                          pools, queues, leases, budget
  t3lizard close <machineId>               close one machine now
  t3lizard doctor                          check config, secrets and the daemon
  t3lizard setup add <repo> [--reason <why>] -- <shell line>
                                           add a step to the repo's machine setup (runs on new machines)
  t3lizard setup show <repo>               the repo's setup steps, script and history
  t3lizard setup remove <repo> <step>      remove a step by its number (see setup show)
`;

/** Starts the API and the tick loop. Resolves when the daemon is told to stop. */
export async function runDaemon(deps: DaemonDeps): Promise<void> {
  const daemon = new Daemon(deps);
  await daemon.start();
  const server = await serveApi(daemon, paths(deps.home).socket);
  deps.log(`t3lizard daemon listening on ${paths(deps.home).socket}`);
  const tick = () => daemon.tick().catch((e) => deps.log(`tick failed: ${e.stack ?? e}`));
  const timer = setInterval(tick, deps.config.tickSeconds * 1000);
  void tick();
  await new Promise<void>((resolve) => {
    for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => resolve());
  });
  // Exit without waiting for bring-ups in flight: state is saved after every step,
  // and start() resumes machines still installing or linking.
  clearInterval(timer);
  server.close();
  deps.log("t3lizard daemon stopped");
  process.exit(0);
}

function fileLogger(file: string) {
  return (line: string) => {
    const text = `${new Date().toISOString()} ${line}\n`;
    appendFileSync(file, text, { mode: 0o600 });
    process.stdout.write(text);
  };
}

async function realDaemon(home: string): Promise<void> {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const secrets = loadSecrets(home);
  const accounts = accountsFromSecrets(secrets);
  const config = { ...loadConfig(home), accounts: accounts.map((a) => a.id) };
  if (!secrets.LIZARD_API_KEY) throw new Error(`LIZARD_API_KEY missing from ${paths(home).secrets}`);
  if (!config.project) throw new Error(`"project" (the Lizard project id) missing from ${paths(home).config}`);
  // Claude tokens never go machine-wide: each lives only in its own account's T3 provider instance.
  const machineEnv = Object.fromEntries(config.forwardEnv.flatMap((k) => (secrets[k] && !isAccountTokenKey(k) ? [[k, secrets[k]]] : [])));
  await runDaemon({
    lizard: realLizard({ apiKey: secrets.LIZARD_API_KEY, projectId: config.project, user: config.sandboxUser, template: config.template }),
    t3: realLocalT3(),
    config,
    machineEnv,
    accountTokens: Object.fromEntries(accounts.map((a) => [a.id, a.token])),
    home,
    resolveRepo,
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: fileLogger(paths(home).log),
  });
}

async function doctor(home: string): Promise<string[]> {
  const p = paths(home);
  const lines: string[] = [];
  const check = async (name: string, fn: () => unknown) => {
    try {
      const detail = await fn();
      lines.push(`ok    ${name}${detail ? `: ${detail}` : ""}`);
    } catch (e) {
      lines.push(`FAIL  ${name}: ${(e as Error).message}`);
    }
  };
  await check("config", () => {
    const c = loadConfig(home);
    if (!c.project) throw new Error(`set "project" in ${p.config}`);
    return `project ${c.project}, template ${c.template}, size ${c.size}, totalCap ${c.totalCap}, perRepoCap ${c.perRepoCap}`;
  });
  await check("secrets", () => {
    if (!existsSync(p.secrets)) throw new Error(`${p.secrets} does not exist`);
    if (statSync(p.secrets).mode & 0o077) throw new Error(`${p.secrets} must be mode 600`);
    const s = loadSecrets(home);
    const missing = ["LIZARD_API_KEY", ...loadConfig(home).forwardEnv.filter((k) => !isAccountTokenKey(k))].filter((k) => !s[k]);
    if (missing.length) throw new Error(`missing ${missing.join(", ")}`);
  });
  await check("claude accounts", () => {
    const accounts = accountsFromSecrets(loadSecrets(home));
    if (!accounts.length) throw new Error(`no CLAUDE_CODE_OAUTH_TOKEN or CLAUDE_CODE_OAUTH_TOKEN_<N> in ${p.secrets}`);
    return accounts.map((a) => a.id).join(", ");
  });
  await check("local t3", () => realLocalT3().version());
  await check("daemon", async () => {
    const s = await call(p.socket, "GET", "/status");
    return `${s.machineHoursToday} of ${s.dailyMachineHours} machine-hours used today`;
  });
  return lines;
}

export async function main(argv: string[]): Promise<number> {
  // Everything after the first "--" is a shell line for `setup add`, taken as is.
  const dashes = argv.indexOf("--");
  const shellLine = dashes >= 0 ? argv.slice(dashes + 1).join(" ") : undefined;
  const { positionals, values } = parseArgs({
    args: dashes >= 0 ? argv.slice(0, dashes) : argv,
    allowPositionals: true,
    options: { holder: { type: "string" }, max: { type: "string" }, reason: { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  const [cmd, ...args] = positionals;
  const home = t3lizardHome();
  const socket = paths(home).socket;
  const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));
  const need = (n: number) => {
    if (args.length < n) throw new Error(`${cmd} needs ${n} argument(s)\n\n${USAGE}`);
  };

  switch (values.help ? "help" : cmd) {
    case "daemon":
      await realDaemon(home);
      return 0;
    case "acquire":
      need(2);
      print(await call(socket, "POST", "/acquire", { repo: args[0], ref: args[1], holder: values.holder ?? `cli:${userInfo().username}@${hostname()}` }));
      return 0;
    case "wait":
      need(1);
      print(await call(socket, "POST", "/wait", { ticketId: args[0], maxSeconds: Number(values.max ?? 300) }));
      return 0;
    case "release": {
      need(1);
      const byLease = await call(socket, "POST", "/release", { leaseId: args[0] });
      print(byLease.released ? byLease : await call(socket, "POST", "/release", { ticketId: args[0] }).catch(() => byLease));
      return 0;
    }
    case "renew":
      need(1);
      print(await call(socket, "POST", "/renew", { leaseId: args[0] }));
      return 0;
    case "status":
      print(await call(socket, "GET", "/status"));
      return 0;
    case "close":
      need(1);
      print(await call(socket, "POST", "/close", { machineId: args[0] }));
      return 0;
    case "setup": {
      const [sub, repo, step] = args;
      const by = `cli:${userInfo().username}@${hostname()}`;
      if (sub === "add" && repo && shellLine) {
        print(await call(socket, "POST", "/setup/add", { repo, line: shellLine, reason: values.reason ?? "added from the CLI", by }));
        return 0;
      }
      if (sub === "show" && repo) {
        const out = await call(socket, "POST", "/setup/show", { repo });
        if (!out.exists) console.log(`${out.repo}: no setup yet (${out.path})`);
        else console.log(`${out.repo}: ${out.path}\n\n${out.steps.map((x: { n: number; date: string; reason: string; line: string }) => `${x.n}. ${x.date}: ${x.reason}\n   ${x.line}`).join("\n") || "(no numbered steps)"}\n\n--- script ---\n${out.script}`);
        return 0;
      }
      if (sub === "remove" && repo && step) {
        print(await call(socket, "POST", "/setup/remove", { repo, step: Number(step), by }));
        return 0;
      }
      throw new Error(`usage:\n  t3lizard setup add <repo> [--reason <why>] -- <shell line>\n  t3lizard setup show <repo>\n  t3lizard setup remove <repo> <step>`);
    }
    case "doctor": {
      const lines = await doctor(home);
      console.log(lines.join("\n"));
      return lines.some((l) => l.startsWith("FAIL")) ? 1 : 0;
    }
    default:
      console.log(USAGE);
      return cmd && cmd !== "help" ? 2 : 0;
  }
}
