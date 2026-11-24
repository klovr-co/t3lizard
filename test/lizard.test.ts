import { test } from "node:test";
import assert from "node:assert/strict";
import { NotFoundError } from "@lizard-build/sdk";
import { ownSandboxLister, sandboxAlive, waitReady } from "../src/lizard.ts";
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

test("waitReady retries NotFoundError (Lizard's answer to a sandbox that is not up yet) and returns once a command runs", async () => {
  let calls = 0;
  const sb = {
    process: {
      exec: async () => {
        if (++calls < 3) throw new NotFoundError("Sandbox already deleted");
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    },
  };
  await waitReady(sb as never, "user", 5_000, 1);
  assert.equal(calls, 3);
});

test("waitReady gives up with the NotFoundError after the timeout, and never retries other errors", async () => {
  const gone = { process: { exec: async () => { throw new NotFoundError("Sandbox already deleted"); } } };
  await assert.rejects(waitReady(gone as never, "user", 30, 5), /already deleted/);
  let calls = 0;
  const broken = { process: { exec: async () => { calls++; throw new Error("502 Bad Gateway"); } } };
  await assert.rejects(waitReady(broken as never, "user", 5_000, 1), /502/);
  assert.equal(calls, 1);
});

test("a daemon with its own tag lists only its sandboxes, so two daemons on one key never take each other's for orphans", async () => {
  const d = directory({
    mine: { status: "running", metadata: { "t3lizard-xj": "1", repo: "github.com/acme/app" } },
    theirs: { status: "running", metadata: { t3lizard: "1", repo: "github.com/acme/app" } },
  });
  assert.deepEqual(await ownSandboxLister(d.dir, "t3lizard-xj")(), ["mine"]);
  assert.deepEqual(await ownSandboxLister(d.dir)(), ["theirs"]);
});
