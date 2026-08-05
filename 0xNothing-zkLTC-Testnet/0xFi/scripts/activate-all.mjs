import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const broadcast = process.argv.includes("--broadcast");
if (process.argv.some((argument) => argument.startsWith("--") && argument !== "--broadcast")) {
  throw new Error("Usage: npm run activate:check or npm run activate:testnet");
}
const steps = [
  ["activate.mjs", ...(broadcast ? ["--broadcast"] : [])],
  ["activate-graduation-automation.mjs", ...(broadcast ? ["--broadcast"] : [])],
];

for (const [script, ...args] of steps) {
  const result = spawnSync(process.execPath, [path.join(root, "scripts", script), ...args], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
