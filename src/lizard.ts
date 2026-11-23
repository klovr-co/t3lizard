import { LimitExceededError, NotFoundError, PaymentRequiredError, Sandbox } from "@lizard-build/sdk";
import type { MachineId, RepoKey, Size } from "./types.ts";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Everything t3lizard needs from Lizard. The daemon depends on this, so tests use a fake. */
export interface Lizard {
  /** With snapshotId the machine starts from that saved snapshot, at the snapshot's own size (`size` is then ignored by Lizard). */
  create(repo: RepoKey, size: Size, lifetimeMs: number, snapshotId?: string): Promise<{ id: MachineId; deadline: number }>;
  /** Saves the machine's files as a private snapshot (about 2 s) and waits until it is ready. Returns its id. Storage is billed until it is deleted. */
  snapshot(id: MachineId, name: string): Promise<string>;
  deleteSnapshot(snapshotId: string): Promise<void>;
  /** Live sandboxes in the project that t3lizard created (metadata t3lizard=1). Never anyone else's. */
  list(): Promise<MachineId[]>;
  /** False when Lizard no longer knows the sandbox or reports it stopped or crashed. Throws when it cannot tell. */
  alive(id: MachineId): Promise<boolean>;
  exec(id: MachineId, cmd: string[], timeoutMs?: number): Promise<ExecResult>;
  exposePort(id: MachineId, port: number): Promise<{ hostname: string; accessToken: string }>;
  setTimeout(id: MachineId, msFromNow: number): Promise<void>;
  kill(id: MachineId): Promise<void>;
}

/** Lizard refused a create because of a sandbox or rate limit. Creates pause until retryAfterS. */
export class LizardLimitError extends Error {
  code?: string;
  retryAfterS?: number;
  constructor(message: string, code?: string, retryAfterS?: number) {
    super(message);
    this.name = "LizardLimitError";
    this.code = code;
    this.retryAfterS = retryAfterS;
  }
}

/** The account must pay or start Pro before it can create anything. */
export class LizardPaymentError extends Error {
  code?: string;
  url?: string;
  constructor(message: string, code?: string, url?: string) {
    super(message);
    this.name = "LizardPaymentError";
    this.code = code;
    this.url = url;
  }
}

/**
 * The two raw Lizard calls that ownership needs. The real `Sandbox.list()` answer has no
 * `metadata` field (whatever the SDK types say); only `getInfo()` returns it.
 */
export interface SandboxDirectory {
  listSandboxes(): Promise<{ sandboxId?: string; id?: string; status?: string }[]>;
  /** undefined when the sandbox no longer exists. */
  getInfo(id: MachineId): Promise<{ status?: string; metadata?: Record<string, string> } | undefined>;
}

/**
 * The metadata key that marks a sandbox as made by this daemon. Two daemons on one Lizard key that share a tag
 * kill each other's machines as orphans (each sees the other's as unknown), so each daemon needs its own.
 */
export const DEFAULT_TAG = "t3lizard";

const ENDED = new Set(["stopped", "crashed"]);

/**
 * Lists the project's sandboxes and keeps the ones whose metadata says t3lizard made them.
 * Metadata is fixed at create, so each sandbox costs one getInfo call, cached by id.
 * A sandbox whose getInfo fails is left out this round: when in doubt it is not ours.
 */
export function ownSandboxLister(dir: SandboxDirectory, tag = DEFAULT_TAG): () => Promise<MachineId[]> {
  const mine = new Map<MachineId, boolean>();
  return async () => {
    const listed = await dir.listSandboxes();
    const seen = new Set<MachineId>();
    const own: MachineId[] = [];
    for (const s of listed) {
      const id = s.sandboxId ?? s.id;
      if (!id) continue;
      seen.add(id);
      if (ENDED.has(String(s.status))) continue;
      let ours = mine.get(id);
      if (ours === undefined) {
        const info = await dir.getInfo(id).catch(() => undefined);
        if (!info) continue;
        ours = info.metadata?.[tag] === "1";
        mine.set(id, ours);
      }
      if (ours) own.push(id);
    }
    for (const id of mine.keys()) if (!seen.has(id)) mine.delete(id);
    return own;
  };
}

export async function sandboxAlive(dir: SandboxDirectory, id: MachineId): Promise<boolean> {
  const info = await dir.getInfo(id);
  return !!info && !ENDED.has(String(info.status));
}

export function realLizard(opts: { apiKey: string; projectId: string; user: string; template: string; tag?: string }): Lizard {
  const tag = opts.tag ?? DEFAULT_TAG;
  const conn = { apiKey: opts.apiKey };
  const sandbox = (id: MachineId) => new Sandbox({ sandboxId: id, ...conn });
  const dir: SandboxDirectory = {
    listSandboxes: () => Sandbox.list({ ...conn, projectId: opts.projectId }) as Promise<{ sandboxId?: string; status?: string }[]>,
    getInfo: async (id) => {
      try {
        return await sandbox(id).getInfo();
      } catch (e) {
        if (e instanceof NotFoundError) return undefined;
        throw e;
      }
    },
  };
  const listOwn = ownSandboxLister(dir, tag);

  return {
    create: (repo, size, lifetimeMs, snapshotId) =>
      mapErrors(async () => {
        const sb = await Sandbox.create(opts.template, {
          ...conn,
          projectId: opts.projectId,
          size,
          timeoutMs: lifetimeMs,
          metadata: { [tag]: "1", repo },
          ...(snapshotId ? { snapshotId } : {}),
        });
        // Lizard answers "Sandbox already deleted" (NotFoundError) to calls made in the first moments after create.
        // Hand the machine to bring-up only once it runs a command, or every bring-up loses this race.
        await waitReady(sb, opts.user);
        const info = await sb.getInfo().catch(() => undefined);
        const end = info?.endAt ? Date.parse(info.endAt) : NaN;
        return { id: sb.sandboxId, deadline: Number.isFinite(end) ? end : Date.now() + lifetimeMs };
      }),
    snapshot: (id, name) =>
      mapErrors(async () => {
        const snap = await sandbox(id).snapshot(name);
        const ready = await Sandbox.waitForSnapshot(snap.id, { ...conn, waitTimeoutMs: 5 * 60_000 });
        if (ready.status !== "ready") throw new Error(`snapshot ${snap.id} is ${ready.status}${ready.error ? `: ${ready.error}` : ""}`);
        return ready.id;
      }),
    deleteSnapshot: (snapshotId) => mapErrors(() => Sandbox.deleteSnapshot(snapshotId, conn)),
    list: () => mapErrors(listOwn),
    alive: (id) => mapErrors(() => sandboxAlive(dir, id)),
    exec: (id, cmd, timeoutMs = 120_000) =>
      mapErrors(() => sandbox(id).process.exec(cmd, { timeoutMs, user: opts.user })),
    exposePort: (id, port) =>
      mapErrors(async () => {
        const { hostname, accessToken } = await sandbox(id).exposePort(port);
        return { hostname, accessToken };
      }),
    setTimeout: (id, msFromNow) => mapErrors(() => sandbox(id).setTimeout(msFromNow)),
    kill: (id) => mapErrors(async () => void (await sandbox(id).kill())),
  };
}

/** Runs `true` on a new sandbox until it answers. Only NotFoundError is retried: it is how Lizard says "not up yet". */
export async function waitReady(sb: Pick<Sandbox, "process">, user: string, timeoutMs = 90_000, pauseMs = 1_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < end) {
    try {
      await sb.process.exec(["true"], { timeoutMs: 15_000, user });
      return;
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
      last = e;
    }
    await new Promise((r) => setTimeout(r, pauseMs));
  }
  throw last ?? new Error(`sandbox did not answer within ${Math.round(timeoutMs / 1000)} s`);
}

async function mapErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof LimitExceededError) throw new LizardLimitError(e.message, e.code, e.retryAfterS);
    if (e instanceof PaymentRequiredError) throw new LizardPaymentError(e.message, e.code, e.url);
    throw e;
  }
}
