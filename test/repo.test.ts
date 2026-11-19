import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeOrigin, resolveRepo } from "../src/repo.ts";

test("normalizes every common origin form to host/owner/repo", () => {
  for (const origin of [
    "git@github.com:Acme/app.git",
    "https://github.com/Acme/app.git",
    "https://x-access-token:secret@GitHub.com/Acme/app",
    "ssh://git@github.com/Acme/app.git",
    "github.com/Acme/app/",
  ]) {
    assert.equal(normalizeOrigin(origin), "github.com/Acme/app", origin);
  }
  assert.throws(() => normalizeOrigin("app"));
});

test("reads the origin of a local checkout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "t3lizard-repo-"));
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "git@github.com:Acme/app.git"]);
  assert.equal(await resolveRepo(dir), "github.com/Acme/app");
});
