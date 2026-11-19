import { test } from "node:test";
import assert from "node:assert/strict";
import { ownSandboxLister, sandboxAlive } from "../src/lizard.ts";
import type { SandboxDirectory } from "../src/lizard.ts";

// Shaped like the real API: list rows carry no metadata; getInfo does.
function directory(sandboxes: Record<string, { status: string; metadata?: Record<string, string> }>) {
  const calls: string[] = [];
  let failInfo = new Set<string>();
  const dir: SandboxDirectory = {
    listSandboxes: async () => Object.entries(sandboxes).map(([id, s]) => ({ sandboxId: id, id, status: s.status, size: "small" })),
    getInfo: async (id) => {
      calls.push(id);
      if (failInfo.has(id)) throw new Error("502 Bad Gateway");
      const s = sandboxes[id];
      return s && { sandboxId: id, status: s.status, metadata: s.metadata };
    },
  };
  return { dir, calls, sandboxes, failInfoFor: (ids: string[]) => (failInfo = new Set(ids)) };
}

test("list finds t3lizard sandboxes through getInfo, since list rows have no metadata", async () => {
  const d = directory({
    a: { status: "running", metadata: { t3lizard: "1", repo: "github.com/acme/app" } },
    b: { status: "running", metadata: { owner: "someone else" } },
    c: { status: "running" },
    d: { status: "stopped", metadata: { t3lizard: "1" } },
  });
  const list = ownSandboxLister(d.dir);
  assert.deepEqual(await list(), ["a"]);
  assert.deepEqual(d.calls.sort(), ["a", "b", "c"], "a stopped sandbox needs no lookup");
  assert.deepEqual(await list(), ["a"]);
  assert.equal(d.calls.length, 3, "metadata is fixed at create, so each sandbox is looked up once");
});

test("a sandbox whose getInfo fails is left out and asked about again next time", async () => {
  const d = directory({ a: { status: "running", metadata: { t3lizard: "1" } } });
  const list = ownSandboxLister(d.dir);
  d.failInfoFor(["a"]);
  assert.deepEqual(await list(), [], "when in doubt it is not ours, so it can never be killed as an orphan");
  d.failInfoFor([]);
  assert.deepEqual(await list(), ["a"]);
});

test("alive is false for a sandbox Lizard no longer knows or reports stopped or crashed", async () => {
  const d = directory({ a: { status: "running" }, b: { status: "crashed" }, c: { status: "stopped" } });
  assert.equal(await sandboxAlive(d.dir, "a"), true);
  assert.equal(await sandboxAlive(d.dir, "b"), false);
  assert.equal(await sandboxAlive(d.dir, "c"), false);
  assert.equal(await sandboxAlive(d.dir, "gone"), false);
  d.failInfoFor(["a"]);
  await assert.rejects(sandboxAlive(d.dir, "a"), /502/, "an error is not proof the sandbox is gone");
});
