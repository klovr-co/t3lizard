import { LimitExceededError, NotFoundError, PaymentRequiredError, Sandbox } from "@lizard-build/sdk";
import { SIZE_VCPU, type MachineId, type RepoKey, type Size } from "./types.ts";

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
  /** Every running sandbox on the Lizard account, in any project, with its vCPUs: they all count against the account's vCPU limit. */
  accountSandboxes?(): Promise<{ id: MachineId; vcpu: number }[]>;
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

const ENDED = new Set(["stopped", "crashed"]);

/**
 * Lists the project's sandboxes and keeps the ones whose metadata says t3lizard made them.
 * Metadata is fixed at create, so each sandbox costs one getInfo call, cached by id.
 * A sandbox whose getInfo fails is left out this round: when in doubt it is not ours.
 */
export function ownSandboxLister(dir: SandboxDirectory): () => Promise<MachineId[]> {
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
        ours = info.metadata?.t3lizard === "1";
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

export function realLizard(opts: { apiKey: string; projectId: string; user: string; template: string }): Lizard {
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
  const listOwn = ownSandboxLister(dir);

  return {
    accountSandboxes: () =>
      mapErrors(async () => {
        const all = (await Sandbox.list({ ...conn } as Parameters<typeof Sandbox.list>[0])) as { sandboxId?: string; id?: string; status?: string; size?: string }[];
        return all
          .filter((s) => !ENDED.has(String(s.status)))
          .map((s) => ({ id: (s.sandboxId ?? s.id) as MachineId, vcpu: SIZE_VCPU[s.size as Size] ?? SIZE_VCPU.medium }))
          .filter((s) => s.id);
      }),
    create: (repo, size, lifetimeMs, snapshotId) =>
      mapErrors(async () => {
        const sb = await Sandbox.create(opts.template, {
          ...conn,
          projectId: opts.projectId,
          size,
          timeoutMs: lifetimeMs,
          metadata: { t3lizard: "1", repo },
          ...(snapshotId ? { snapshotId } : {}),
        });
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

async function mapErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof LimitExceededError) throw new LizardLimitError(e.message, e.code, e.retryAfterS);
    if (e instanceof PaymentRequiredError) throw new LizardPaymentError(e.message, e.code, e.url);
    throw e;
  }
}
