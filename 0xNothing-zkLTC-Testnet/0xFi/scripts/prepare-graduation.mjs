import process from "node:process";

import { getAddress, isAddress, parseAbi, zeroAddress } from "viem";

import {
  loadRuntime,
  requiredAddress,
  sendContract,
} from "./lib/graduation-runtime.mjs";

const broadcast = process.argv.includes("--broadcast");
const unknownFlags = process.argv.slice(2).filter((argument) => argument.startsWith("--") && argument !== "--broadcast");
const positional = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
if (unknownFlags.length || positional.length !== 1 || !isAddress(positional[0])) {
  throw new Error("Usage: npm run pump:prepare -- <pump-token-address> or npm run pump:prepare:broadcast -- <pump-token-address>");
}
const token = getAddress(positional[0]);
const runtime = loadRuntime({ wallet: broadcast });
const { deployment, network, publicClient } = runtime;
const account = broadcast
  ? runtime.account
  : requiredAddress(deployment.deployer, "recorded deployer");
const chainId = await publicClient.getChainId();
if (chainId !== Number(network.chainId) || chainId !== Number(deployment.chainId)) {
  throw new Error(`Wrong chain: expected ${network.chainId}, received ${chainId}`);
}

const factory = requiredAddress(deployment.dexFactory, "DEX factory");
const nusd = requiredAddress(deployment.nusd, "NUSD");
const adapter = requiredAddress(deployment.pumpGraduationAdapter, "graduation adapter");
const factoryAbi = parseAbi([
  "function isPumpToken(address token) view returns (bool)",
  "function getPair(address tokenA,address tokenB) view returns (address)",
]);
const adapterAbi = parseAbi(["function preparePool(address token) returns (address pair)"]);
const pairAbi = parseAbi([
  "function bootstrapper() view returns (address)",
  "function totalSupply() view returns (uint256)",
]);

const [factoryCode, adapterCode, isPumpToken] = await Promise.all([
  publicClient.getCode({ address: factory }),
  publicClient.getCode({ address: adapter }),
  publicClient.readContract({ address: factory, abi: factoryAbi, functionName: "isPumpToken", args: [token] }),
]);
if (!factoryCode || factoryCode === "0x") throw new Error("DEX factory has no bytecode");
if (!adapterCode || adapterCode === "0x") throw new Error("Graduation adapter has no bytecode");
if (!isPumpToken) throw new Error("Token is not an active 0xPump token");

let pair = await publicClient.readContract({
  address: factory,
  abi: factoryAbi,
  functionName: "getPair",
  args: [token, nusd],
});
let hash;
if (pair === zeroAddress) {
  const simulation = await publicClient.simulateContract({
    address: adapter,
    abi: adapterAbi,
    functionName: "preparePool",
    args: [token],
    account,
  });
  pair = requiredAddress(simulation.result, "simulated graduation pair");
  if (!broadcast) {
    console.log(JSON.stringify({
      mode: "simulation",
      chainId,
      token,
      pair,
      transactionRequired: true,
      prepared: false,
    }, null, 2));
    process.exit(0);
  }
  ({ hash } = await sendContract(runtime, adapter, adapterAbi, "preparePool", [token]));
  const livePair = await publicClient.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: "getPair",
    args: [token, nusd],
  });
  if (livePair.toLowerCase() !== pair.toLowerCase()) {
    throw new Error(`Prepared pair mismatch: simulated ${pair}, received ${livePair}`);
  }
  pair = livePair;
}

const pairCode = await publicClient.getCode({ address: pair });
if (!pairCode || pairCode === "0x") throw new Error("Graduation pair has no bytecode");
const [bootstrapper, totalSupply] = await Promise.all([
  publicClient.readContract({ address: pair, abi: pairAbi, functionName: "bootstrapper" }),
  publicClient.readContract({ address: pair, abi: pairAbi, functionName: "totalSupply" }),
]);
if (bootstrapper.toLowerCase() !== adapter.toLowerCase() || totalSupply !== 0n) {
  throw new Error("Existing pair is not an empty protected graduation pool");
}
console.log(JSON.stringify({
  mode: broadcast ? "broadcast" : "check",
  chainId,
  token,
  pair,
  prepared: true,
  transactionHash: hash || null,
}, null, 2));
