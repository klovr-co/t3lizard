import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addStep, parseSteps, readHistory, readSetup, removeStep, repoDir } from "../src/setup.ts";

const REPO = "github.com/klovr-co/aldrent";
const NOW = Date.parse("2026-11-20T08:00:00Z");
const home = () => mkdtempSync(join(tmpdir(), "t3lizard-setup-"));

test("the setup lives at repos/<owner>/<name> and a key cannot climb out of it", () => {
  assert.equal(repoDir("/h", REPO), "/h/repos/klovr-co/aldrent");
  assert.throws(() => repoDir("/h", "github.com/../etc"), /cannot make a setup path/);
  assert.throws(() => repoDir("/h", "aldrent"), /cannot make a setup path/);
});

test("addStep starts the script with a header, appends dated steps, and logs history", () => {
  const h = home();
  assert.equal(readSetup(h, REPO).exists, false);
  const a = addStep(h, REPO, { line: "command -v bun >/dev/null || curl -fsSL https://bun.sh/install | bash", reason: "aldrent needs bun", by: "thread-1", now: NOW });
  assert.equal(a.added, true);
  assert.equal(a.step.n, 1);
  const b = addStep(h, REPO, { line: "  sudo -n apt-get install -y jq  ", reason: "jq missing in the e2e job", now: NOW + 86_400_000 });
  assert.equal(b.step.n, 2);

  const setup = readSetup(h, REPO);
  assert.match(setup.script!, /^#!\/usr\/bin\/env bash\n# t3lizard machine setup for github\.com\/klovr-co\/aldrent\./);
  assert.match(setup.script!, /\n# 2026-11-20: aldrent needs bun \(thread-1\)\ncommand -v bun/);
  assert.match(setup.script!, /\n# 2026-11-21: jq missing in the e2e job\nsudo -n apt-get install -y jq\n$/);
  assert.deepEqual(setup.steps.map((s) => s.n), [1, 2]);
  assert.equal(statSync(setup.path).mode & 0o777, 0o600);
  assert.equal(spawnSync("bash", ["-n", setup.path]).status, 0, "the script is valid bash");
  assert.deepEqual(readHistory(h, REPO).map((e) => [e.action, e.step, e.by]), [["add", 1, "thread-1"], ["add", 2, undefined]]);
});

test("the same line is not added twice, and bad lines are refused", () => {
  const h = home();
  addStep(h, REPO, { line: "echo a", reason: "r", now: NOW });
  const again = addStep(h, REPO, { line: " echo a ", reason: "another agent hit it too", now: NOW });
  assert.equal(again.added, false);
  assert.equal(again.note, "already step 1");
  assert.equal(readSetup(h, REPO).steps.length, 1);
  assert.throws(() => addStep(h, REPO, { line: "echo a\nrm -rf ~", reason: "r", now: NOW }), /line must be one line/);
  assert.throws(() => addStep(h, REPO, { line: "echo b", reason: " ", now: NOW }), /reason is empty/);
  assert.throws(() => addStep(h, REPO, { line: "# just a comment", reason: "r", now: NOW }), /comment/);
});

test("removeStep drops one step, keeps hand edits, and the history keeps the removed line", () => {
  const h = home();
  addStep(h, REPO, { line: "echo one", reason: "first", now: NOW });
  addStep(h, REPO, { line: "echo two", reason: "bad one", now: NOW });
  addStep(h, REPO, { line: "echo three", reason: "third", now: NOW });
  const path = readSetup(h, REPO).path;
  writeFileSync(path, `${readFileSync(path, "utf8")}echo hand-edited\n`);
  const out = removeStep(h, REPO, { n: 2, by: "dev", now: NOW });
  assert.equal(out.removed.line, "echo two");
  const setup = readSetup(h, REPO);
  assert.deepEqual(setup.steps.map((s) => s.line), ["echo one", "echo three"]);
  assert.doesNotMatch(setup.script!, /bad one|echo two/);
  assert.match(setup.script!, /echo hand-edited\n$/);
  assert.deepEqual(readHistory(h, REPO).at(-1), { at: "2026-11-20T08:00:00.000Z", action: "remove", step: 2, line: "echo two", reason: "bad one", by: "dev" });
  assert.throws(() => removeStep(h, REPO, { n: 9, now: NOW }), /has no setup step 9 \(it has 2\)/);
});

test("parseSteps numbers only dated comments followed by a line", () => {
  const steps = parseSteps("#!/usr/bin/env bash\n# a note\necho untracked\n\n# 2026-01-02: why\n\necho tracked\n# 2026-01-03: dangling\n");
  assert.deepEqual(steps, [{ n: 1, date: "2026-01-02", reason: "why", line: "echo tracked" }]);
});

test("the committed aldrent example is valid bash with guarded bun steps", () => {
  const file = join(import.meta.dirname, "../examples/repos/klovr-co/aldrent/setup.sh");
  assert.equal(spawnSync("bash", ["-n", file]).status, 0);
  const steps = parseSteps(readFileSync(file, "utf8"));
  assert.ok(steps.some((s) => s.line.includes("https://bun.sh/install") && s.line.startsWith('[ -x "$HOME/.bun/bin/bun" ] ||')));
  assert.ok(steps.some((s) => s.line.includes('"$HOME/.local/bin/bun"')));
});
