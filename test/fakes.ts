import { ownSandboxLister, sandboxAlive } from "../src/lizard.ts";
import type { ExecResult, Lizard, SandboxDirectory } from "../src/lizard.ts";
import type { LocalT3 } from "../src/t3local.ts";
import type { MachineId, RepoKey, Size } from "../src/types.ts";

export interface FakeMachine {
  metadata: Record<string, string>;
  status: string;
  repo: RepoKey;
  size: Size;
  deadline: number;
  files: Map<string, { content: string; mode: string }>;
  steps: string[];
}

type StepHandler = (m: FakeMachine, args: string[]) => ExecResult | undefined;

const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", exitCode: 0 });

/**
 * An in-memory Lizard. Each exec is dispatched on the `# t3lizard:<step>` line that every
 * machine script starts with; `on[step]` overrides a step's default answer.
 *
 * Like the real API, `listSandboxes()` carries no metadata and `getInfo()` does. `list()` and
 * `alive()` run the production code over those two calls.
 */
export class FakeLizard implements Lizard, SandboxDirectory {
  machines = new Map<MachineId, FakeMachine>();
  killed: MachineId[] = [];
  timeouts: [MachineId, number][] = [];
  nextCreateError?: Error;
  on: Record<string, StepHandler> = {};
  threads: { status: string }[] = [];
  /** What `accounts.mjs scan` reports per machine: threads stopped on a usage limit. */
  limited = new Map<MachineId, { threadId: string; runId: string; account: string; requestedAt: string; notice: string }[]>();
  /** Each `accounts.mjs continue` call: [machine, thread, run, account]. */
  continued: [MachineId, string, string, string][] = [];
  getInfoCalls: MachineId[] = [];
  /** Sandboxes created but missing from listSandboxes(), as a lagging listing would. */
  hiddenFromList = new Set<MachineId>();
  private n = 0;
  list = ownSandboxLister(this);
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  async create(repo: RepoKey, size: Size, lifetimeMs: number) {
    if (this.nextCreateError) {
      const e = this.nextCreateError;
      this.nextCreateError = undefined;
      throw e;
    }
    const id = `sb-${++this.n}`;
    const deadline = this.now() + lifetimeMs;
    this.machines.set(id, { metadata: { t3lizard: "1", repo }, status: "running", repo, size, deadline, files: new Map(), steps: [] });
    return { id, deadline };
  }

  /** A sandbox someone else started in the same project. */
  addForeign(id: MachineId, metadata: Record<string, string> = {}) {
    this.machines.set(id, { metadata, status: "running", repo: "", size: "small", deadline: this.now() + 3_600_000, files: new Map(), steps: [] });
  }

  async listSandboxes() {
    return [...this.machines]
      .filter(([id]) => !this.hiddenFromList.has(id))
      .map(([id, m]) => ({ sandboxId: id, id, status: m.status, size: m.size }));
  }

  async getInfo(id: MachineId) {
    this.getInfoCalls.push(id);
    const m = this.machines.get(id);
    return m && { sandboxId: id, status: m.status, metadata: { ...m.metadata } };
  }

  alive(id: MachineId) {
    return sandboxAlive(this, id);
  }

  async exec(id: MachineId, cmd: string[]): Promise<ExecResult> {
    const m = this.machines.get(id);
    if (!m) throw new Error(`sandbox ${id} not found`);
    const step = cmd[2].match(/# t3lizard:([\w-]+)/)?.[1] ?? "unknown";
    const args = cmd.slice(4);
    m.steps.push(step);
    const custom = this.on[step]?.(m, args);
    if (custom) return custom;
    switch (step) {
      case "write":
        m.files.set(args[0], { content: Buffer.from(args[1], "base64").toString(), mode: args[2] });
        return ok();
      case "install-poll":
        return ok("done\n");
      case "project":
        return ok(`Cloning...\nWORKSPACE=/home/user/${args[1]}\nPROJECT=11111111-2222-3333-4444-555555555555\n`);
      case "pair":
        return ok(`{"credential":"pair-${id}-${m.steps.length}"}\n`);
      case "repo-setup-poll":
        return ok("exit=0\n");
      case "threads":
        return ok(JSON.stringify(this.threads));
      case "scan":
        return ok(JSON.stringify({ limited: this.limited.get(id) ?? [] }));
      case "continue":
        this.continued.push([id, args[0], args[1], args[2]]);
        return ok(JSON.stringify({ threadId: args[0], account: args[2], runId: "next", delivery: "started" }));
      default:
        return ok();
    }
  }

  async exposePort(id: MachineId, port: number) {
    return { hostname: `${id}-${port}.fake.lizard`, accessToken: `tok-${id}` };
  }

  async setTimeout(id: MachineId, msFromNow: number) {
    this.timeouts.push([id, msFromNow]);
    const m = this.machines.get(id);
    if (m) m.deadline = this.now() + msFromNow;
  }

  async kill(id: MachineId) {
    this.killed.push(id);
    this.machines.delete(id);
  }
}

export class FakeT3 implements LocalT3 {
  links = new Map<string, { url: string; code: string }>();
  unlinked: string[] = [];
  failLinks = 0;
  private n = 0;

  async version() {
    return "0.1.11-nightly.20261119.4928";
  }

  async link(url: string, code: string) {
    if (this.failLinks > 0) {
      this.failLinks--;
      throw new Error("t3 environment link failed: connection refused");
    }
    const id = `env-${++this.n}`;
    this.links.set(id, { url, code });
    return id;
  }

  async unlink(environmentId: string) {
    this.unlinked.push(environmentId);
    this.links.delete(environmentId);
  }
}

export const noSleep = async () => {};
