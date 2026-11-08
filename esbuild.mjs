// Bundles src/extension.ts → dist/extension.js for the VS Code extension host.
import { build } from "esbuild";

await build({
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  sourcemap: false,
  minify: false,
  logLevel: "info",
});
