export type RepoKey = string;
export type MachineId = string;
export type Size = "nano" | "mini" | "small" | "medium" | "large" | "big";

/**
 * Lizard's flat per-hour price of each size, relative to small (SDK docs on `size`: nano $0.00405/h,
 * mini $0.0081/h, small $0.0162/h, medium $0.0324/h, large $0.0648/h, big $0.1296/h). The daily
 * budget is in small-machine-hours: an hour of a mini counts 0.5, of a nano 0.25.
 */
export const SIZE_WEIGHT: Record<Size, number> = { nano: 0.25, mini: 0.5, small: 1, medium: 2, large: 4, big: 8 };

/** At most `max` machines of `size` at once. */
export interface SizeSlot {
  size: Size;
  max: number;
}

export type MachinePhase =
  | { kind: "creating" }
  | { kind: "installing" }
  | { kind: "linking" }
  | { kind: "idle"; since: number }
  | { kind: "resetting"; ticketId: string }
  | { kind: "leased"; leaseId: string }
  | { kind: "closing" }
  | { kind: "failed"; error: string };

/**
 * A Claude account. Each one is a T3 provider instance on every machine (`claudeAgent_acct<N>`)
 * that holds only that account's token, so the id is the provider instance id.
 */
export type AccountId = string;

export interface AccountState {
  /** The account hit its usage limit; it is skipped until this time, then tried again. */
  limitedUntil?: number;
}

/** A thread on a leased machine whose latest run failed on an account's usage limit. */
export interface LimitedThread {
  threadId: string;
  runId: string;
  account: AccountId;
}

export interface Machine {
  id: MachineId;
  repo: RepoKey;
  size: Size;
  createdAt: number;
  deadline: number;
  phase: MachinePhase;
  /** The devbox proxy port. Fixed for the machine's life: the T3 link and the front Host use it. */
  proxyPort?: number;
  /** What the machine's front proxy sends T3 as Host (127.0.0.1:<proxyPort>), once configured. */
  frontHost?: string;
  /** When a command on the machine last timed out, if none has worked since: the machine is not answering. */
  unresponsiveSince?: number;
  hostname?: string;
  accessToken?: string;
  environmentId?: string;
  projectId?: string;
  workspacePath?: string;
  /** sha256 of the repo setup script this machine ran to the end, so a resumed bring-up skips it. */
  setupHash?: string;
  /** Threads that hit a usage limit and wait to continue on another account. From the last scan. */
  limitedThreads?: LimitedThread[];
  /** Runs already continued on another account, so a scan that raced the continue never repeats it. */
  continuedRuns?: string[];
}

export interface Lease {
  id: string;
  machineId: MachineId;
  repo: RepoKey;
  ref: string;
  holder: string;
  grantedAt: number;
  expiresAt: number;
}

interface TicketBase {
  id: string;
  repo: RepoKey;
  ref: string;
  holder: string;
  enqueuedAt: number;
}

export type Ticket =
  | (TicketBase & { status: "queued" })
  | (TicketBase & { status: "granted"; leaseId: string })
  | (TicketBase & { status: "cancelled" | "expired"; endedAt: number; error?: string });

export interface LizardError {
  at: number;
  message: string;
  code?: string;
  url?: string;
}

/** One machine the daemon asked Lizard for. Drives the create circuit breaker. */
export interface CreateRecord {
  /** `pending:<uuid>` until Lizard answers, then the sandbox id. */
  machineId: MachineId;
  repo: RepoKey;
  at: number;
  /** pending: not yet ready. ready: reached idle once. lost: closed, failed or vanished before that. */
  outcome: "pending" | "ready" | "lost";
  settledAt?: number;
  reason?: string;
}

export interface State {
  machines: Record<MachineId, Machine>;
  leases: Record<string, Lease>;
  tickets: Ticket[];
  usage: Record<string, number>;
  usageAccruedAt?: number;
  createsPausedUntil?: number;
  lastLizardError?: LizardError;
  /** Creates of the last 24 hours. Optional so older state files still load. */
  creates?: CreateRecord[];
  /** Per Claude account. Optional so older state files still load. */
  accounts?: Record<AccountId, AccountState>;
}

export interface Config {
  project: string;
  /** Lizard template. Must be a glibc image: the T3 binary does not run on musl (Alpine). */
  template: string;
  /** The size ladder, largest first. A ticket that needs a new machine gets the largest size with room. */
  sizes: SizeSlot[];
  perRepoCap: number;
  idleCloseMinutes: number;
  recycleMinutes: number;
  lifetimeMinutes: number;
  maxLifetimeMinutes: number;
  leaseMinutes: number;
  ticketMaxWaitMinutes: number;
  /** Daily budget in small-machine-hours (SIZE_WEIGHT): no creates once today's weighted hours reach it. */
  dailySmallMachineHours: number;
  /** At most this many creates per repo in any rolling hour. */
  createsPerRepoPerHour: number;
  /** Each create counts at least this long (times its size weight) against the budget, however short the machine lived. */
  createChargeMinutes: number;
  proxyPortRange: [number, number];
  forwardEnv: string[];
  sandboxUser: string;
  tickSeconds: number;
  /** The repo setup script (~/.t3lizard/repos/<owner>/<name>/setup.sh) is stopped after this long. */
  setupTimeoutMinutes: number;
  /** How long an account that hit its usage limit is skipped before it is tried again. */
  accountRetryMinutes: number;
  publicBind?: string[];
  publicHost?: string;
  /** Claude accounts in order. Not a config file key: one per CLAUDE_CODE_OAUTH_TOKEN[_N] secret. */
  accounts: AccountId[];
}

export type CloseReason = "idle" | "recycle" | "deadline" | "failed" | "orphan" | "manual";

export type Action =
  | { kind: "grant"; ticketId: string; machineId: MachineId }
  | { kind: "create"; repo: RepoKey; size: Size }
  | { kind: "extend"; machineId: MachineId; deadline: number }
  | { kind: "expireLease"; leaseId: string }
  | { kind: "close"; machineId: MachineId; reason: CloseReason }
  | { kind: "expireTicket"; ticketId: string }
  | { kind: "continueThread"; machineId: MachineId; threadId: string; runId: string; account: AccountId }
  | { kind: "extendLease"; leaseId: string; expiresAt: number };

export function emptyState(): State {
  return { machines: {}, leases: {}, tickets: [], usage: {} };
}
