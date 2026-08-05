import fs from "node:fs";
import path from "node:path";

import { getAddress, isAddress } from "viem";

import { atomicWriteFile } from "./graduation-runtime.mjs";

function address(value, label) {
  if (!isAddress(value)) throw new Error(`${label} is not a valid address`);
  return getAddress(value);
}

function sameAddress(actual, expected, label) {
  if (address(actual, label).toLowerCase() !== address(expected, `expected ${label}`).toLowerCase()) {
    throw new Error(`${label} does not match the 0xFi deployment`);
  }
}

function safeBlockNumber(value, label) {
  const block = Number(value);
  if (!Number.isSafeInteger(block) || block < 0) throw new Error(`${label} is not a safe block number`);
  return block;
}

export function projectMainPumpGraduation({
  manifest,
  chainId,
  pump,
  router,
  adapter,
  controller,
  governance,
  guardian,
  controllerDeploymentBlock,
  controllerDeploymentHash,
  verificationBlock,
  activatedAt,
}) {
  if (!manifest?.pump?.graduation) throw new Error("Main Pump deployment manifest is incomplete");
  if (Number(manifest.chainId) !== Number(chainId)) throw new Error("Main Pump deployment chain mismatch");
  sameAddress(manifest.pump.launchpad, pump, "main Pump address");
  sameAddress(manifest.pump.graduationRouter, router, "main Pump router");
  sameAddress(manifest.pump.graduation.adapter, adapter, "main Pump graduation adapter");
  if (typeof activatedAt !== "string" || !activatedAt.trim()) throw new Error("activation timestamp is missing");
  if (!/^0x[0-9a-fA-F]{64}$/.test(controllerDeploymentHash || "")) {
    throw new Error("controller deployment hash is invalid");
  }

  return {
    ...manifest,
    pump: {
      ...manifest.pump,
      liveVerified: true,
      graduation: {
        ...manifest.pump.graduation,
        controller: address(controller, "graduation controller"),
        controllerGovernance: address(governance, "controller governance"),
        controllerGuardian: address(guardian, "controller guardian"),
        controllerDeploymentBlock: safeBlockNumber(controllerDeploymentBlock, "controller deployment block"),
        controllerDeploymentHash,
        controllerOwnsPumpAdmin: true,
        controllerOwnsRouterAdmin: true,
        operational: true,
        activatedAt,
        lastVerifiedBlock: safeBlockNumber(verificationBlock, "verification block"),
      },
    },
  };
}

export function prepareMainPumpManifestUpdate({ root, ...projection }) {
  const target = path.resolve(root, "..", "deployments", "liteforge-testnet", "deployments.json");
  if (!fs.existsSync(target)) throw new Error(`Main Pump deployment manifest is missing: ${target}`);
  const manifest = JSON.parse(fs.readFileSync(target, "utf8"));
  const nextManifest = projectMainPumpGraduation({ manifest, ...projection });
  return { target, contents: `${JSON.stringify(nextManifest, null, 2)}\n` };
}

export function writeMainPumpManifestUpdate(update) {
  atomicWriteFile(update.target, update.contents);
}
