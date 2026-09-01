import { loadConfig, ZERO_ADDRESS } from "./config.mjs";
import {
  decodeEvmAddressWord,
  requestJsonRpc as rpc,
} from "../../../../scripts/lib/evm-rpc.mjs";

const config = loadConfig();
const problems = [];
const graduationPolicy = config.graduationPolicy;
const graduationMode = graduationPolicy?.mode;
let expectedController = null;
let expectedAdapter = null;

if (graduationMode === "controller-active") {
  expectedController = configuredAddress(
    graduationPolicy.controllerAddress,
    "graduation controller",
  );
  expectedAdapter = configuredAddress(
    graduationPolicy.adapterAddress,
    "graduation adapter",
  );
} else if (graduationMode !== "disabled") {
  problems.push("graduationPolicy.mode must be 'disabled' or 'controller-active'");
}

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
      const [
        chainIdHex,
        latestBlockHex,
        code,
        createFeeHex,
        tradeFeeHex,
        initialVirtualNusdHex,
        graduationMarketCapHex,
        graduationReserveHex,
        routerHex,
      ] = await Promise.all([
        rpc(config.rpcUrl, "eth_chainId"),
        rpc(config.rpcUrl, "eth_blockNumber"),
        rpc(config.rpcUrl, "eth_getCode", [config.contractAddress, "latest"]),
        rpc(config.rpcUrl, "eth_call", [{ to: config.contractAddress, data: "0xb2db919b" }, "latest"]),
        rpc(config.rpcUrl, "eth_call", [{ to: config.contractAddress, data: "0x5faad8c5" }, "latest"]),
        rpc(config.rpcUrl, "eth_call", [{ to: config.contractAddress, data: "0x1251e519" }, "latest"]),
        rpc(config.rpcUrl, "eth_call", [{ to: config.contractAddress, data: "0x412e7fcc" }, "latest"]),
        rpc(config.rpcUrl, "eth_call", [{ to: config.contractAddress, data: "0x0dd56350" }, "latest"]),
        rpc(config.rpcUrl, "eth_call", [{ to: config.contractAddress, data: "0xef205dea" }, "latest"]),
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
      if (BigInt(initialVirtualNusdHex) !== 1_500_000_000_000_000_000_000n) {
        problems.push("Configured contract does not start at the fixed 1,500 NUSD virtual market cap");
      }
      if (BigInt(graduationMarketCapHex) !== 6_000_000_000_000_000_000_000n) {
        problems.push("Configured contract does not target the fixed 6,000 NUSD graduation market cap");
      }
      if (BigInt(graduationReserveHex) !== 1_500_000_000_000_000_000_000n) {
        problems.push("Configured contract does not expose the derived 1,500 NUSD reserve target");
      }

      const routerAddress = decodeEvmAddressWord(routerHex, "graduation router");
      if (routerAddress === ZERO_ADDRESS) {
        problems.push("Configured contract does not expose a valid graduation router");
      } else {
        const [routerCode, routerEnabledHex, routerEnableAtHex] = await Promise.all([
          rpc(config.rpcUrl, "eth_getCode", [routerAddress, "latest"]),
          rpc(config.rpcUrl, "eth_call", [{ to: routerAddress, data: "0x238dafe0" }, "latest"]),
          rpc(config.rpcUrl, "eth_call", [{ to: routerAddress, data: "0x6474111e" }, "latest"]),
        ]);
        if (routerCode === "0x") {
          problems.push("Configured graduation router has no deployed bytecode");
        }
        if (graduationMode === "disabled") {
          if (BigInt(routerEnabledHex) !== 0n || BigInt(routerEnableAtHex) !== 0n) {
            problems.push("Graduation router must remain disabled and unscheduled");
          }
        } else if (expectedController && expectedAdapter) {
          const [
            pumpAdminHex,
            pumpPendingAdminHex,
            routerAdminHex,
            routerPendingAdminHex,
            adapterAllowedHex,
            adapterActivationHex,
            controllerCode,
            adapterCode,
            controllerPumpHex,
            controllerRouterHex,
            controllerAdapterHex,
            graduationsPausedHex,
          ] = await Promise.all([
            rpc(config.rpcUrl, "eth_call", [{ to: config.contractAddress, data: "0xf851a440" }, "latest"]),
            rpc(config.rpcUrl, "eth_call", [{ to: config.contractAddress, data: "0x26782247" }, "latest"]),
            rpc(config.rpcUrl, "eth_call", [{ to: routerAddress, data: "0xf851a440" }, "latest"]),
            rpc(config.rpcUrl, "eth_call", [{ to: routerAddress, data: "0x26782247" }, "latest"]),
            rpc(config.rpcUrl, "eth_call", [{
              to: routerAddress,
              data: callWithAddress("0xe219bbf6", expectedAdapter),
            }, "latest"]),
            rpc(config.rpcUrl, "eth_call", [{
              to: routerAddress,
              data: callWithAddress("0xedb90871", expectedAdapter),
            }, "latest"]),
            rpc(config.rpcUrl, "eth_getCode", [expectedController, "latest"]),
            rpc(config.rpcUrl, "eth_getCode", [expectedAdapter, "latest"]),
            rpc(config.rpcUrl, "eth_call", [{ to: expectedController, data: "0x395ea61b" }, "latest"]),
            rpc(config.rpcUrl, "eth_call", [{ to: expectedController, data: "0xf887ea40" }, "latest"]),
            rpc(config.rpcUrl, "eth_call", [{ to: expectedController, data: "0x03eadcfc" }, "latest"]),
            rpc(config.rpcUrl, "eth_call", [{ to: expectedController, data: "0xe845e50b" }, "latest"]),
          ]);

          if (BigInt(routerEnabledHex) !== 1n || BigInt(routerEnableAtHex) !== 0n) {
            problems.push("Graduation router is not active and unscheduled as recorded");
          }
          if (
            decodeEvmAddressWord(pumpAdminHex, "Pump admin") !== expectedController
            || decodeEvmAddressWord(routerAdminHex, "router admin") !== expectedController
          ) {
            problems.push("Graduation controller does not own both Pump and router administration");
          }
          if (
            decodeEvmAddressWord(pumpPendingAdminHex, "Pump pending admin") !== ZERO_ADDRESS
            || decodeEvmAddressWord(routerPendingAdminHex, "router pending admin") !== ZERO_ADDRESS
          ) {
            problems.push("Pump or graduation router has an unexpected pending admin handover");
          }
          if (controllerCode === "0x" || adapterCode === "0x") {
            problems.push("Configured graduation controller or adapter has no deployed bytecode");
          }
          if (BigInt(adapterAllowedHex) !== 1n || BigInt(adapterActivationHex) !== 0n) {
            problems.push("Pinned graduation adapter is not active and unscheduled");
          }
          if (
            decodeEvmAddressWord(controllerPumpHex, "controller Pump") !== config.contractAddress.toLowerCase()
            || decodeEvmAddressWord(controllerRouterHex, "controller router") !== routerAddress
            || decodeEvmAddressWord(controllerAdapterHex, "controller adapter") !== expectedAdapter
          ) {
            problems.push("Graduation controller bindings do not match the reviewed topology");
          }
          if (BigInt(graduationsPausedHex) !== 0n) {
            problems.push("Graduation controller is paused");
          }
        }
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

function configuredAddress(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-f]{40}$/iu.test(value)) {
    problems.push(`Configured ${label} must be a 20-byte EVM address`);
    return null;
  }
  const address = value.toLowerCase();
  if (address === ZERO_ADDRESS) {
    problems.push(`Configured ${label} must not be the zero address`);
    return null;
  }
  return address;
}

function callWithAddress(selector, address) {
  return `${selector}${address.slice(2).padStart(64, "0")}`;
}
