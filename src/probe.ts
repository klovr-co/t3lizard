import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * What one Claude account can do right now, found by asking it for one word:
 * ok (works), limit (usage limit, maybe with its reset time), disabled (an admin turned its access
 * off), auth (the login is revoked, expired or wrong), error (anything else: network, timeout, a
 * CLI problem; says nothing about the account).
 */
export type ProbeKind = "ok" | "limit" | "disabled" | "auth" | "error";

export interface ProbeResult {
  kind: ProbeKind;
  /** The CLI's own words, trimmed. Never contains the token. */
  note: string;
  /** For a limit: when it frees, if the CLI said ("resets 2:20am (Asia/Kuala_Lumpur)"). */
  resetsAt?: number;
}

/** "resets 2:20am (Asia/Kuala_Lumpur)" -> the next time it is 2:20am there. */
export function parseResetTime(text: string, now: number): number | undefined {
  const m = text.match(/resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i);
  if (!m) return undefined;
  try {
    const hour = (Number(m[1]) % 12) + (m[3].toLowerCase() === "pm" ? 12 : 0);
    const minute = Number(m[2] ?? 0);
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: m[4], hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now));
    const at = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const delta = (hour * 60 + minute - (at("hour") * 60 + at("minute")) + 1440) % 1440;
    // Seconds into the current minute are dropped, so land on the minute boundary.
    return now - (now % 60_000) + (delta || 1) * 60_000;
  } catch {
    return undefined;
  }
}

/** Turns the CLI's `--output-format json` output (or a failure to run it) into a verdict. */
export function classifyProbe(stdout: string, now: number, failure?: string): ProbeResult {
  let d: { is_error?: boolean; api_error_status?: number | null; result?: unknown } | undefined;
  try {
    d = JSON.parse(stdout.trim().split("\n").pop() ?? "");
  } catch {
    // Not JSON: the CLI did not get as far as answering.
  }
  if (!d || typeof d !== "object") return { kind: "error", note: (failure ?? stdout).trim().slice(0, 160) || "no answer" };
  const text = typeof d.result === "string" ? d.result : "";
  const note = text.replace(/\s+/g, " ").trim().slice(0, 160);
  if (!d.is_error) return { kind: "ok", note };
  const status = d.api_error_status ?? undefined;
  if (status === 403 || /organization has disabled/i.test(text)) return { kind: "disabled", note };
  if (status === 429 || /hit your [\w-]+ limit|usage limit reached/i.test(text)) {
    const resetsAt = parseResetTime(text, now);
    return { kind: "limit", note, ...(resetsAt ? { resetsAt } : {}) };
  }
  if (status === 401 || /authenticate|token.{0,20}(revoked|expired|invalid)|invalid.{0,20}token|please run \/login|not logged in/i.test(text)) return { kind: "auth", note };
  return { kind: "error", note: note || (failure ?? "").slice(0, 160) };
}

/**
 * Asks the account for one word with the official Claude CLI, in an empty config dir, with no tools
 * and a one-line system prompt: about 0.01 cent and 4 seconds. The token goes only in the child's
 * environment, which holds nothing else of ours.
 */
export function probeAccount(token: string, opts: { cli?: string; timeoutMs?: number; now?: () => number } = {}): Promise<ProbeResult> {
  const dir = mkdtempSync(join(tmpdir(), "t3lizard-probe-"));
  const cli = opts.cli ?? process.env.T3LIZARD_CLAUDE_CLI ?? "claude";
  const args = ["-n", "10", cli, "-p", "ok", "--output-format", "json", "--max-turns", "1", "--model", "haiku", "--tools", "", "--system-prompt", "Reply with the word OK.", "--setting-sources", "", "--strict-mcp-config"];
  return new Promise((resolve) => {
    execFile(
      "nice",
      args,
      { env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8", CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_OAUTH_TOKEN: token }, cwd: dir, timeout: opts.timeoutMs ?? 60_000, maxBuffer: 1 << 20 },
      (err, stdout) => {
        rmSync(dir, { recursive: true, force: true });
        resolve(classifyProbe(String(stdout ?? ""), (opts.now ?? Date.now)(), err?.message));
      },
    );
  });
}
