import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RepoKey } from "./types.ts";

const run = promisify(execFile);

/** "git@github.com:Acme/app.git", "https://x@github.com/Acme/app", ... -> "github.com/Acme/app" */
export function normalizeOrigin(origin: string): RepoKey {
  let s = origin.trim();
  const scp = s.match(/^[\w.-]+@([^:/]+):(.+)$/);
  if (scp) s = `${scp[1]}/${scp[2]}`;
  else if (/^[a-z+]+:\/\//i.test(s)) {
    const u = new URL(s);
    s = `${u.hostname}${u.pathname}`;
  }
  const parts = s.replace(/\.git$/, "").split("/").filter(Boolean);
  if (parts.length < 3) throw new Error(`not a repository origin: ${origin}`);
  return [parts[0].toLowerCase(), ...parts.slice(1)].join("/");
}

/** Accepts an origin URL, or a path to a local checkout whose `origin` remote is read. */
export async function resolveRepo(input: string): Promise<RepoKey> {
  if (!/^[./]/.test(input)) return normalizeOrigin(input);
  const { stdout } = await run("git", ["-C", input, "remote", "get-url", "origin"]);
  return normalizeOrigin(stdout);
}
