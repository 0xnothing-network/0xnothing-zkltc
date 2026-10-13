#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const CI_NPM_PACKAGES = Object.freeze([
  "0xNothing-zkLTC-Testnet/apps/web",
  "0xNothing-zkLTC-Testnet/apps/wallet",
  "0xNothing-zkLTC-Testnet/0xFi",
  "0xNothing-zkLTC-Testnet/subgraphs/0xpixel-marketplace",
  "0xNothing-zkLTC-Testnet/subgraphs/0xpump",
  "0xNothing-zkLTC-Mainnet/subgraphs/0xpump",
]);

export function installCiDependencies({
  workspace = workspaceRoot,
  packages = CI_NPM_PACKAGES,
  spawn = spawnSync,
  npm = "npm",
} = {}) {
  for (const prefix of packages) {
    const result = spawn(npm, ["ci", "--prefix", path.join(workspace, prefix), "--no-audit", "--no-fund"], {
      stdio: "inherit",
      windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`npm ci failed in ${prefix} (exit ${result.status ?? 1})`);
    }
  }
  return packages.length;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const installed = installCiDependencies();
  console.log(`Installed ${installed} npm packages for CI.`);
}
