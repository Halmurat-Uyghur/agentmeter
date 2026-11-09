// Integration tests run by `npm run test:integration` (Mocha in the extension host).
import { defineConfig } from "@vscode/test-cli";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Synthetic fixture root, seeded by the integration tests (Task 8). Never the real ~/.copilot.
export const FIXTURE_ROOT = join(tmpdir(), "agentmeter-fixture");
// Claude Code and Codex fixture roots, likewise seeded by the tests; never the real ~/.claude or ~/.codex.
export const FIXTURE_CLAUDE_ROOT = join(tmpdir(), "agentmeter-fixture-claude");
export const FIXTURE_CODEX_ROOT = join(tmpdir(), "agentmeter-fixture-codex");

export default defineConfig({
  files: "out/test/integration/**/*.test.js",
  version: "1.90.0",
  env: { COPILOT_HOME: FIXTURE_ROOT, CLAUDE_CONFIG_DIR: FIXTURE_CLAUDE_ROOT, CODEX_HOME: FIXTURE_CODEX_ROOT },
  // A short user-data folder keeps VS Code's IPC socket path under macOS's 103-char limit.
  launchArgs: ["--user-data-dir", join(tmpdir(), "cum-vscode-test")],
  mocha: { ui: "tdd", timeout: 60000 },
});
