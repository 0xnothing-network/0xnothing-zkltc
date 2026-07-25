import { loadConfig, ZERO_ADDRESS } from "./config.mjs";

const config = loadConfig();
const problems = [];

if (config.contractAddress.toLowerCase() === ZERO_ADDRESS) {
  problems.push("PUMP_CONTRACT_ADDRESS is still the zero-address placeholder");
}
if (config.startBlock === 0) {
  problems.push("PUMP_START_BLOCK is still the pre-deployment placeholder");
}
if (!config.goldskySupported) {
  problems.push(`Goldsky support for network '${config.network}' is not confirmed`);
}
if (!Array.isArray(config.approvedNetworks) || !config.approvedNetworks.includes(config.network)) {
  problems.push(`GOLDSKY_NETWORK '${config.network}' is not in the reviewed network allowlist`);
}
if (/pending|replace|unknown/iu.test(config.network)) {
  problems.push(`GOLDSKY_NETWORK '${config.network}' is a placeholder`);
}

const hasDeploymentCoordinates =
  config.contractAddress.toLowerCase() !== ZERO_ADDRESS && config.startBlock > 0;
if (config.goldskySupported && hasDeploymentCoordinates) {
  if (!config.rpcUrl || !Number.isSafeInteger(config.chainId)) {
    problems.push("RPC URL and chain ID must be reviewed before deployment");
  } else {
    try {
      const [chainIdHex, latestBlockHex, code, createFeeHex, tradeFeeHex] = await Promise.all([
        rpc(config.rpcUrl, "eth_chainId"),
        rpc(config.rpcUrl, "eth_blockNumber"),
        rpc(config.rpcUrl, "eth_getCode", [config.contractAddress, "latest"]),
        rpc(config.rpcUrl, "eth_call", [{ to: config.contractAddress, data: "0xb2db919b" }, "latest"]),
        rpc(config.rpcUrl, "eth_call", [{ to: config.contractAddress, data: "0x5faad8c5" }, "latest"]),
      ]);
      if (Number(BigInt(chainIdHex)) !== config.chainId) {
        problems.push(`RPC chain ID does not match reviewed chain ID ${config.chainId}`);
      }
      if (config.startBlock > Number(BigInt(latestBlockHex))) {
        problems.push("PUMP_START_BLOCK is ahead of the current chain head");
      }
      if (code === "0x") problems.push("PUMP_CONTRACT_ADDRESS has no deployed bytecode");
      if (BigInt(createFeeHex) !== 1_000_000_000_000_000_000n) {
        problems.push("Configured contract does not expose the fixed 1 NUSD creation fee");
      }
      if (BigInt(tradeFeeHex) !== 10n) {
        problems.push("Configured contract does not expose the fixed 10 bps trade fee");
      }
    } catch (error) {
      problems.push(`RPC contract preflight failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

if (problems.length > 0) {
  console.error("0xPump subgraph is not ready to deploy:");
  for (const problem of problems) console.error(`- ${problem}`);
  process.exitCode = 1;
} else {
  console.log(
    `Deploy-ready: ${config.deploymentName}/${config.deploymentVersion} (${config.deploymentTag})`,
  );
}

async function rpc(url, method, params = []) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${method} returned HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error || typeof payload.result !== "string") {
    throw new Error(payload.error?.message || `${method} returned no result`);
  }
  return payload.result;
}
