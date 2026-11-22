import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyProbe, parseResetTime } from "../src/probe.ts";

const NOW = Date.parse("2026-11-22T16:05:30Z"); // 00:05 on 23 Nov in Kuala Lumpur
const cli = (o: object) => JSON.stringify({ type: "result", subtype: "success", ...o });

test("classifyProbe reads the CLI's real answers", () => {
  assert.deepEqual(classifyProbe(cli({ is_error: false, result: "OK" }), NOW), { kind: "ok", note: "OK" });
  assert.equal(
    classifyProbe(cli({ is_error: true, api_error_status: 403, result: "Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead" }), NOW).kind,
    "disabled",
  );
  assert.equal(classifyProbe(cli({ is_error: true, api_error_status: 401, result: "Failed to authenticate. API Error: 401 OAuth access token is invalid." }), NOW).kind, "auth");
  assert.equal(classifyProbe(cli({ is_error: true, api_error_status: 401, result: "Failed to authenticate: OAuth token revoked. Please log in again" }), NOW).kind, "auth");
  assert.equal(classifyProbe(cli({ is_error: true, api_error_status: 500, result: "Internal server error" }), NOW).kind, "error", "a server error says nothing about the account");
});

test("a usage limit carries its reset time, in the CLI's own timezone", () => {
  const r = classifyProbe(cli({ is_error: true, api_error_status: 429, result: "You've hit your 5-hour limit · resets 2:20am (Asia/Kuala_Lumpur)" }), NOW);
  assert.equal(r.kind, "limit");
  assert.equal(r.resetsAt, Date.parse("2026-11-22T18:20:00Z"));
  assert.equal(parseResetTime("resets 12:05am (Asia/Kuala_Lumpur)", NOW), Date.parse("2026-11-22T16:06:00Z"), "a reset this minute lands on the next one");
  assert.equal(parseResetTime("resets 11pm (UTC)", NOW), Date.parse("2026-11-22T23:00:00Z"));
  assert.equal(parseResetTime("resets 2am (Not/AZone)", NOW), undefined);
  assert.equal(parseResetTime("no time here", NOW), undefined);
});

test("output that is not an answer is an error, never a verdict on the account", () => {
  assert.equal(classifyProbe("", NOW, "spawn claude ENOENT").kind, "error");
  assert.match(classifyProbe("", NOW, "Command failed: timeout").note, /timeout/);
  assert.equal(classifyProbe("<html>gateway</html>", NOW).kind, "error");
});

test("a probe's note never carries more than 160 characters of the CLI's words", () => {
  assert.equal(classifyProbe(cli({ is_error: false, result: "x".repeat(500) }), NOW).note.length, 160);
});
