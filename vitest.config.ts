import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The perf suite (test/core/perf.test.ts, Task 9) runs only under PERF=1 (npm run test:perf).
const perf = process.env.PERF === "1";

export default defineConfig({
  // Tests only: "vscode" resolves to the fake in test/fakes (v0.7). esbuild.mjs bundles with
  // vscode external and never reads this file, so the alias cannot reach dist/extension.js.
  resolve: { alias: [{ find: /^vscode$/, replacement: fileURLToPath(new URL("./test/fakes/vscode.ts", import.meta.url)) }] },
  test: {
    include: ["test/core/**/*.test.ts"],
    exclude: ["test/integration/**", "node_modules/**", ...(perf ? [] : ["test/core/perf.test.ts"])],
    passWithNoTests: false,
    env: { TZ: "America/Toronto" },
  },
});
