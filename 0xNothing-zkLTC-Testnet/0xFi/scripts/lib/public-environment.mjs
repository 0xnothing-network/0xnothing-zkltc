import fs from "node:fs";
import path from "node:path";

import { atomicWriteFile, requiredAddress } from "./graduation-runtime.mjs";
import { lendingImplementationState } from "./lending-implementation.mjs";

function cleanValue(value, label) {
  const result = String(value ?? "").trim();
  if (!result || /[\r\n]/.test(result)) throw new Error(`${label} is missing or invalid`);
  return result;
}

function publicAddress(value, label) {
  return requiredAddress(value, label);
}

function publicUrl(value, label) {
  const result = cleanValue(value, label);
  let parsed;
  try {
    parsed = new URL(result);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must use http or https`);
  }
  return result;
}

export function mergeEnvironment(source, values, removeKeys = []) {
  const replacements = new Map(Object.entries(values));
  const managed = new Set([...replacements.keys(), ...removeKeys]);
  const written = new Set();
  const output = [];

  for (const line of source ? source.split(/\r?\n/) : []) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (!match || !managed.has(match[1])) {
      output.push(line);
      continue;
    }
    const key = match[1];
    if (written.has(key)) continue;
    written.add(key);
    const value = replacements.get(key);
    if (value !== undefined && value !== null && value !== "") output.push(`${key}=${value}`);
  }

  for (const [key, value] of replacements) {
    if (!written.has(key) && value !== undefined && value !== null && value !== "") {
      output.push(`${key}=${value}`);
    }
  }
  while (output.length && output.at(-1) === "") output.pop();
  return `${output.join("\n")}\n`;
}

export function publicEnvironmentValues({ deployment, network, rpcUrl, appUrl, goldskyEndpoint }) {
  const deploymentBlock = cleanValue(deployment.deploymentBlock, "deployment block");
  if (!/^\d+$/.test(deploymentBlock)) throw new Error("deployment block must be an unsigned integer");
  const lendingImplementation = lendingImplementationState(deployment);
  const controller = deployment.pumpGraduationController
    ? publicAddress(deployment.pumpGraduationController, "Pump graduation controller")
    : null;
  return {
    NEXT_PUBLIC_APP_URL: publicUrl(appUrl || "http://127.0.0.1:3300/0xFi", "app URL"),
    NEXT_PUBLIC_LITVM_RPC_URL: publicUrl(rpcUrl || network.rpcUrl, "LitVM RPC URL"),
    NEXT_PUBLIC_LITVM_EXPLORER_URL: publicUrl(network.explorerUrl, "LitVM explorer URL"),
    NEXT_PUBLIC_GOLDSKY_ENDPOINT: goldskyEndpoint || network.goldsky?.endpoint
      ? publicUrl(goldskyEndpoint || network.goldsky.endpoint, "Goldsky endpoint")
      : undefined,
    NEXT_PUBLIC_DEPLOYMENT_BLOCK: deploymentBlock,
    NEXT_PUBLIC_NUSD_ADDRESS: publicAddress(deployment.nusd, "NUSD"),
    NEXT_PUBLIC_DIA_LTC_FEED_ADDRESS: publicAddress(network.dia?.feeds?.wzkLTC, "DIA LTC feed"),
    NEXT_PUBLIC_DIA_BTC_FEED_ADDRESS: publicAddress(network.dia?.feeds?.nBTC, "DIA BTC feed"),
    NEXT_PUBLIC_DIA_ETH_FEED_ADDRESS: publicAddress(network.dia?.feeds?.nETH, "DIA ETH feed"),
    NEXT_PUBLIC_WZKLTC_ADDRESS: publicAddress(deployment.wzkLTC, "WzkLTC"),
    NEXT_PUBLIC_NBTC_ADDRESS: publicAddress(deployment.nBTC, "nBTC"),
    NEXT_PUBLIC_NETH_ADDRESS: publicAddress(deployment.nETH, "nETH"),
    NEXT_PUBLIC_DEX_FACTORY_ADDRESS: publicAddress(deployment.dexFactory, "DEX factory"),
    NEXT_PUBLIC_DEX_ROUTER_ADDRESS: publicAddress(deployment.dexRouter, "DEX router"),
    NEXT_PUBLIC_GAUGE_FACTORY_ADDRESS: publicAddress(deployment.gaugeFactory, "gauge factory"),
    NEXT_PUBLIC_SYNTH_FEE_GAUGE_FACTORY_ADDRESS: deployment.synthFeeGaugeFactory
      ? publicAddress(deployment.synthFeeGaugeFactory, "synth fee gauge factory")
      : undefined,
    NEXT_PUBLIC_SYNTH_SAFETY_RESERVE_ADDRESS: deployment.synthSafetyReserve
      ? publicAddress(deployment.synthSafetyReserve, "synth safety reserve")
      : undefined,
    NEXT_PUBLIC_LENDING_POOL_ADDRESS: publicAddress(deployment.lendingPool, "lending pool"),
    NEXT_PUBLIC_LENDING_RISK_ACTIONS_ENABLED: String(!lendingImplementation.migrationRequired),
    NEXT_PUBLIC_NBTC_VAULT_ADDRESS: publicAddress(deployment.nBTCVault, "nBTC vault"),
    NEXT_PUBLIC_NETH_VAULT_ADDRESS: publicAddress(deployment.nETHVault, "nETH vault"),
    NEXT_PUBLIC_LTC_ORACLE_ADDRESS: publicAddress(deployment.ltcOracle, "LTC oracle"),
    NEXT_PUBLIC_BTC_ORACLE_ADDRESS: publicAddress(deployment.btcOracle, "BTC oracle"),
    NEXT_PUBLIC_ETH_ORACLE_ADDRESS: publicAddress(deployment.ethOracle, "ETH oracle"),
    NEXT_PUBLIC_PUMP_GRADUATION_ADAPTER_ADDRESS: publicAddress(
      deployment.pumpGraduationAdapter,
      "Pump graduation adapter",
    ),
    NEXT_PUBLIC_PUMP_GRADUATION_CONTROLLER_ADDRESS: controller,
    NEXT_PUBLIC_PUMP_ADDRESS: publicAddress(deployment.pump, "Pump"),
    NEXT_PUBLIC_WZKLTC_NUSD_PAIR_ADDRESS: publicAddress(deployment.wzkLtcNusdPair, "WzkLTC/NUSD pair"),
    NEXT_PUBLIC_NBTC_NUSD_PAIR_ADDRESS: publicAddress(deployment.nBTCNusdPair, "nBTC/NUSD pair"),
    NEXT_PUBLIC_NETH_NUSD_PAIR_ADDRESS: publicAddress(deployment.nETHNusdPair, "nETH/NUSD pair"),
    NEXT_PUBLIC_WZKLTC_NUSD_GAUGE_ADDRESS: publicAddress(deployment.wzkLtcNusdGauge, "WzkLTC/NUSD gauge"),
    NEXT_PUBLIC_NBTC_NUSD_GAUGE_ADDRESS: publicAddress(deployment.nBTCNusdGauge, "nBTC/NUSD gauge"),
    NEXT_PUBLIC_NETH_NUSD_GAUGE_ADDRESS: publicAddress(deployment.nETHNusdGauge, "nETH/NUSD gauge"),
  };
}

export function writePublicEnvironment({ root, deployment, network, rpcUrl, appUrl, goldskyEndpoint }) {
  const values = publicEnvironmentValues({ deployment, network, rpcUrl, appUrl, goldskyEndpoint });
  const targets = [
    path.join(root, "web", ".env.local"),
    path.join(root, "web", ".env.example"),
  ];
  for (const target of targets) {
    const source = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
    const contents = mergeEnvironment(source, values, [
      "NEXT_PUBLIC_FARM_FACTORY_ADDRESS",
      "NEXT_PUBLIC_NUSD_HEALTH_GUARD_ADDRESS",
    ]);
    atomicWriteFile(target, contents);
  }
  return targets[0];
}
