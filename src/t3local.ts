import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The devbox's own T3 Code CLI. The daemon depends on this, so tests use a fake. */
export interface LocalT3 {
  /** Exact version, e.g. "0.1.11-nightly.20261119.4928". */
  version(): Promise<string>;
  /** Returns the new environment id. */
  link(url: string, pairingCode: string): Promise<string>;
  /** Succeeds when the environment is already gone. */
  unlink(environmentId: string): Promise<void>;
}

export function realLocalT3(cli = process.env.T3LIZARD_T3_CLI ?? "t3"): LocalT3 {
  const t3 = async (args: string[]) => {
    try {
      const { stdout } = await run(cli, args, { timeout: 90_000, maxBuffer: 16 << 20 });
      return stdout;
    } catch (e) {
      const err = e as { stderr?: string; stdout?: string; message: string };
      throw new Error(`t3 ${args.slice(0, 2).join(" ")} failed: ${(err.stderr || err.stdout || err.message).trim()}`);
    }
  };
  return {
    async version() {
      return parseVersion(await t3(["--version"]));
    },
    async link(url, pairingCode) {
      return parseLinkedId(await t3(["environment", "link", url, "--pairing-code", pairingCode, "--access", "full-access"]));
    },
    async unlink(environmentId) {
      try {
        await t3(["environment", "unlink", environmentId]);
      } catch (e) {
        if (!/not.?found|unknown|no such/i.test((e as Error).message)) throw e;
      }
    },
  };
}

export function parseVersion(out: string): string {
  const m = out.match(/v?(\d+\.\d+\.\d+[\w.-]*)/);
  if (!m) throw new Error(`cannot parse t3 version from "${out.trim()}"`);
  return m[1];
}

/** `t3 environment link` prints "Linked <label> (<environmentId>) with <access> access, until <iso>." */
export function parseLinkedId(out: string): string {
  const m = out.match(/Linked .* \(([^)\s]+)\) with/);
  if (!m) throw new Error(`linked, but could not read the environment id from: ${out.trim()}`);
  return m[1];
}
