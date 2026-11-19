import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { AccountId, Config } from "./types.ts";

export function t3lizardHome(): string {
  return process.env.T3LIZARD_HOME ?? join(homedir(), ".t3lizard");
}

export function paths(home: string) {
  return {
    config: join(home, "config.json"),
    secrets: join(home, "secrets.env"),
    state: join(home, "state.json"),
    socket: join(home, "daemon.sock"),
    log: join(home, "daemon.log"),
  };
}

export const DEFAULT_CONFIG: Config = {
  project: "",
  template: "claude",
  size: "small",
  perRepoCap: 4,
  totalCap: 1,
  idleCloseMinutes: 10,
  recycleMinutes: 240,
  lifetimeMinutes: 60,
  maxLifetimeMinutes: 60,
  leaseMinutes: 90,
  ticketMaxWaitMinutes: 60,
  dailyMachineHours: 20,
  createsPerRepoPerHour: 3,
  createChargeMinutes: 10,
  proxyPortRange: [47300, 47399],
  forwardEnv: ["GH_TOKEN"],
  sandboxUser: "user",
  tickSeconds: 15,
  accountRetryMinutes: 30,
  setupTimeoutMinutes: 20,
  accounts: [],
};

const positive = z.number().int().positive();
const ConfigFile = z
  .object({
    project: z.string(),
    template: z.string().min(1),
    size: z.enum(["nano", "mini", "small", "medium", "large", "big"]),
    perRepoCap: positive,
    totalCap: positive,
    idleCloseMinutes: positive,
    recycleMinutes: positive,
    lifetimeMinutes: positive,
    maxLifetimeMinutes: positive,
    leaseMinutes: positive,
    ticketMaxWaitMinutes: positive,
    dailyMachineHours: z.number().positive(),
    createsPerRepoPerHour: positive,
    createChargeMinutes: z.number().int().min(0),
    proxyPortRange: z.tuple([positive, positive]),
    forwardEnv: z.array(z.string()),
    sandboxUser: z.string(),
    tickSeconds: positive,
    accountRetryMinutes: positive,
    setupTimeoutMinutes: positive,
  })
  .partial()
  .strict();

export function loadConfig(home: string): Config {
  const file = paths(home).config;
  if (!existsSync(file)) return DEFAULT_CONFIG;
  const parsed = ConfigFile.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`bad ${file}: ${parsed.error.message}`);
  return { ...DEFAULT_CONFIG, ...parsed.data } as Config;
}

/** KEY=VALUE lines; blank lines and # comments skipped; one layer of matching quotes removed. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    const v = m[2];
    out[m[1]] = /^(['"]).*\1$/.test(v) ? v.slice(1, -1) : v;
  }
  return out;
}

export function loadSecrets(home: string): Record<string, string> {
  const file = paths(home).secrets;
  return existsSync(file) ? parseEnvFile(readFileSync(file, "utf8")) : {};
}

const ACCOUNT_TOKEN = /^CLAUDE_CODE_OAUTH_TOKEN(?:_([1-9]\d*))?$/;

/** True for CLAUDE_CODE_OAUTH_TOKEN and CLAUDE_CODE_OAUTH_TOKEN_<N>: these never go to a machine's env file. */
export const isAccountTokenKey = (key: string) => ACCOUNT_TOKEN.test(key);

/**
 * One Claude account per CLAUDE_CODE_OAUTH_TOKEN[_N] secret, in N order (no suffix is account 1).
 * The id is the provider instance each machine gets for it: claudeAgent_acct<N>.
 */
export function accountsFromSecrets(secrets: Record<string, string>): { id: AccountId; token: string }[] {
  const byN = new Map<number, string>();
  for (const [key, token] of Object.entries(secrets)) {
    const m = key.match(ACCOUNT_TOKEN);
    if (!m || !token) continue;
    const n = m[1] ? Number(m[1]) : 1;
    if (!byN.has(n) || !m[1]) byN.set(n, token);
  }
  return [...byN].sort(([a], [b]) => a - b).map(([n, token]) => ({ id: `claudeAgent_acct${n}`, token }));
}
