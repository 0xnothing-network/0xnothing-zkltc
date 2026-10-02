import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

// Resolve the repository's installed viem; no global package or secret CLI argument.
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const require = createRequire(path.join(root, "apps/web/package.json"));
const { createPublicClient, createWalletClient, http, defineChain, keccak256,
  formatEther, encodeDeployData, decodeEventLog } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");
const RPC = "https://liteforge.rpc.caldera.xyz/infra-partner-http";
const CHAIN_ID = 4441;
const MAX_TRANSACTION_COST = 50_000_000_000_000_000n; // 0.05 testnet zkLTC.
const chain = defineChain({ id: CHAIN_ID, name: "LitVM LiteForge",
  nativeCurrency: { name: "zkLTC", symbol: "zkLTC", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } } });
const directory = path.join(root, "deployments/liteforge-testnet");
const journalPath = path.join(directory, "pixel-v2.json");
const artifactPath = path.join(root, "contracts/out/ZeroXPixelV2.sol/ZeroXPixelV2.json");
const sourcePath = path.join(root, "contracts/src/0xpixel/ZeroXPixelV2.sol");
const broadcast = process.argv.includes("--broadcast");
const smoke = process.argv.includes("--smoke-mint");
let step = "load-artifact";
const json = (value) => JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item, 2) + "\n";
const save = (journal) => {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(journalPath + ".tmp", json(journal));
  fs.renameSync(journalPath + ".tmp", journalPath);
};

function signingAccount() {
  const contents = fs.readFileSync(path.join(root, ".env.local"), "utf8");
  const match = contents.match(/^\s*PRIVATE_KEY\s*=\s*(.*?)\s*$/m);
  if (!match) throw new Error("PRIVATE_KEY missing");
  let key = match[1].replace(/^(['"])(.*)\1$/, "$2");
  if (!key.startsWith("0x")) key = "0x" + key;
  if (!/^0x[\da-fA-F]{64}$/.test(key)) throw new Error("Invalid PRIVATE_KEY format");
  return privateKeyToAccount(key);
}

async function main() {
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const abi = artifact.abi;
  const bytecode = artifact.bytecode.object;
  const runtime = artifact.deployedBytecode.object;
  if (!/^0x[\da-f]+$/i.test(bytecode) || !/^0x[\da-f]+$/i.test(runtime)) throw new Error("Artifact has unresolved links");
  if ((runtime.length - 2) / 2 > 24_576) throw new Error("Runtime exceeds EIP-170");
  step = "load-signer";
  const account = signingAccount();
  const client = createPublicClient({ chain, transport: http(RPC, { timeout: 30_000 }) });
  const wallet = createWalletClient({ account, chain, transport: http(RPC, { timeout: 30_000 }) });
  step = "check-chain";
  if (await client.getChainId() !== CHAIN_ID) throw new Error("Wrong network");
  step = "check-journal";
  let journal = fs.existsSync(journalPath) ? JSON.parse(fs.readFileSync(journalPath, "utf8")) : null;
  const sourceSha256 = createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
  const runtimeHash = keccak256(runtime);
  const creationHash = keccak256(bytecode);
  if (journal && (journal.chainId !== CHAIN_ID || journal.deployer.toLowerCase() !== account.address.toLowerCase()
    || journal.creationHash !== creationHash || journal.runtimeHash !== runtimeHash)) {
    throw new Error("Deployment journal differs from current signer/artifact; refusing a duplicate deployment");
  }
  if (!journal?.transactionHash) {
    step = "estimate-deployment";
    const data = encodeDeployData({ abi, bytecode });
    const [gas, gasPrice, balance] = await Promise.all([
      client.estimateGas({ account: account.address, data }), client.getGasPrice(),
      client.getBalance({ address: account.address }),
    ]);
    const gasLimit = gas * 125n / 100n;
    const cappedGasPrice = gasPrice * 2n;
    const maxCost = gasLimit * cappedGasPrice;
    if (maxCost > MAX_TRANSACTION_COST || balance < maxCost) throw new Error("Deployment exceeds funded cost limit");
    console.log(json({ mode: broadcast ? "broadcast" : "preflight", chainId: CHAIN_ID,
      deployer: account.address, runtimeBytes: (runtime.length - 2) / 2,
      estimatedGas: gas, maximumCostZkLTC: formatEther(maxCost), sourceSha256, runtimeHash }));
    if (!broadcast) return;
    // eth_call verifies creation before any signing.
    step = "simulate-deployment";
    await client.call({ account: account.address, data, gas: gasLimit });
    step = "broadcast-deployment";
    const transactionHash = await wallet.deployContract({ abi, bytecode, gas: gasLimit, gasPrice: cappedGasPrice });
    journal = { chainId: CHAIN_ID, deployer: account.address, transactionHash,
      sourceSha256, runtimeHash, creationHash, submittedAt: new Date().toISOString(), status: "submitted" };
    save(journal);
    console.log(json({ submitted: transactionHash }));
  }
  step = "confirm-deployment";
  const receipt = await client.waitForTransactionReceipt({ hash: journal.transactionHash, timeout: 120_000 });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error("Deployment receipt failed");
  const address = receipt.contractAddress;
  step = "verify-runtime";
  const liveCode = await client.getBytecode({ address });
  if (!liveCode || keccak256(liveCode) !== runtimeHash) throw new Error("Runtime differs from compiled artifact");
  const read = (functionName, args = []) => client.readContract({ address, abi, functionName, args,
    ...(functionName === "tokenURI" ? { gas: 40_000_000n } : {}) });
  step = "verify-capabilities";
  const [version, maxGrid, maxRuns, metadata, royalty, name] = await Promise.all([
    read("VERSION"), read("MAX_GRID"), read("MAX_RUNS"),
    read("supportsInterface", ["0x5b5e139f"]), read("supportsInterface", ["0x2a55205a"]), read("name"),
  ]);
  if (version !== 2n || maxGrid !== 256n || maxRuns !== 4096n || !metadata || !royalty) throw new Error("V2 capabilities mismatch");
  journal = { ...journal, address, startBlock: receipt.blockNumber, gasUsed: receipt.gasUsed,
    effectiveGasPrice: receipt.effectiveGasPrice, deploymentCostZkLTC: formatEther(receipt.gasUsed * receipt.effectiveGasPrice),
    verifiedRuntime: true, capabilities: { version, maxGrid, maxRuns, metadata, royalty, name }, status: "deployed" };
  save(journal);
  console.log(json({ address, transactionHash: journal.transactionHash, startBlock: journal.startBlock,
    gasUsed: journal.gasUsed, deploymentCostZkLTC: journal.deploymentCostZkLTC, verifiedRuntime: true }));

  // An explicit opt-in smoke mint creates one 256-grid NFT owned by the deployer.
  if (smoke) {
    if (!broadcast) throw new Error("Smoke mint requires --broadcast");
    // Exercise the entire 4,096-run budget and both immutable data chunks on live RPC.
    const pixels = "0x" + Array.from({ length: 4096 }, (_, i) => {
      const x = (i % 16) * 16;
      const y = Math.floor(i / 16);
      return [x, y, 15, x, y, 128].map((b) => b.toString(16).padStart(2, "0")).join("");
    }).join("");
    const args = ["0xPixel V2 · 256", "Bản kiểm chứng 256×256 với 4.096 đoạn màu: hình ảnh và mô tả lưu hoàn toàn on-chain.", 256n, pixels];
    if (!journal.smoke?.transactionHash) {
      step = "simulate-smoke-mint";
      const [simulation, gas, gasPrice, balance] = await Promise.all([
        client.simulateContract({ address, abi, functionName: "mintPacked", args, account }),
        client.estimateContractGas({ address, abi, functionName: "mintPacked", args, account }),
        client.getGasPrice(), client.getBalance({ address: account.address }),
      ]);
      const gasLimit = gas * 125n / 100n;
      const cappedGasPrice = gasPrice * 2n;
      if (gasLimit * cappedGasPrice > MAX_TRANSACTION_COST || balance < gasLimit * cappedGasPrice) throw new Error("Smoke mint exceeds funded cost limit");
      step = "broadcast-smoke-mint";
      const transactionHash = await wallet.writeContract({ ...simulation.request, gas: gasLimit, gasPrice: cappedGasPrice });
      journal.smoke = { transactionHash, status: "submitted" };
      save(journal);
      console.log(json({ smokeSubmitted: transactionHash }));
    }
    step = "confirm-smoke-mint";
    const minted = await client.waitForTransactionReceipt({ hash: journal.smoke.transactionHash, timeout: 120_000 });
    if (minted.status !== "success") throw new Error("Smoke mint failed");
    const mintLog = minted.logs.filter((log) => log.address.toLowerCase() === address.toLowerCase()).map((log) => {
      try { return decodeEventLog({ abi, data: log.data, topics: log.topics }); } catch { return null; }
    }).find((log) => log?.eventName === "Minted");
    if (!mintLog) throw new Error("Missing Minted event");
    const tokenId = mintLog.args.tokenId;
    step = "verify-smoke-metadata";
    const [uri, owner, data, royaltyResult] = await Promise.all([
      read("tokenURI", [tokenId]), read("ownerOf", [tokenId]), read("tokenData", [tokenId]),
      read("royaltyInfo", [tokenId, 10_000n]),
    ]);
    if (owner.toLowerCase() !== account.address.toLowerCase() || data[1] !== 256n
      || royaltyResult[0].toLowerCase() !== account.address.toLowerCase() || royaltyResult[1] !== 100n) throw new Error("Smoke ownership/grid/royalty mismatch");
    const decoded = JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString("utf8"));
    const svg = Buffer.from(decoded.image.split(",")[1], "base64").toString("utf8");
    if (decoded.name !== args[0] || decoded.description !== args[1] || !svg.includes("256")) throw new Error("Smoke metadata mismatch");
    journal.smoke = { ...journal.smoke, status: "verified", tokenId, owner,
      startBlock: minted.blockNumber, gasUsed: minted.gasUsed, effectiveGasPrice: minted.effectiveGasPrice,
      mintCostZkLTC: formatEther(minted.gasUsed * minted.effectiveGasPrice), metadataBytes: Buffer.byteLength(uri),
      svgBytes: Buffer.byteLength(svg), gridSize: 256, runCount: 4096, description: decoded.description };
    save(journal);
    fs.writeFileSync(path.join(directory, "pixel-v2-smoke-metadata.json"), json(decoded));
    fs.writeFileSync(path.join(directory, "pixel-v2-smoke.svg"), svg);
    console.log(json({ smoke: journal.smoke }));
  }
}

main().catch(() => {
  // RPC/library errors can contain request payloads. Never serialize those while signing.
  console.error(`Pixel V2 failed at ${step}; no credentials are logged. Inspect the public journal and retry after resolving that step.`);
  process.exitCode = 1;
});
