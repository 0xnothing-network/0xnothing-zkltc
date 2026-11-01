import assert from "node:assert/strict";
import test from "node:test";
import { evaluateModule } from "../helpers/evaluateModule.ts";

const config = evaluateModule<{ normalizePumpIpfsPath: (value: string) => string }>(
  new URL("../../features/pump/config.ts", import.meta.url), { "@/lib/publicConfig": {} },
);
const { tokenImageUrl } = evaluateModule<{ tokenImageUrl(uri?: string, symbol?: string): string | undefined }>(
  new URL("../../features/fi/lib/tokenImage.ts", import.meta.url),
  { "@/features/pump/config": config },
  { URL, URLSearchParams },
);
const cid = "bafkreig3eedskjp45hcwf47bhfcwxtlw5fayiwmxcc472hvysunyhy2dqy";
const proxied = `/api/pump/image?cid=${cid}&symbol=AB`;

test("token logos render only as proxied immutable CIDs", () => {
  for (const uri of [
    `ipfs://${cid}`,
    `https://ipfs.io/ipfs/${cid}`,
    `https://ipfs.io/ipfs/${cid}?filename=logo.png`,
    `https://${cid}.ipfs.dweb.link/`,
    `https://anyone.mypinata.cloud/ipfs/${cid}`,
  ]) {
    assert.equal(tokenImageUrl(uri, "ab"), proxied, uri);
  }
  for (const uri of [
    "https://ipfs.io/ipns/k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8",
    "https://creator.mypinata.cloud/logo.png?track=1",
    "https://example.org/logo.png",
    `http://ipfs.io/ipfs/${cid}`,
  ]) {
    assert.equal(tokenImageUrl(uri, "ab"), undefined, uri);
  }
});
