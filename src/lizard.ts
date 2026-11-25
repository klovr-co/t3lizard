import { LimitExceededError, NotFoundError, PaymentRequiredError, Sandbox } from "@lizard-build/sdk";
import { ProviderLimitError, ProviderPaymentError } from "./provider.ts";
import type { MachineProvider } from "./provider.ts";
import { SIZE_VCPU, type MachineId, type Size } from "./types.ts";

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

export function realLizard(opts: { apiKey: string; projectId: string; user: string; template: string; tag?: string }): MachineProvider {
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
    name: "Lizard",
    portAuth: { kind: "header", name: "X-Lizard-Access-Token" },
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
    if (e instanceof LimitExceededError) throw new ProviderLimitError(e.message, e.code, e.retryAfterS);
    if (e instanceof PaymentRequiredError) throw new ProviderPaymentError(e.message, e.code, e.url);
    throw e;
  }
}
