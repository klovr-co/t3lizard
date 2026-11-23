import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { SIZE_WEIGHT } from "./types.ts";
import type { AccountId, Config, SizeSlot } from "./types.ts";

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
  // The Lizard trial runs 1 small, 2 mini and 2 nano at once. Nano (0.5 vCPU, 1 GB) is too small for builds.
  sizes: [
    { size: "small", max: 1 },
    { size: "mini", max: 2 },
  ],
  perRepoCap: 4,
  idleCloseMinutes: 10,
  recycleMinutes: 240,
  lifetimeMinutes: 60,
  maxLifetimeMinutes: 180,
  leaseMinutes: 90,
  ticketMaxWaitMinutes: 60,
  dailySmallMachineHours: 20,
  createsPerRepoPerHour: 20,
  linkEnvironment: true,
  createChargeMinutes: 10,
  proxyPortRange: [47300, 47399],
  forwardEnv: ["GH_TOKEN"],
  sandboxUser: "user",
  tickSeconds: 15,
  accountRetryMinutes: 30,
  accountDisabledMinutes: 30,
  setupTimeoutMinutes: 20,
  vcpuReserve: 0,
  idleMaxMinutes: 30,
  defaultSize: "medium",
  dashboardPort: 47290,
  accounts: [],
};

const positive = z.number().int().positive();
const SizeName = z.enum(["nano", "mini", "small", "medium", "large", "big"]);
const ConfigFile = z
  .object({
    project: z.string(),
    template: z.string().min(1),
    sandboxTag: z.string().regex(/^[A-Za-z][\w-]{0,63}$/),
    /** max is optional with vcpuLimit: then the vCPU limit decides how many of each fit. */
    sizes: z.array(z.object({ size: SizeName, max: positive.optional() }).strict()).min(1),
    /** Older configs: one size, at most totalCap machines. Read as sizes [{ size, max: totalCap }]. */
    size: SizeName,
    totalCap: positive,
    perRepoCap: positive,
    idleCloseMinutes: positive,
    recycleMinutes: positive,
    lifetimeMinutes: positive,
    maxLifetimeMinutes: positive,
    leaseMinutes: positive,
    ticketMaxWaitMinutes: positive,
    dailySmallMachineHours: z.number().positive(),
    /** Older name of dailySmallMachineHours. */
    dailyMachineHours: z.number().positive(),
    createsPerRepoPerHour: positive,
    linkEnvironment: z.boolean(),
    createChargeMinutes: z.number().int().min(0),
    proxyPortRange: z.tuple([positive, positive]),
    forwardEnv: z.array(z.string()),
    sandboxUser: z.string(),
    tickSeconds: positive,
    accountRetryMinutes: positive,
    accountDisabledMinutes: positive,
    setupTimeoutMinutes: positive,
    /** Extra addresses the devbox proxies listen on, e.g. the Tailscale IP, so a browser can open a machine. */
    vcpuLimit: z.number().positive(),
    idleMaxMinutes: positive,
    vcpuReserve: z.number().min(0),
    defaultSize: SizeName,
    dashboardPort: z.number().int().min(0),
    publicBind: z.array(z.string().min(1)),
    /** The name a browser uses for those addresses, e.g. devbox.tailnet.ts.net. Used in `t3lizard connect` links. */
    publicHost: z.string().min(1),
    defaultProvider: z.enum(["antigravity", "claude"]),
    defaultModel: z.string().min(1),
  })
  .partial()
  .strict();

export function loadConfig(home: string): Config {
  const file = paths(home).config;
  if (!existsSync(file)) return DEFAULT_CONFIG;
  try {
    return parseConfig(JSON.parse(readFileSync(file, "utf8")));
  } catch (e) {
    throw new Error(`bad ${file}: ${(e as Error).message}`);
  }
}

/** Ladder largest first: that is the order plan() tries sizes in. */
export function sortSizes(sizes: SizeSlot[]): SizeSlot[] {
  return [...sizes].sort((a, b) => SIZE_WEIGHT[b.size] - SIZE_WEIGHT[a.size]);
}

/** Validates a config file's JSON and fills defaults. Older keys (size, totalCap, dailyMachineHours) still work. */
export function parseConfig(json: unknown): Config {
  const parsed = ConfigFile.safeParse(json);
  if (!parsed.success) throw new Error(parsed.error.message);
  const { sizes, size, totalCap, dailyMachineHours, ...rest } = parsed.data;
  if (sizes && (size !== undefined || totalCap !== undefined)) {
    throw new Error('give "sizes", or the older "size" and "totalCap", not both');
  }
  if (dailyMachineHours !== undefined && rest.dailySmallMachineHours !== undefined) {
    throw new Error('give "dailySmallMachineHours" (or its older name "dailyMachineHours"), not both');
  }
  const legacy = size !== undefined || totalCap !== undefined;
  const ladder = (sizes ?? (legacy ? [{ size: size ?? "small", max: totalCap ?? 1 }] : DEFAULT_CONFIG.sizes)).map((x) => ({ size: x.size, max: x.max ?? Number.MAX_SAFE_INTEGER }));
  if (!rest.vcpuLimit && ladder.some((x) => x.max === Number.MAX_SAFE_INTEGER)) throw new Error('a size without "max" needs "vcpuLimit"');
  const dup = ladder.find((s, i) => ladder.findIndex((o) => o.size === s.size) !== i);
  if (dup) throw new Error(`size "${dup.size}" is listed twice in "sizes"`);
  return {
    ...DEFAULT_CONFIG,
    ...rest,
    sizes: sortSizes(ladder),
    ...(dailyMachineHours !== undefined ? { dailySmallMachineHours: dailyMachineHours } : {}),
  } as Config;
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

/**
 * Secrets come from the process environment (`infisical run -- t3lizard daemon`), with secrets.env as an
 * optional fallback. The environment wins, so Infisical is the source of truth when both exist.
 */
export function loadSecrets(home: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const file = paths(home).secrets;
  const fromFile = existsSync(file) ? parseEnvFile(readFileSync(file, "utf8")) : {};
  const fromEnv = Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => !!e[1]));
  return { ...fromFile, ...fromEnv };
}

const ACCOUNT_TOKEN = /^CLAUDE_CODE_OAUTH_TOKEN(?:_([1-9]\d*))?$/;
const ANTIGRAVITY_TOKEN = /^ANTIGRAVITY_OAUTH_TOKEN$/;

/** True for provider auth tokens (Claude / Antigravity): these never go to a machine's env file. */
export const isAccountTokenKey = (key: string) => ACCOUNT_TOKEN.test(key) || ANTIGRAVITY_TOKEN.test(key);

/**
 * Antigravity OAuth token JSON from ANTIGRAVITY_OAUTH_TOKEN (either raw JSON or base64-encoded JSON).
 * Returns the canonical JSON string, or undefined when not set.
 */
export function antigravityTokenFromSecrets(secrets: Record<string, string>): string | undefined {
  const raw = secrets.ANTIGRAVITY_OAUTH_TOKEN?.trim();
  if (!raw) return undefined;
  const text = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("ANTIGRAVITY_OAUTH_TOKEN must be valid JSON (or base64-encoded JSON) from antigravity-oauth-token");
  }
  if (!parsed || typeof parsed !== "object" || !("token" in parsed)) {
    throw new Error("ANTIGRAVITY_OAUTH_TOKEN JSON is missing its \"token\" field");
  }
  return text;
}

/**
 * One Claude account per CLAUDE_CODE_OAUTH_TOKEN[_N] secret, in N order (no suffix is account 1).
 * The id is the provider instance each machine gets for it: claudeAgent_acct<N>.
 */
/** CLAUDE_ACCOUNT_LABEL_<n> = a name for account <n> (e.g. claude-dev-klovr), shown next to claudeAgent_acct<n>. */
export function accountLabelsFromSecrets(secrets: Record<string, string>): Record<AccountId, string> {
  const labels: Record<AccountId, string> = {};
  for (const [key, value] of Object.entries(secrets)) {
    const m = key.match(/^CLAUDE_ACCOUNT_LABEL_([1-9]\d*)$/);
    const label = value?.trim().replace(/^['"]|['"]$/g, "");
    if (m && label) labels[`claudeAgent_acct${m[1]}`] = label.slice(0, 60);
  }
  return labels;
}

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
