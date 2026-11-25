import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { antigravityTokenFromSecrets, DEFAULT_CONFIG, isAccountTokenKey, loadConfig, loadSecrets, parseConfig } from "../src/config.ts";

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

test("loadSecrets reads the environment, and the environment wins over secrets.env", () => {
  const home = mkdtempSync(join(tmpdir(), "t3lizard-secrets-"));
  assert.deepEqual(loadSecrets(home, { LIZARD_API_KEY: "env" }), { LIZARD_API_KEY: "env" });
  writeFileSync(join(home, "secrets.env"), "LIZARD_API_KEY=file\nGH_TOKEN=file\n");
  assert.deepEqual(loadSecrets(home, { LIZARD_API_KEY: "env" }), { LIZARD_API_KEY: "env", GH_TOKEN: "file" });
});

test("antigravityTokenFromSecrets accepts raw JSON and base64, rejects malformed values, and is never forwarded as env", () => {
  const raw = JSON.stringify({ token: { access_token: "a", refresh_token: "r" }, auth_method: "consumer" });
  const b64 = Buffer.from(raw).toString("base64");
  assert.equal(antigravityTokenFromSecrets({}), undefined);
  assert.equal(antigravityTokenFromSecrets({ ANTIGRAVITY_OAUTH_TOKEN: raw }), raw);
  assert.equal(antigravityTokenFromSecrets({ ANTIGRAVITY_OAUTH_TOKEN: b64 }), raw);
  assert.throws(() => antigravityTokenFromSecrets({ ANTIGRAVITY_OAUTH_TOKEN: "not-json" }), /valid JSON/);
  assert.throws(() => antigravityTokenFromSecrets({ ANTIGRAVITY_OAUTH_TOKEN: "{}" }), /missing its "token" field/);
  assert.equal(isAccountTokenKey("ANTIGRAVITY_OAUTH_TOKEN"), true);
  const cfg = parseConfig({ project: "p", defaultProvider: "antigravity", defaultModel: "gemini-4-neon" });
  assert.equal(cfg.defaultProvider, "antigravity");
  assert.equal(cfg.defaultModel, "gemini-4-neon");
});

test("account labels come from CLAUDE_ACCOUNT_LABEL_<n>, unquoted, and only for numbered accounts", async () => {
  const { accountLabelsFromSecrets } = await import("../src/config.ts");
  assert.deepEqual(
    accountLabelsFromSecrets({ CLAUDE_ACCOUNT_LABEL_1: "'claude-dev-klovr'", CLAUDE_ACCOUNT_LABEL_3: " claude-xianjun-klovr ", CLAUDE_ACCOUNT_LABEL_4: '"claude-maxine-klovr"', CLAUDE_ACCOUNT_LABEL_: "x", CLAUDE_ACCOUNT_LABEL_0: "x", CLAUDE_ACCOUNT_LABEL_2: "", OTHER: "y" }),
    { claudeAgent_acct1: "claude-dev-klovr", claudeAgent_acct3: "claude-xianjun-klovr", claudeAgent_acct4: "claude-maxine-klovr" },
  );
});

test("the provider defaults to lizard, so an existing config is unchanged", () => {
  const c = parseConfig({ project: "p" });
  assert.equal(c.provider, "lizard");
  assert.equal(c.template, "claude");
  assert.throws(() => parseConfig({ provider: "aws" }));
});

test("instabox needs no project, defaults to its own template and sizes, and refuses sizes it does not have", () => {
  const c = parseConfig({ provider: "instabox" });
  assert.equal(c.provider, "instabox");
  assert.equal(c.template, "agent-browser");
  assert.deepEqual(c.sizes, [{ size: "medium", max: 1 }, { size: "small", max: 2 }]);
  assert.equal(parseConfig({ provider: "instabox", template: "mine" }).template, "mine");
  assert.deepEqual(parseConfig({ provider: "instabox", sizes: [{ size: "large", max: 1 }] }).sizes, [{ size: "large", max: 1 }]);
  assert.throws(() => parseConfig({ provider: "instabox", sizes: [{ size: "mini", max: 1 }] }), /InstaBox has no "mini" size \(it has small, medium, large\)/);
  assert.throws(() => parseConfig({ provider: "instabox", size: "nano" }), /no "nano" size/);
  assert.throws(() => parseConfig({ provider: "instabox", defaultSize: "big" }), /no "big" size/);
});

test("execConcurrency is a positive whole number, at most 64 on instabox, where every daemon on a Pro workspace shares 64", () => {
  assert.equal(parseConfig({ provider: "instabox" }).execConcurrency, undefined);
  assert.equal(parseConfig({ provider: "instabox", execConcurrency: 16 }).execConcurrency, 16);
  assert.throws(() => parseConfig({ provider: "instabox", execConcurrency: 65 }), /at most 64/);
  assert.throws(() => parseConfig({ provider: "instabox", execConcurrency: 0 }));
  assert.throws(() => parseConfig({ provider: "instabox", execConcurrency: 1.5 }));
});

test("autoSuspendMinutes takes 0 or 5-30, InstaBox's range", () => {
  assert.equal(parseConfig({ provider: "instabox", autoSuspendMinutes: 30 }).autoSuspendMinutes, 30);
  assert.equal(parseConfig({ provider: "instabox", autoSuspendMinutes: 0 }).autoSuspendMinutes, 0);
  assert.throws(() => parseConfig({ provider: "instabox", autoSuspendMinutes: 3 }));
});
