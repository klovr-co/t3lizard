import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoKey } from "./types.ts";

/**
 * Per-repo machine setup, kept on the devbox at ~/.t3lizard/repos/<owner>/<name>/setup.sh.
 * Bring-up runs it on every new machine for the repo, as the sandbox user, in the checkout,
 * after the clone and before the machine is handed out. Agents add steps when a job fails on a
 * missing tool, so the next machine has it. Every change is also appended to history.jsonl.
 *
 * A step is a dated comment line followed by one shell line:
 *   # 2026-11-20: aldrent needs bun; the claude image has none
 *   [ -x "$HOME/.bun/bin/bun" ] || curl -fsSL https://bun.sh/install | bash
 * Lines without such a comment (hand edits) are kept as they are and are not numbered.
 */

export interface SetupStep {
  /** 1-based, in file order. */
  n: number;
  date: string;
  reason: string;
  line: string;
}

export interface RepoSetup {
  repo: RepoKey;
  path: string;
  exists: boolean;
  script?: string;
  /** sha256 of the script, so a machine that already ran this exact script can skip it. */
  hash?: string;
  steps: SetupStep[];
}

const STEP_COMMENT = /^# (\d{4}-\d{2}-\d{2}): (.*)$/;
const MAX_LINE = 2000;

export function setupHeader(repo: RepoKey): string {
  return `#!/usr/bin/env bash
# t3lizard machine setup for ${repo}.
# Runs on every new machine for this repo: as the sandbox user, in the checkout, after the clone
# and before the machine is handed out. Every step must be safe to run twice.
# Add a step:    t3lizard setup add ${repo} -- <shell line>    (agents: pool_setup_add)
# Remove a step: t3lizard setup remove ${repo} <step number>   (numbers: t3lizard setup show)
set -euo pipefail
`;
}

/** ~/.t3lizard/repos/<owner>/<name>. The key is host/owner/name; the host is left out of the path. */
export function repoDir(home: string, repo: RepoKey): string {
  const parts = repo.split("/");
  const [owner, name] = parts.slice(-2);
  const safe = (s: string | undefined) => !!s && /^[A-Za-z0-9._-]+$/.test(s) && s !== "." && s !== "..";
  if (parts.length < 3 || !safe(owner) || !safe(name)) throw new Error(`cannot make a setup path from repo key ${repo}`);
  return join(home, "repos", owner, name);
}

export function parseSteps(script: string): SetupStep[] {
  const lines = script.split("\n");
  const steps: SetupStep[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(STEP_COMMENT);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === "") j++;
    if (j >= lines.length || lines[j].startsWith("#")) continue;
    steps.push({ n: steps.length + 1, date: m[1], reason: m[2], line: lines[j] });
    i = j;
  }
  return steps;
}

export function readSetup(home: string, repo: RepoKey): RepoSetup {
  const path = join(repoDir(home, repo), "setup.sh");
  if (!existsSync(path)) return { repo, path, exists: false, steps: [] };
  const script = readFileSync(path, "utf8");
  return { repo, path, exists: true, script, hash: createHash("sha256").update(script).digest("hex"), steps: parseSteps(script) };
}

function oneLine(value: string, what: string): string {
  const v = value.trim();
  if (!v) throw new Error(`${what} is empty`);
  if (/[\r\n]/.test(v)) throw new Error(`${what} must be one line`);
  if (v.length > MAX_LINE) throw new Error(`${what} is longer than ${MAX_LINE} characters`);
  return v;
}

function write(path: string, content: string): void {
  writeFileSync(`${path}.tmp`, content, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

function history(home: string, repo: RepoKey, entry: Record<string, unknown>): void {
  appendFileSync(join(repoDir(home, repo), "history.jsonl"), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

/** Appends one step. A line already in the script is not added twice. */
export function addStep(
  home: string,
  repo: RepoKey,
  req: { line: string; reason: string; by?: string; now: number },
): { added: boolean; step: SetupStep; note?: string; path: string } {
  const line = oneLine(req.line, "line");
  const reason = oneLine(req.reason, "reason");
  if (line.startsWith("#")) throw new Error("line is a comment; give the shell command");
  const current = readSetup(home, repo);
  const existing = current.steps.find((s) => s.line.trim() === line);
  if (existing) return { added: false, step: existing, note: `already step ${existing.n}`, path: current.path };
  const date = new Date(req.now).toISOString().slice(0, 10);
  const by = req.by ? ` (${oneLine(req.by, "by")})` : "";
  const base = current.script ?? setupHeader(repo);
  const script = `${base.endsWith("\n") ? base : `${base}\n`}\n# ${date}: ${reason}${by}\n${line}\n`;
  mkdirSync(repoDir(home, repo), { recursive: true, mode: 0o700 });
  write(current.path, script);
  const step = parseSteps(script).at(-1)!;
  history(home, repo, { at: new Date(req.now).toISOString(), action: "add", step: step.n, line, reason, ...(req.by ? { by: req.by } : {}) });
  return { added: true, step, path: current.path };
}

/** Removes step n (its comment and its line). The history keeps what was removed. */
export function removeStep(home: string, repo: RepoKey, req: { n: number; by?: string; now: number }): { removed: SetupStep; path: string } {
  const current = readSetup(home, repo);
  const step = current.steps.find((s) => s.n === req.n);
  if (!current.script || !step) throw new Error(`${repo} has no setup step ${req.n} (it has ${current.steps.length})`);
  const lines = current.script.split("\n");
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!STEP_COMMENT.test(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === "") j++;
    if (j >= lines.length || lines[j].startsWith("#")) continue;
    if (++seen === req.n) {
      const start = i > 0 && lines[i - 1].trim() === "" ? i - 1 : i;
      lines.splice(start, j - start + 1);
      break;
    }
    i = j;
  }
  write(current.path, lines.join("\n"));
  history(home, repo, { at: new Date(req.now).toISOString(), action: "remove", step: step.n, line: step.line, reason: step.reason, ...(req.by ? { by: req.by } : {}) });
  return { removed: step, path: current.path };
}

export function readHistory(home: string, repo: RepoKey): Record<string, unknown>[] {
  const file = join(repoDir(home, repo), "history.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
