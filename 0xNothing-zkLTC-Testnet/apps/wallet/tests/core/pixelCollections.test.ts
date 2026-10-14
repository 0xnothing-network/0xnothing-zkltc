import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const classic = `0x${"11".repeat(20)}`;
const upgraded = `0x${"22".repeat(20)}`;
const owner = `0x${"33".repeat(20)}`;
const recipient = `0x${"44".repeat(20)}`;
const hash = `0x${"55".repeat(32)}`;

type Nft = { collection: string; collectionName: string; tokenId: bigint; name: string; gridSize: number };
type Request = { address: string; functionName: string };
type Service = {
  loadPixelNfts(owner: string): Promise<Nft[]>;
  findPixelNft(rows: Nft[], collection: string, tokenId: string): Nft | null;
  pixelNftKey(collection: string, tokenId: bigint): string;
  transferPixelNft(params: { from: string; to: string; tokenId: bigint; name: string; collection: string }): Promise<string>;
};

function fixture() {
  const reads: Request[] = [];
  const writes: Request[] = [];
  const client = {
    readContract: async (request: Request) => { reads.push(request); return 1n; },
    multicall: async ({ contracts }: { contracts: Request[] }) => contracts.map((request) => {
      reads.push(request);
      const isCurrent = request.address === upgraded;
      return {
        status: "success",
        result: request.functionName === "userTokens" ? 1n
          : [isCurrent ? "Current artwork" : "Classic artwork", isCurrent ? 256n : 64n, "000001ffffff", owner, isCurrent ? 2n : 1n, "0x"],
      };
    }),
  };
  const imports: Record<string, unknown> = {
    "../../abis": { pixelNftAbi: [] },
    "../../config/contracts": {
      PIXEL_COLLECTIONS: [
        { address: upgraded, name: "0xPixel" },
        { address: classic, name: "0xPixel Classic" },
      ],
    },
    "../lib/pixelSvg": { pixelDataToSvgDataUrl: () => "data:image/svg+xml,test" },
    "../rpc/client": { activeNetwork: { builtin: true }, publicClient: client },
    "./tx": { writeCall: async (request: Request) => { writes.push(request); return hash; } },
  };
  const source = readFileSync(new URL("../../src/core/services/nfts.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  runInNewContext(code, {
    exports,
    require(name: string) {
      if (!Object.hasOwn(imports, name)) throw new Error(`Unexpected import: ${name}`);
      return imports[name];
    },
  });
  return { service: exports as Service, client, reads, writes };
}

test("the wallet preserves both collections when their token ids overlap", async () => {
  const { service, reads } = fixture();
  const rows = await service.loadPixelNfts(owner);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.collection, upgraded);
  assert.equal(rows[0]?.gridSize, 256);
  assert.equal(rows[1]?.collection, classic);
  assert.equal(rows[0]?.tokenId, rows[1]?.tokenId);
  assert.notEqual(service.pixelNftKey(upgraded, 1n), service.pixelNftKey(classic, 1n));
  assert.equal(service.findPixelNft(rows, classic.toUpperCase(), "1")?.name, "Classic artwork");
  assert.equal(service.findPixelNft(rows, upgraded, "1")?.name, "Current artwork");
  assert.equal(service.findPixelNft(rows, recipient, "1"), null);
  for (const address of [classic, upgraded]) {
    assert.deepEqual(reads.filter((read) => read.address === address).map((read) => read.functionName), ["balanceOf", "userTokens", "tokenData"]);
  }
});

test("an upgraded NFT transfer targets its collection while Classic transfers still work", async () => {
  const { service, writes } = fixture();
  const params = { from: owner, to: recipient, tokenId: 1n, name: "Artwork" };
  assert.equal(await service.transferPixelNft({ ...params, collection: upgraded }), hash);
  assert.equal(await service.transferPixelNft({ ...params, collection: classic }), hash);
  assert.deepEqual(writes.map((write) => write.address), [upgraded, classic]);
  await assert.rejects(service.transferPixelNft({ ...params, collection: recipient }), /Unknown 0xPixel collection/u);
  assert.equal(writes.length, 2);
});

test("a failure in either collection keeps a complete inventory from being replaced with a partial one", async () => {
  const { service, client } = fixture();
  const read = client.readContract;
  client.readContract = async (request) => {
    if (request.address === classic) throw new Error("Classic RPC unavailable");
    return read(request);
  };
  await assert.rejects(service.loadPixelNfts(owner), /Classic RPC unavailable/u);
});

test("a 256-wide Classic-compatible run renders the full row after splitting 255 plus 1", () => {
  const source = readFileSync(new URL("../../src/core/lib/pixelSvg.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  runInNewContext(code, { exports });
  const renderer = exports as { pixelDataToSvgMarkup(data: string, grid: number): string };
  const svg = renderer.pixelDataToSvgMarkup("0000ffffffffff0001ffffff", 256);
  assert.match(svg, /viewBox="0 0 256 256"/u);
  assert.match(svg, /M0 0h255v1h-255zM255 0h1v1h-1z/u);
});
