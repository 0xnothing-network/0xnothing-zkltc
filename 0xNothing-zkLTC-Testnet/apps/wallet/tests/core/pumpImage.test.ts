import assert from "node:assert/strict";
import { test } from "node:test";
import { PUBLIC_APP_URL } from "../../src/config/dapps.ts";
import { pumpTokenImageUrl } from "../../src/core/lib/pumpImage.ts";

const CID = "QmYwAPJzv5CZsnAzt8auVZRnGiRAhT1h9Yhcs4Zc1JxZ6H";

test("0xFi proxy images are revalidated and rebuilt for the extension", () => {
  assert.equal(
    pumpTokenImageUrl(`/api/pump/image?cid=${CID}&symbol=BAD`, "PX"),
    `${PUBLIC_APP_URL}/api/pump/image?cid=${CID}&symbol=PX`,
  );
  assert.equal(
    pumpTokenImageUrl(`${PUBLIC_APP_URL}/api/pump/image?cid=${CID}`, "FI"),
    `${PUBLIC_APP_URL}/api/pump/image?cid=${CID}&symbol=FI`,
  );
});

test("a lookalike host cannot become a token image source", () => {
  assert.equal(
    pumpTokenImageUrl(`https://0xnothing.xyz.evil.example/api/pump/image?cid=${CID}`),
    undefined,
  );
});
