// Runs the real daemon, API and tick loop with a fake provider and a fake local t3.
// Usage: T3LIZARD_HOME=<tmp dir> node scripts/fake-daemon.ts
import { mkdirSync } from "node:fs";
import { runDaemon } from "../src/cli.ts";
import { DEFAULT_CONFIG, t3lizardHome } from "../src/config.ts";
import { resolveRepo } from "../src/repo.ts";
import { FakeProvider, FakeT3 } from "../test/fakes.ts";

const home = t3lizardHome();
mkdirSync(home, { recursive: true });
await runDaemon({
  provider: new FakeProvider(),
  t3: new FakeT3(),
  config: { ...DEFAULT_CONFIG, project: "fake", tickSeconds: 1, proxyPortRange: [47360, 47379], accounts: ["claudeAgent_acct1"] },
  machineEnv: { GH_TOKEN: "fake" },
  accountTokens: { claudeAgent_acct1: "fake" },
  home,
  resolveRepo,
  now: Date.now,
  sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))),
  log: (line) => console.log(line),
});
