import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createPublicClient, createWalletClient, defineChain, encodeDeployData, formatEther, getAddress, getContractAddress, http, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = path.join(root, "deployments/liteforge-testnet/nusd-marketplace.json");
const pendingOutput = path.join(root, "deployments/liteforge-testnet/nusd-marketplace.pending.json");
const token = getAddress("0x677D63c78E77E0b1971530e1494Caee4Bd7d631e");
const collections = [getAddress("0x33A32b9b2BEe864f9e42BFa39cA7BDC72f655988"), getAddress("0xd83cb7acef921f98b6b983cbb712a583869da9eb")];
const implementation = keccak256(toBytes("0xpixel.nusd.marketplace.v2"));
let phase = "configuration";

function save(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

async function run() {
  const argumentsList = process.argv.slice(2);
  if (argumentsList.some((argument) => !["--broadcast", "--submit-prepared", "--replace-underpriced"].includes(argument))) throw new Error("Invalid arguments");
  const broadcast = argumentsList.includes("--broadcast");
  const environment = dotenv.parse(fs.readFileSync(path.join(root, ".env.local"), "utf8"));
  const suppliedKey = String(environment.PRIVATE_KEY || environment.DEPLOYER_PRIVATE_KEY || "").trim();
  const key = suppliedKey.startsWith("0x") ? suppliedKey : `0x${suppliedKey}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("Missing deployment key");
  const account = privateKeyToAccount(key);
  const rpc = "https://liteforge.rpc.caldera.xyz/infra-partner-http";
  const chain = defineChain({ id: 4441, name: "LiteForge", nativeCurrency: { name: "zkLTC", symbol: "zkLTC", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const publicClient = createPublicClient({ chain, transport: http(rpc, { retryCount: 0, timeout: 30_000 }) });
  const wallet = createWalletClient({ account, chain, transport: http(rpc, { retryCount: 0, timeout: 30_000 }) });
  const artifact = JSON.parse(fs.readFileSync(path.join(root, "contracts/out/NusdNftMarketplace.sol/NusdNftMarketplace.json"), "utf8"));
  const args = [token, account.address, account.address, 40, collections];
  const bytecode = artifact.bytecode.object.startsWith("0x") ? artifact.bytecode.object : `0x${artifact.bytecode.object}`;
  phase = "chain validation";
  if (await publicClient.getChainId() !== 4441) throw new Error("Wrong chain");

  async function verify(address, blockNumber) {
    phase = "onchain verification";
    const code = await publicClient.getBytecode({ address, blockNumber });
    const expected = artifact.deployedBytecode.object.replace(/^0x/, "").toLowerCase().split("");
    const actual = (code || "").replace(/^0x/, "").toLowerCase().split("");
    if (actual.length !== expected.length) throw new Error("Runtime bytecode mismatch");
    for (const entries of Object.values(artifact.deployedBytecode.immutableReferences || {})) {
      for (const entry of entries) for (let index = entry.start * 2; index < (entry.start + entry.length) * 2; index++) { expected[index] = "0"; actual[index] = "0"; }
    }
    if (expected.join("") !== actual.join("")) throw new Error("Runtime bytecode mismatch");
    const contract = { address, abi: artifact.abi, blockNumber };
    const [nusd, owner, treasury, feeBps, marker, paused, allowedFirst, allowedSecond] = await Promise.all([
      publicClient.readContract({ ...contract, functionName: "nusd" }),
      publicClient.readContract({ ...contract, functionName: "owner" }),
      publicClient.readContract({ ...contract, functionName: "feeRecipient" }),
      publicClient.readContract({ ...contract, functionName: "platformFeeBps" }),
      publicClient.readContract({ ...contract, functionName: "IMPLEMENTATION_ID" }),
      publicClient.readContract({ ...contract, functionName: "paused" }),
      publicClient.readContract({ ...contract, functionName: "collectionAllowed", args: [collections[0]] }),
      publicClient.readContract({ ...contract, functionName: "collectionAllowed", args: [collections[1]] }),
    ]);
    if (getAddress(nusd) !== token || getAddress(owner) !== account.address || getAddress(treasury) !== account.address || Number(feeBps) !== 40 || marker !== implementation || paused || !allowedFirst || !allowedSecond) throw new Error("Unexpected deployment state");
  }

  if (fs.existsSync(output)) {
    const recorded = JSON.parse(fs.readFileSync(output, "utf8"));
    const receipt = await publicClient.getTransactionReceipt({ hash: recorded.deploymentHash });
    if (recorded.chainId !== 4441 || receipt.status !== "success" || receipt.contractAddress?.toLowerCase() !== recorded.address.toLowerCase()) throw new Error("Invalid recorded deployment");
    await verify(getAddress(recorded.address), receipt.blockNumber);
    console.log(JSON.stringify({ status: "existing-verified", ...recorded }));
    return;
  }

  let hash;
  if (fs.existsSync(pendingOutput)) {
    let pending = JSON.parse(fs.readFileSync(pendingOutput, "utf8"));
    if (pending.chainId !== 4441 || getAddress(pending.deployer) !== account.address || !/^0x[0-9a-fA-F]{64}$/.test(pending.hash)) throw new Error("Invalid pending deployment");
    hash = pending.hash;
    if (pending.status === "prepared" && (argumentsList.includes("--submit-prepared") || argumentsList.includes("--replace-underpriced"))) {
      phase = "prepared transaction lookup";
      const existing = await publicClient.getTransaction({ hash }).catch((error) => {
        if (error?.name === "TransactionNotFoundError") return undefined;
        throw error;
      });
      if (!existing) {
        phase = "prepared nonce check";
        if (await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" }) !== pending.nonce) throw new Error("Deployer has pending transactions");
        const data = encodeDeployData({ abi: artifact.abi, bytecode, args });
        phase = "prepared transaction signing";
        let serializedTransaction = await wallet.signTransaction({ data, gas: BigInt(pending.gas), gasPrice: BigInt(pending.gasPrice), nonce: pending.nonce, type: "legacy" });
        if (keccak256(serializedTransaction) !== hash) throw new Error("Prepared transaction hash mismatch");
        if (argumentsList.includes("--replace-underpriced")) {
          const gasPrice = await publicClient.getGasPrice() * 2n;
          if (await publicClient.getBalance({ address: account.address }) < BigInt(pending.gas) * gasPrice) throw new Error("Insufficient deployment gas balance");
          serializedTransaction = await wallet.signTransaction({ data, gas: BigInt(pending.gas), gasPrice, nonce: pending.nonce, type: "legacy" });
          const previousHash = hash;
          hash = keccak256(serializedTransaction);
          pending = { ...pending, hash, gasPrice: gasPrice.toString(), replacedPreparedHashes: [...(pending.replacedPreparedHashes || []), previousHash] };
          save(pendingOutput, pending);
          console.log(JSON.stringify({ status: "underpriced-preparation-replaced", previousHash, hash, nonce: pending.nonce, maximumGasCostZkLtc: formatEther(BigInt(pending.gas) * gasPrice) }));
        }
        phase = "prepared transaction broadcast";
        const submittedHash = await publicClient.sendRawTransaction({ serializedTransaction });
        if (submittedHash !== hash) throw new Error("Unexpected submitted hash");
        save(pendingOutput, { ...pending, status: "submitted", submittedAt: new Date().toISOString() });
        console.log(JSON.stringify({ status: "submitted", hash }));
      }
    }
    console.log(JSON.stringify({ status: "resuming-confirmation", hash }));
  } else {
    phase = "simulation";
    const [latestNonce, pendingNonce, balance, quotedGasPrice] = await Promise.all([
      publicClient.getTransactionCount({ address: account.address, blockTag: "latest" }),
      publicClient.getTransactionCount({ address: account.address, blockTag: "pending" }),
      publicClient.getBalance({ address: account.address }), publicClient.getGasPrice(),
    ]);
    const gasPrice = quotedGasPrice * 2n;
    console.log(JSON.stringify({ status: "wallet-preflight", deployer: account.address, latestNonce, pendingNonce, walletBalanceZkLtc: formatEther(balance), gasPrice: gasPrice.toString() }));
    if (latestNonce !== pendingNonce) throw new Error("Deployer has pending transactions");
    const predicted = getContractAddress({ from: account.address, nonce: BigInt(latestNonce) });
    phase = "predicted address check";
    if (await publicClient.getBytecode({ address: predicted })) throw new Error("Predicted address already has code");
    const data = encodeDeployData({ abi: artifact.abi, bytecode, args });
    phase = "constructor gas estimation";
    const estimatedGas = await publicClient.estimateGas({ account: account.address, data });
    const gas = estimatedGas * 120n / 100n;
    const maximumGasCost = gas * gasPrice;
    phase = "deployment gas balance check";
    if (balance < maximumGasCost) throw new Error("Insufficient deployment gas balance");
    phase = "constructor simulation";
    await publicClient.call({ account: account.address, data, gas, gasPrice });
    console.log(JSON.stringify({ status: "simulation-passed", chainId: 4441, deployer: account.address, owner: account.address, feeRecipient: account.address, nusd: token, platformFeeBps: 40, collections, predictedAddress: predicted, estimatedGas: estimatedGas.toString(), maximumGasCostZkLtc: formatEther(maximumGasCost), walletBalanceZkLtc: formatEther(balance), broadcast }));
    if (!broadcast) return;
    phase = "broadcast";
    if (await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" }) !== latestNonce) throw new Error("Deployer has pending transactions");
    const serializedTransaction = await wallet.signTransaction({ data, gas, gasPrice, nonce: latestNonce, type: "legacy" });
    hash = keccak256(serializedTransaction);
    const pending = { chainId: 4441, deployer: account.address, predictedAddress: predicted, hash, nonce: latestNonce, gas: gas.toString(), gasPrice: gasPrice.toString(), status: "prepared", preparedAt: new Date().toISOString() };
    save(pendingOutput, pending);
    const submittedHash = await publicClient.sendRawTransaction({ serializedTransaction });
    if (submittedHash !== hash) throw new Error("Unexpected submitted hash");
    save(pendingOutput, { ...pending, status: "submitted", submittedAt: new Date().toISOString() });
    console.log(JSON.stringify({ status: "submitted", hash }));
  }

  phase = "receipt confirmation";
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 2, timeout: 180_000 });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error("Deployment reverted");
  const address = getAddress(receipt.contractAddress);
  await verify(address, receipt.blockNumber);
  const recorded = { chainId: 4441, address, nusd: token, owner: account.address, feeRecipient: account.address, platformFeeBps: 40, collections, implementation, deploymentBlock: receipt.blockNumber.toString(), deploymentHash: receipt.transactionHash, gasUsed: receipt.gasUsed.toString(), effectiveGasPrice: receipt.effectiveGasPrice.toString(), gasCostZkLtc: formatEther(receipt.gasUsed * receipt.effectiveGasPrice) };
  save(output, recorded);
  fs.unlinkSync(pendingOutput);
  console.log(JSON.stringify({ status: "deployed-verified", gasUsed: receipt.gasUsed.toString(), ...recorded }));
}

run().catch((error) => {
  const safeMessages = ["Deployer has pending transactions", "Insufficient deployment gas balance", "Predicted address already has code", "Runtime bytecode mismatch", "Unexpected deployment state", "Deployment reverted", "Prepared transaction hash mismatch", "Unexpected submitted hash"];
  const detail = safeMessages.includes(error?.message) ? ` ${error.message}.` : "";
  const category = ["TypeError", "TransactionNotFoundError", "HttpRequestError", "TransactionExecutionError", "RpcRequestError", "TimeoutError", "InvalidInputRpcError"].includes(error?.name) ? ` [${error.name}]` : "";
  if (phase !== "configuration" && typeof error?.details === "string") console.error(error.details.replace(/[0-9a-fA-F]{64,}/g, "[redacted]").replace(/[\r\n\t]/g, " ").slice(0, 300));
  console.error(`NUSD marketplace deployment stopped during ${phase}.${detail}${category} No automatic rebroadcast; inspect public pending records before retrying.`);
  process.exitCode = 1;
});
