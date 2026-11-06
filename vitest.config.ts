import { defineConfig } from "vitest/config";

// The perf suite (test/core/perf.test.ts, Task 9) runs only under PERF=1 (npm run test:perf).
const perf = process.env.PERF === "1";

export default defineConfig({
  test: {
    include: ["test/core/**/*.test.ts"],
    exclude: ["test/integration/**", "node_modules/**", ...(perf ? [] : ["test/core/perf.test.ts"])],
    passWithNoTests: false,
    env: { TZ: "America/Toronto" },
  },
});
