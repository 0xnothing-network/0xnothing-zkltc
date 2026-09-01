import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { decodeEvmAddressWord, requestJsonRpc } from "../lib/evm-rpc.mjs";
import {
  cleanGeneratedDirectories,
  GENERATED_DIRECTORIES,
  parseCleanupArguments,
  resolveWorkspacePath,
} from "../lib/generated-cleanup.mjs";
import { readLimitedJsonResponse } from "../lib/http-json.mjs";
import {
  assertPumpSubgraphParity,
  findPumpSubgraphDrift,
} from "../lib/pump-subgraph-parity.mjs";
import {
  renderSubgraphManifest,
  writeFileIfChanged,
} from "../lib/subgraph-manifest.mjs";

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), directory);
    assert.ok(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test("generated cleanup rejects unsafe arguments and workspace escapes", () => {
  const workspaceRoot = path.resolve(os.tmpdir(), "0xn-workspace-boundary");
  assert.deepEqual(parseCleanupArguments([]), { dryRun: false });
  assert.deepEqual(parseCleanupArguments(["--dry-run"]), { dryRun: true });
  assert.throws(() => parseCleanupArguments(["--dry-rnu"]), /Unknown cleanup option/);
  assert.throws(
    () => resolveWorkspacePath(workspaceRoot, path.join("..", "outside")),
    /outside workspace/,
  );
  assert.throws(() => resolveWorkspacePath(workspaceRoot, "."), /outside workspace/);
});

test("generated cleanup never targets Graph bindings tracked by Git", () => {
  assert.equal(
    GENERATED_DIRECTORIES.includes("0xNothing-zkLTC-Testnet/0xFi/subgraph/generated"),
    false,
  );
  assert.equal(
    GENERATED_DIRECTORIES.includes("0xNothing-zkLTC-Testnet/subgraphs/0xpixel-marketplace/generated"),
    false,
  );
});

test("generated cleanup dry-run is non-mutating and real cleanup is scoped", async (t) => {
  const workspaceRoot = await temporaryDirectory(t, "0xn-cleanup-");
  const generated = path.join(workspaceRoot, "project", "build");
  await mkdir(generated, { recursive: true });
  await writeFile(path.join(generated, "artifact.txt"), "generated", "utf8");
  const logs = [];

  assert.equal(await cleanGeneratedDirectories({
    workspaceRoot,
    dryRun: true,
    directories: ["project/build"],
    findTrackedFiles: async () => [],
    log: (line) => logs.push(line),
  }), 1);
  assert.equal(await readFile(path.join(generated, "artifact.txt"), "utf8"), "generated");

  assert.equal(await cleanGeneratedDirectories({
    workspaceRoot,
    directories: ["project/build"],
    findTrackedFiles: async () => [],
    log: (line) => logs.push(line),
  }), 1);
  await assert.rejects(readFile(path.join(generated, "artifact.txt"), "utf8"), /ENOENT/);
  assert.deepEqual(logs, ["would remove: project/build", "removed: project/build"]);
});

test("generated cleanup fails closed when an allowlisted directory contains tracked files", async (t) => {
  const workspaceRoot = await temporaryDirectory(t, "0xn-cleanup-tracked-");
  const safeGenerated = path.join(workspaceRoot, "project", "build");
  const generated = path.join(workspaceRoot, "project", "generated");
  await Promise.all([
    mkdir(safeGenerated, { recursive: true }),
    mkdir(generated, { recursive: true }),
  ]);
  await writeFile(path.join(safeGenerated, "artifact.txt"), "safe generated", "utf8");
  await writeFile(path.join(generated, "schema.ts"), "tracked", "utf8");

  await assert.rejects(cleanGeneratedDirectories({
    workspaceRoot,
    directories: ["project/build", "project/generated"],
    findTrackedFiles: async ({ relativePath }) => relativePath === "project/generated"
      ? ["project/generated/schema.ts"]
      : [],
  }), /Git tracks 1 file/);
  assert.equal(await readFile(path.join(safeGenerated, "artifact.txt"), "utf8"), "safe generated");
  assert.equal(await readFile(path.join(generated, "schema.ts"), "utf8"), "tracked");
});

test("generated cleanup refuses an allowlisted path that is not a directory", async (t) => {
  const workspaceRoot = await temporaryDirectory(t, "0xn-cleanup-file-");
  const generated = path.join(workspaceRoot, "project", "build");
  await mkdir(path.dirname(generated), { recursive: true });
  await writeFile(generated, "not a directory", "utf8");

  await assert.rejects(cleanGeneratedDirectories({
    workspaceRoot,
    directories: ["project/build"],
    findTrackedFiles: async () => [],
  }), /non-directory target/);
  assert.equal(await readFile(generated, "utf8"), "not a directory");
});

test("subgraph manifest rendering rejects unresolved and injectable values", () => {
  const template = [
    "network: __NETWORK__",
    'address: "__CONTRACT_ADDRESS__"',
    "startBlock: __START_BLOCK__",
    "",
  ].join("\n");
  const address = `0x${"ab".repeat(20)}`;
  assert.equal(renderSubgraphManifest(template, {
    __NETWORK__: "liteforge",
    __CONTRACT_ADDRESS__: address,
    __START_BLOCK__: 123,
  }), `network: liteforge\naddress: "${address}"\nstartBlock: 123\n`);
  assert.throws(
    () => renderSubgraphManifest(template, { __NETWORK__: "liteforge\nmalicious: true" }),
    /safe network identifier|unsafe manifest value/,
  );
  assert.throws(
    () => renderSubgraphManifest(template, {
      __NETWORK__: "liteforge",
      __CONTRACT_ADDRESS__: "0x1234",
      __START_BLOCK__: 123,
    }),
    /20-byte EVM address/,
  );
  assert.throws(
    () => renderSubgraphManifest(template, {
      __NETWORK__: "liteforge",
      __CONTRACT_ADDRESS__: address,
    }),
    /unresolved placeholders.*__START_BLOCK__/,
  );
});

test("subgraph manifests are replaced only when their bytes change", async (t) => {
  const directory = await temporaryDirectory(t, "0xn-manifest-");
  const target = path.join(directory, "subgraph.yaml");
  assert.equal(await writeFileIfChanged(target, "first\n"), true);
  assert.equal(await writeFileIfChanged(target, "first\n"), false);
  assert.equal(await writeFileIfChanged(target, "second\n"), true);
  assert.equal(await readFile(target, "utf8"), "second\n");
});

test("HTTP JSON parsing applies a byte limit and clear malformed-data errors", async () => {
  assert.deepEqual(
    await readLimitedJsonResponse(new Response('{"ok":true}'), { maxBytes: 32 }),
    { ok: true },
  );
  await assert.rejects(
    readLimitedJsonResponse(new Response(`{"value":"${"x".repeat(40)}"}`), { maxBytes: 16 }),
    /exceeds 16 bytes/,
  );
  await assert.rejects(
    readLimitedJsonResponse(new Response("not json"), { maxBytes: 32, label: "RPC" }),
    /RPC returned malformed JSON/,
  );
});

test("JSON-RPC helper validates response identity and canonical ABI addresses", async () => {
  const address = `0x${"ab".repeat(20)}`;
  const word = `0x${"0".repeat(24)}${address.slice(2)}`;
  assert.equal(decodeEvmAddressWord(word, "router"), address);
  assert.throws(
    () => decodeEvmAddressWord(`0x01${"0".repeat(22)}${address.slice(2)}`, "router"),
    /non-zero ABI address padding/,
  );
  const result = await requestJsonRpc("https://rpc.invalid", "eth_chainId", [], {
    fetchImpl: async () => new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1159" }),
      { status: 200 },
    ),
  });
  assert.equal(result, "0x1159");
  await assert.rejects(
    requestJsonRpc("https://rpc.invalid", "eth_chainId", [], {
      fetchImpl: async () => new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 2, result: "0x1159" }),
        { status: 200 },
      ),
    }),
    /mismatched JSON-RPC response/,
  );
});

test("Pump subgraph parity reports source drift between testnet and mainnet", async (t) => {
  const directory = await temporaryDirectory(t, "0xn-parity-");
  const testnetRoot = path.join(directory, "testnet");
  const mainnetRoot = path.join(directory, "mainnet");
  await Promise.all([
    mkdir(path.join(testnetRoot, "src"), { recursive: true }),
    mkdir(path.join(mainnetRoot, "src"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(testnetRoot, "src", "mapping.ts"), "same\n", "utf8"),
    writeFile(path.join(mainnetRoot, "src", "mapping.ts"), "same\n", "utf8"),
  ]);
  const options = { testnetRoot, mainnetRoot, files: ["src/mapping.ts"] };
  assert.equal(await assertPumpSubgraphParity(options), 1);

  await writeFile(path.join(mainnetRoot, "src", "mapping.ts"), "drift\n", "utf8");
  assert.deepEqual(await findPumpSubgraphDrift(options), ["src/mapping.ts"]);
  await assert.rejects(assertPumpSubgraphParity(options), /Pump testnet\/mainnet mirror drift/);
});
