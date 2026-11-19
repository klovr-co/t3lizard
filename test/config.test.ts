import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig, parseConfig } from "../src/config.ts";

test("the default ladder is the trial's 1 small and 2 mini; nano is left out", () => {
  assert.deepEqual(DEFAULT_CONFIG.sizes, [{ size: "small", max: 1 }, { size: "mini", max: 2 }]);
  assert.deepEqual(parseConfig({ project: "p" }).sizes, DEFAULT_CONFIG.sizes);
});

test("an older config with size, totalCap and dailyMachineHours still loads, unchanged in meaning", () => {
  // The live config on 2026-11-20.
  const live = { project: "p", size: "small", totalCap: 1, perRepoCap: 1, lifetimeMinutes: 60, maxLifetimeMinutes: 60, dailyMachineHours: 8, forwardEnv: ["GH_TOKEN"] };
  const c = parseConfig(live);
  assert.deepEqual(c.sizes, [{ size: "small", max: 1 }]);
  assert.equal(c.dailySmallMachineHours, 8);
  assert.equal(c.perRepoCap, 1);
  assert.equal("totalCap" in c || "size" in c || "dailyMachineHours" in c, false);
  assert.deepEqual(parseConfig({ project: "p", totalCap: 3 }).sizes, [{ size: "small", max: 3 }]);
  assert.deepEqual(parseConfig({ project: "p", size: "mini" }).sizes, [{ size: "mini", max: 1 }]);
});

test("sizes are sorted largest first and checked", () => {
  assert.deepEqual(parseConfig({ sizes: [{ size: "nano", max: 2 }, { size: "mini", max: 2 }, { size: "small", max: 1 }] }).sizes.map((s) => s.size), ["small", "mini", "nano"]);
  assert.throws(() => parseConfig({ sizes: [{ size: "mini", max: 1 }], totalCap: 2 }), /give "sizes", or the older "size" and "totalCap", not both/);
  assert.throws(() => parseConfig({ sizes: [{ size: "mini", max: 1 }, { size: "mini", max: 2 }] }), /"mini" is listed twice/);
  assert.throws(() => parseConfig({ sizes: [] }));
  assert.throws(() => parseConfig({ sizes: [{ size: "huge", max: 1 }] }));
  assert.throws(() => parseConfig({ dailyMachineHours: 5, dailySmallMachineHours: 5 }), /not both/);
  assert.throws(() => parseConfig({ sizes: [{ size: "mini", max: 0 }] }));
});

test("loadConfig names the file in its error", () => {
  const home = mkdtempSync(join(tmpdir(), "t3lizard-config-"));
  writeFileSync(join(home, "config.json"), JSON.stringify({ size: "small", sizes: [{ size: "mini", max: 1 }] }));
  assert.throws(() => loadConfig(home), new RegExp(`bad ${home}/config\\.json: give "sizes"`));
});
