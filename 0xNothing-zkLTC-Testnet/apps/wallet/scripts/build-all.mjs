import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * One command for the whole extension bundle:
 *   1. vite build            -> index.html + assets/ + background.js
 *   2. build-inject.mjs      -> content.js + inpage.js (IIFE)
 *
 * Kept as a script rather than an npm chain so it behaves the same on
 * cmd.exe, PowerShell and bash.
 *
 * Both steps are spawned as `node <script>` rather than through npx: since
 * Node 18.20 / 20.12, spawning a `.cmd` shim without a shell fails outright on
 * Windows (EINVAL), and running it *with* a shell would put the argument list
 * at the mercy of cmd.exe quoting. Vite's bin is located through its
 * package.json, which is the one subpath its exports map allows, so a hoisted
 * node_modules resolves the same way.
 */
const cwd = fileURLToPath(new URL("..", import.meta.url));
const viteBin = fileURLToPath(new URL("bin/vite.js", import.meta.resolve("vite/package.json")));

const steps = [
  { label: "app", args: [viteBin, "build"] },
  { label: "inject", args: ["scripts/build-inject.mjs"] },
];

for (const step of steps) {
  const started = Date.now();
  const result = spawnSync(process.execPath, step.args, { cwd, stdio: "inherit" });
  if (result.error) {
    console.error(`[wallet] ${step.label} failed to start: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[wallet] ${step.label} exited with code ${result.status}`);
    process.exit(result.status ?? 1);
  }
  console.log(`[wallet] ${step.label} ok (${((Date.now() - started) / 1000).toFixed(1)}s)`);
}

console.log("[wallet] dist/ ready — load it unpacked, or run `cap sync android`.");
