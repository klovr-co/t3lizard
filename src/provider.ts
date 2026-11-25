import type { MachineId, RepoKey, Size } from "./types.ts";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * The metadata key that marks a machine as made by this daemon. Two daemons on one account that share a tag
 * kill each other's machines as orphans (each sees the other's as unknown), so each daemon needs its own.
 */
export const DEFAULT_TAG = "t3lizard";

/** How the provider's edge takes the exposed port's access token: as a request header or a cookie. */
export type PortAuth = { kind: "header"; name: string } | { kind: "cookie"; name: string };

/** Everything the daemon needs from a cloud machine provider (Lizard, InstaBox). Tests use a fake. */
export interface MachineProvider {
  /** For logs and status, e.g. "Lizard". */
  readonly name: string;
  /** How the devbox proxy sends the token from exposePort. */
  readonly portAuth: PortAuth;
  /** With snapshotId the machine starts from that saved snapshot, at the snapshot's own size (`size` is then ignored). */
  create(repo: RepoKey, size: Size, lifetimeMs: number, snapshotId?: string): Promise<{ id: MachineId; deadline: number }>;
  /** Saves the machine's files as a private snapshot and waits until it is ready. Returns its id. Storage is billed until it is deleted. */
  snapshot(id: MachineId, name: string): Promise<string>;
  deleteSnapshot(snapshotId: string): Promise<void>;
  /** Live machines this daemon created (metadata <tag>=1). Never anyone else's. */
  list(): Promise<MachineId[]>;
  /** Every running machine on the account, with its vCPUs, when the account limits vCPUs running at once. */
  accountSandboxes?(): Promise<{ id: MachineId; vcpu: number }[]>;
  /** False when the provider no longer knows the machine or reports it stopped. Throws when it cannot tell. */
  alive(id: MachineId): Promise<boolean>;
  exec(id: MachineId, cmd: string[], timeoutMs?: number): Promise<ExecResult>;
  exposePort(id: MachineId, port: number): Promise<{ hostname: string; accessToken: string }>;
  setTimeout(id: MachineId, msFromNow: number): Promise<void>;
  kill(id: MachineId): Promise<void>;
}

/** The provider refused a create because of a machine or rate limit. Creates pause until retryAfterS. */
export class ProviderLimitError extends Error {
  code?: string;
  retryAfterS?: number;
  constructor(message: string, code?: string, retryAfterS?: number) {
    super(message);
    this.name = "ProviderLimitError";
    this.code = code;
    this.retryAfterS = retryAfterS;
  }
}

/** The account must pay or change plan before it can create anything. */
export class ProviderPaymentError extends Error {
  code?: string;
  url?: string;
  constructor(message: string, code?: string, url?: string) {
    super(message);
    this.name = "ProviderPaymentError";
    this.code = code;
    this.url = url;
  }
}
