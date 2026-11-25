import { randomUUID } from "node:crypto";
import { DEFAULT_TAG, ProviderLimitError, ProviderPaymentError } from "./provider.ts";
import type { ExecResult, MachineProvider } from "./provider.ts";
import type { MachineId, Size } from "./types.ts";

/** InstaBox machine shapes. InstaBox has no other sizes. */
export const INSTABOX_SIZES: Partial<Record<Size, { vcpus: number; memMiB: number }>> = {
  small: { vcpus: 2, memMiB: 4096 },
  medium: { vcpus: 4, memMiB: 8192 },
  large: { vcpus: 8, memMiB: 16384 },
};

const MINUTE = 60_000;
/** Execs in flight at once: under the free plan's 32 and well under Pro's 64, leaving room for a second daemon. */
export const DEFAULT_EXEC_CONCURRENCY = 24;
/** Machine states that will never run a command again. */
const GONE = new Set(["deleting", "deleted", "error"]);
const NOT_ALIVE = new Set([...GONE, "stopped"]);
/** Codes InstaBox sends with 402 (docs, reference/errors). */
const PAYMENT_CODES = new Set(["credit_exhausted", "spend_limit_reached", "subscription_required", "payment_method_required", "payment_required", "early_allowance_ended", "payment_failed"]);
/** How long an exec keeps retrying the account-wide concurrent exec limit (429 quota_exceeded, sent with no Retry-After). */
const EXEC_RETRY_MS = 60_000;
/** InstaBox's cap on argv: each element's UTF-8 length plus one (docs: ExecRequest.argv). */
const ARGV_MAX_BYTES = 65_536;
/** Reads NUL-separated arguments from stdin and runs them, for an argv over ARGV_MAX_BYTES. stdin carries up to 1 MiB. */
const ARGS_FROM_STDIN = 'mapfile -d "" -t a; exec "${a[@]}"';

export interface InstaboxOptions {
  apiKey: string;
  /** Template id, e.g. "agent-browser" (Debian, glibc, with node). */
  template: string;
  tag?: string;
  /** The daemon never keeps a machine longer; InstaBox deletes it 30 minutes after this as a crash backstop. */
  maxLifetimeMs: number;
  /** Execs in flight at once (default DEFAULT_EXEC_CONCURRENCY). Every daemon on the account shares its limit. */
  execConcurrency?: number;
  /** Minutes idle before InstaBox pauses a machine; 0 (default) never. The free plan accepts only 30. */
  autoSuspendMinutes?: number;
  fetch?: typeof fetch;
  baseUrl?: string;
  sleep?: (ms: number) => Promise<void>;
}

class InstaboxError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "InstaboxError";
    this.status = status;
    this.code = code;
  }
}

const notFound = (e: unknown) => e instanceof InstaboxError && e.status === 404;

/** MachineProvider over InstaBox's REST API (https://instabox.sh/docs). */
export function realInstabox(opts: InstaboxOptions): MachineProvider {
  const tag = opts.tag ?? DEFAULT_TAG;
  const base = opts.baseUrl ?? "https://api.instabox.sh";
  const fetchFn = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const execSlot = semaphore(opts.execConcurrency ?? DEFAULT_EXEC_CONCURRENCY);

  async function request(method: string, path: string, body?: unknown, extra: { headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<any> {
    const headers: Record<string, string> = { "X-API-Key": opts.apiKey, accept: "application/json", ...extra.headers };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetchFn(`${base}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(extra.timeoutMs ?? MINUTE),
    });
    const text = await res.text();
    let parsed: any;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }
    // With X-Instabox-Exec-Keepalive an error after the 200 went out arrives as {"error", "status"} (docs: exec, Keepalive).
    const status = res.ok && parsed?.error && typeof parsed.status === "number" ? parsed.status : res.status;
    if (status >= 200 && status < 300) return parsed;
    const err = parsed?.error ?? {};
    const code = typeof err.code === "string" ? err.code : undefined;
    const message = `InstaBox ${method} ${path.split("?")[0]}: ${status}${code ? ` ${code}` : ""}${typeof err.message === "string" ? `: ${err.message}` : ""}`;
    if (status === 402 || (code && PAYMENT_CODES.has(code))) throw new ProviderPaymentError(message, code);
    if (status === 429 || code === "no_capacity") {
      const header = Number(res.headers.get("retry-after"));
      const retryAfterS = Number.isFinite(header) && header > 0 ? header : typeof err.retryAfterSeconds === "number" ? err.retryAfterSeconds : 60;
      throw new ProviderLimitError(message, code, retryAfterS);
    }
    throw new InstaboxError(message, status, code);
  }

  /** A mutating POST or DELETE: InstaBox requires an Idempotency-Key on each. */
  const mutate = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    request(method, path, body, { headers: { "Idempotency-Key": randomUUID(), ...headers } });

  /** Calls check until it returns a value, pausing everyMs between calls; gives up after limitMs. */
  async function poll<T>(what: string, limitMs: number, everyMs: number, check: () => Promise<T | undefined>): Promise<T> {
    const start = Date.now();
    for (let slept = 0; ; slept += everyMs) {
      const done = await check();
      if (done !== undefined) return done;
      if (slept >= limitMs || Date.now() - start >= limitMs) throw new Error(`InstaBox ${what} did not finish in ${Math.round(limitMs / 1000)} s`);
      await sleep(everyMs);
    }
  }

  async function execOnce(id: MachineId, argv: string[], timeoutMs: number): Promise<ExecResult> {
    const timeoutSeconds = Math.min(600, Math.max(1, Math.ceil(timeoutMs / 1000)));
    // argv runs with no shell (docs: ExecRequest). An argv over its 64 KiB cap (a `put` near PUT_MAX_BYTES) goes through stdin instead.
    const argvBytes = argv.reduce((n, a) => n + Buffer.byteLength(a) + 1, 0);
    const body = argvBytes <= ARGV_MAX_BYTES ? { argv, timeoutSeconds } : { argv: ["bash", "-c", ARGS_FROM_STDIN], stdin: argv.map((a) => a + "\0").join(""), timeoutSeconds };
    // Keepalive: the server answers 200 after 15 s and sends a newline every 15 s, so a long command outlasts
    // Node fetch's 300 s wait for headers and any proxy that closes a quiet connection.
    const r = await request("POST", `/v1/machines/${id}/exec`, body, { headers: { "X-Instabox-Exec-Keepalive": "1" }, timeoutMs: timeoutSeconds * 1000 + MINUTE });
    // The daemon reads "timed out" as a machine that stopped answering.
    if (r.timedOut) throw new Error(`command on ${id} timed out after ${timeoutSeconds} s`);
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.exitCode ?? -1 };
  }

  const exec = (id: MachineId, argv: string[], timeoutMs = 120_000) =>
    execSlot(async () => {
      let slept = 0;
      for (let pause = 1000; ; pause *= 2) {
        try {
          return await execOnce(id, argv, timeoutMs);
        } catch (e) {
          if (!(e instanceof ProviderLimitError && e.code === "quota_exceeded") || slept >= EXEC_RETRY_MS) throw e;
          const ms = Math.min(pause, EXEC_RETRY_MS - slept);
          await sleep(ms);
          slept += ms;
        }
      }
    });

  const kill = async (id: MachineId) => {
    try {
      await mutate("DELETE", `/v1/machines/${id}`, undefined, { "X-Confirm-Delete": id });
    } catch (e) {
      if (!notFound(e)) throw e;
    }
  };

  return {
    name: "InstaBox",
    portAuth: { kind: "cookie", name: "__Host-instabox_port_auth" },
    // Commands run as the image's user with HOME=/data/home (measured).
    home: "/data/home",
    // $0.004 per vCPU-hour + $0.00225 per GiB-hour: small 0.017, medium 0.034, large 0.068.
    usdPerSmallHour: 0.017,
    async create(repo, size, lifetimeMs, snapshotId, labels) {
      const shape = INSTABOX_SIZES[size];
      if (!shape) throw new Error(`InstaBox has no ${size} machine (sizes: ${Object.keys(INSTABOX_SIZES).join(", ")})`);
      const op = await mutate("POST", "/v1/machines", {
        // A machine starts from a template or a snapshot, never both; a snapshot is locked to the size it was taken at.
        ...(snapshotId ? { snapshotId } : { templateId: opts.template, ...shape }),
        metadata: { ...labels, [tag]: "1", repo },
        autoSuspendAfterSeconds: (opts.autoSuspendMinutes ?? 0) * 60,
        deleteAfterSeconds: Math.min(86_400, Math.ceil((Math.max(lifetimeMs, opts.maxLifetimeMs) + 30 * MINUTE) / 1000)),
      });
      const id: MachineId = op.machineId;
      try {
        await poll(`start of ${id}`, 5 * MINUTE, 2_000, async () => {
          const o = await request("GET", `/v1/operations/${op.id}?wait=25s`);
          if (o.state === "failed") throw new Error(`InstaBox could not start ${id}: ${JSON.stringify(o.error ?? "no reason given")}`);
          return o.state === "succeeded" ? true : undefined;
        });
        // Hand the machine to bring-up only once it runs a command.
        let last: unknown;
        await poll(`first command on ${id}`, 90_000, 2_000, async () => {
          try {
            await exec(id, ["true"], 15_000);
            return true;
          } catch (e) {
            if (e instanceof ProviderPaymentError) throw e;
            last = e;
            return undefined;
          }
        }).catch((e) => {
          throw e instanceof ProviderPaymentError ? e : (last ?? e);
        });
      } catch (e) {
        // A machine that never came up is no use: delete it now rather than at deleteAfterSeconds.
        await kill(id).catch(() => {});
        throw e;
      }
      return { id, deadline: Date.now() + lifetimeMs };
    },
    async snapshot(id, name) {
      const snap = await mutate("POST", `/v1/machines/${id}/snapshots`, { name });
      return poll(`snapshot ${snap.id}`, 15 * MINUTE, 5_000, async () => {
        const s = await request("GET", `/v1/snapshots/${snap.id}`);
        if (s.status === "failed") throw new Error(`InstaBox snapshot ${snap.id} failed: ${JSON.stringify(s.error ?? "no reason given")}`);
        return s.status === "ready" ? (snap.id as string) : undefined;
      });
    },
    async deleteSnapshot(snapshotId) {
      try {
        await mutate("DELETE", `/v1/snapshots/${snapshotId}`);
      } catch (e) {
        if (!notFound(e)) throw e;
      }
    },
    async list() {
      const own: MachineId[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const q = new URLSearchParams({ metadata: `${tag}:1` });
        if (cursor) q.set("cursor", cursor);
        const page = await request("GET", `/v1/machines?${q}`);
        // Checked here too: a filter InstaBox ignored must never make someone else's machine an orphan to kill.
        for (const m of page?.machines ?? []) if (!GONE.has(m.state) && m.metadata?.[tag] === "1") own.push(m.id);
        cursor = page?.nextCursor ?? undefined;
        if (cursor && seen.has(cursor)) throw new Error("InstaBox list: the same page came back twice");
        if (cursor) seen.add(cursor);
      } while (cursor);
      return own;
    },
    async alive(id) {
      try {
        return !NOT_ALIVE.has((await request("GET", `/v1/machines/${id}`)).state);
      } catch (e) {
        if (notFound(e)) return false;
        throw e;
      }
    },
    exec,
    async exposePort(id, port) {
      const p = await mutate("POST", `/v1/machines/${id}/ports`, { port, access: "private", rotateToken: true });
      return { hostname: new URL(p.url).host, accessToken: p.token };
    },
    // InstaBox cannot extend deleteAfterSeconds: the daemon owns deadlines, and deleteAfterSeconds is only the crash backstop.
    async setTimeout() {},
    kill,
  };
}

/** At most n calls of fn at once; the rest wait their turn. */
function semaphore(n: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active < n) active++;
    else await new Promise<void>((r) => waiting.push(r));
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}
