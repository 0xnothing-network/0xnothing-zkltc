import process from "node:process";

import { formatEther, getAddress } from "viem";
import {
  controllerAbi,
  governanceAddress,
  loadRuntime,
  pumpAbi,
  pumpRouterAbi,
  requiredAddress,
  sendContract,
} from "./lib/graduation-runtime.mjs";

const once = process.argv.includes("--once");
const dryRun = process.argv.includes("--dry-run");
if (once && dryRun) throw new Error("Choose --once or --dry-run, not both");
if (process.argv.some((argument) => argument.startsWith("--") && !["--once", "--dry-run"].includes(argument))) {
  throw new Error("Usage: npm run pump:keeper:check, npm run pump:keeper:once, or npm run pump:keeper");
}

const runtime = loadRuntime({ wallet: !dryRun, walletRole: "keeper" });
const { deployment, publicClient } = runtime;
const chainId = await publicClient.getChainId();
if (chainId !== Number(deployment.chainId)) {
  throw new Error(`Wrong chain: expected ${deployment.chainId}, received ${chainId}`);
}
const pump = requiredAddress(deployment.pump, "Pump");
const router = requiredAddress(deployment.pumpGraduationRouter, "Pump router");
const adapter = requiredAddress(deployment.pumpGraduationAdapter, "graduation adapter");
const controller = deployment.pumpGraduationController
  ? requiredAddress(deployment.pumpGraduationController, "graduation controller")
  : undefined;
const governance = governanceAddress(deployment);
const maxPerScan = Number.parseInt(process.env.GRADUATION_KEEPER_MAX_PER_SCAN || "3", 10);
if (!Number.isSafeInteger(maxPerScan) || maxPerScan < 1 || maxPerScan > 20) {
  throw new Error("GRADUATION_KEEPER_MAX_PER_SCAN must be between 1 and 20");
}

async function scan() {
  const [pumpAdmin, routerAdmin, routerEnabled, adapterAllowed, rawTokens] = await Promise.all([
    publicClient.readContract({ address: pump, abi: pumpAbi, functionName: "admin" }),
    publicClient.readContract({ address: router, abi: pumpRouterAbi, functionName: "admin" }),
    publicClient.readContract({ address: router, abi: pumpRouterAbi, functionName: "enabled" }),
    publicClient.readContract({ address: router, abi: pumpRouterAbi, functionName: "isAdapterAllowed", args: [adapter] }),
    publicClient.readContract({ address: pump, abi: pumpAbi, functionName: "getAllTokens" }),
  ]);
  const tokens = [...new Set(rawTokens.map((token) => getAddress(token)))];
  let controllerPaused = true;
  let controllerBindingsOk = false;
  if (controller) {
    const controllerCode = await publicClient.getCode({ address: controller });
    if (controllerCode && controllerCode !== "0x") {
      const [boundPump, boundAdapter, boundRouter, boundGovernance, paused] = await Promise.all([
        publicClient.readContract({ address: controller, abi: controllerAbi, functionName: "pump" }),
        publicClient.readContract({ address: controller, abi: controllerAbi, functionName: "adapter" }),
        publicClient.readContract({ address: controller, abi: controllerAbi, functionName: "router" }),
        publicClient.readContract({ address: controller, abi: controllerAbi, functionName: "governance" }),
        publicClient.readContract({ address: controller, abi: controllerAbi, functionName: "graduationsPaused" }),
      ]);
      controllerPaused = paused;
      controllerBindingsOk = boundPump.toLowerCase() === pump.toLowerCase()
        && boundAdapter.toLowerCase() === adapter.toLowerCase()
        && boundRouter.toLowerCase() === router.toLowerCase()
        && boundGovernance.toLowerCase() === governance.toLowerCase();
    }
  }
  const ready = [];
  const statusReadFailures = [];
  for (let index = 0; index < tokens.length; index += 20) {
    const page = tokens.slice(index, index + 20);
    const statuses = await Promise.all(page.map(async (token) => {
      try {
        return await publicClient.readContract({ address: pump, abi: pumpAbi, functionName: "status", args: [token] });
      } catch (error) {
        statusReadFailures.push({ token, reason: error instanceof Error ? error.shortMessage || error.message : String(error) });
        return undefined;
      }
    }));
    ready.push(...page.filter((_, statusIndex) => statuses[statusIndex] === 2));
  }
  const operational = Boolean(controller)
    && controllerBindingsOk
    && pumpAdmin.toLowerCase() === controller.toLowerCase()
    && routerAdmin.toLowerCase() === controller.toLowerCase()
    && routerEnabled
    && adapterAllowed
    && !controllerPaused;
  const state = {
    operational,
    controller: controller || null,
    controllerBindingsOk,
    pumpAdmin,
    routerAdmin,
    routerEnabled,
    adapterAllowed,
    controllerPaused,
    totalMarkets: tokens.length,
    statusReadFailures,
    ready,
  };
  console.log(JSON.stringify({ type: "scan", ...state }, null, 2));
  if (!operational || dryRun || !controller) return state;

  for (const token of ready.slice(0, maxPerScan)) {
    try {
      const preview = await publicClient.readContract({ address: controller, abi: controllerAbi, functionName: "previewGraduation", args: [token] });
      if (!preview.ready || preview.expectedLp === 0n || preview.minimumLp > preview.expectedLp) {
        throw new Error("Graduation preview is not executable");
      }
      const { hash } = await sendContract(runtime, controller, controllerAbi, "graduateReady", [token]);
      console.log(JSON.stringify({ type: "graduated", token: getAddress(token), pool: preview.pool, nusdLiquidity: formatEther(preview.nusdAmount), expectedLp: preview.expectedLp.toString(), transactionHash: hash }, null, 2));
    } catch (error) {
      console.error(JSON.stringify({ type: "skipped", token: getAddress(token), reason: error instanceof Error ? error.shortMessage || error.message : String(error) }));
    }
  }
  return state;
}

if (once || dryRun) {
  const state = await scan();
  if (!state.operational || state.statusReadFailures.length) process.exitCode = 1;
} else {
  const intervalSeconds = Number.parseInt(process.env.GRADUATION_KEEPER_INTERVAL_SECONDS || "20", 10);
  if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 10 || intervalSeconds > 3600) {
    throw new Error("GRADUATION_KEEPER_INTERVAL_SECONDS must be between 10 and 3600");
  }
  let consecutiveFailures = 0;
  while (true) {
    try {
      await scan();
      consecutiveFailures = 0;
    } catch (error) {
      console.error(error);
      consecutiveFailures += 1;
    }
    const backoffMultiplier = Math.min(2 ** consecutiveFailures, 15);
    await new Promise((resolve) => setTimeout(resolve, intervalSeconds * backoffMultiplier * 1000));
  }
}
