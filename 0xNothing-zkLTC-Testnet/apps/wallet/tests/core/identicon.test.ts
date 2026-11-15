import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { identiconDataUrl, identiconSvg } from "../../src/core/lib/identicon.ts";

/** F15: a deterministic picture per address, drawn locally. */
const A = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const B = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
const source = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

function cells(svg: string): Set<string> {
  return new Set([...svg.matchAll(/M(\d) (\d)h1v1h-1z/gu)].map((match) => `${match[1]},${match[2]}`));
}

test("the same address always gives the same picture, whatever its case", () => {
  assert.equal(identiconSvg(A), identiconSvg(A));
  assert.equal(identiconSvg(A), identiconSvg(A.toLowerCase()));
  assert.equal(identiconSvg(A), identiconSvg(A.toUpperCase().replace("0X", "0x")));
  assert.notEqual(identiconSvg(A), identiconSvg(B));
  // One changed digit in the middle changes the picture.
  const twin = `${A.slice(0, 20)}${A[20] === "0" ? "f" : "0"}${A.slice(21)}`;
  assert.notEqual(identiconSvg(A), identiconSvg(twin));
});

test("anything that is not an address gives nothing, so the caller falls back", () => {
  for (const bad of ["", "0x", "0x123", `${A}00`, A.slice(2), `0x${"g".repeat(40)}`, `<svg>${A}`, null, 42]) {
    assert.equal(identiconSvg(bad as string), "");
    assert.equal(identiconDataUrl(bad as string), "");
  }
});

test("the grid is mirrored, never blank, and the markup carries only computed numbers", () => {
  for (const address of [A, B, `0x${"0".repeat(40)}`, `0x${"f".repeat(40)}`]) {
    const svg = identiconSvg(address);
    const on = cells(svg);
    assert.ok(on.size > 0, address);
    for (const cell of on) {
      const [x, y] = cell.split(",").map(Number);
      assert.ok(on.has(`${4 - (x ?? 0)},${y}`), `${address} ${cell} has no mirror`);
    }
    const stripped = svg
      .replace(/<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="-1 -1 7 7" shape-rendering="crispEdges">/u, "")
      .replace(/<rect x="-1" y="-1" width="7" height="7" fill="hsl\(\d{1,3},25%,20%\)"\/>/u, "")
      .replace(/<path fill="hsl\(\d{1,3},\d{2}%,60%\)" d="(M\d \dh1v1h-1z)+"\/><\/svg>/u, "");
    assert.equal(stripped, "", address);
  }
  assert.match(identiconDataUrl(A), /^data:image\/svg\+xml,%3Csvg/u);
});

test("the picture leads the account and recipient rows and the approval signer", () => {
  assert.match(source("src/ui/screens/Home.tsx"), /<Identicon address=\{address\} size=\{24\} \/>/u);
  assert.match(source("src/ui/components/AccountSheet.tsx"), /<Identicon address=\{meta\.address\} size=\{24\} \/>/u);
  assert.match(source("src/ui/components/RecipientHints.tsx"), /<Identicon address=\{address\} size=\{12\} \/>/u);
  const approve = source("src/ui/screens/Approve.tsx");
  assert.equal(approve.match(/value=\{<SignerAddress signer=\{signer\} \/>\}/gu)?.length, 2);
  assert.match(source("src/ui/components/Identicon.tsx"), /alt=""\s+aria-hidden="true"/u);
});

/** A deterministic stream of hex digits, so the sample is the same on every run. */
function hexStream(seed: number): (count: number) => string {
  let state = seed >>> 0;
  return (count) => {
    let out = "";
    for (let index = 0; index < count; index += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      out += (state >>> 28).toString(16);
    }
    return out;
  };
}

const hueOf = (svg: string): string => svg.match(/<path fill="hsl\((\d+),/u)?.[1] ?? "";
const gridOf = (svg: string): string => [...cells(svg)].sort().join(";");

test("a look-alike that shares the first 8 and last 4 digits gets another colour and grid", () => {
  const next = hexStream(4441);
  const reference = identiconSvg(`0x12345678${next(28)}abcd`);
  let otherHue = 0;
  let otherGrid = 0;
  for (let index = 0; index < 1000; index += 1) {
    const svg = identiconSvg(`0x12345678${next(28)}abcd`);
    if (hueOf(svg) !== hueOf(reference)) otherHue += 1;
    if (gridOf(svg) !== gridOf(reference)) otherGrid += 1;
  }
  assert.ok(otherHue >= 985, `${otherHue} of 1000 hues differ`);
  assert.ok(otherGrid >= 990, `${otherGrid} of 1000 grids differ`);
});

test("digits 19 to 39 count: addresses that differ only there give different pictures", () => {
  const head = "0x1234567890abcdef123";
  assert.notEqual(identiconSvg(`${head}${"0".repeat(17)}abcd`), identiconSvg(`${head}${"f".repeat(17)}abcd`));
  for (let position = 19; position < 40; position += 1) {
    const zero = `0x${"5".repeat(position)}0${"5".repeat(39 - position)}`;
    const nine = `0x${"5".repeat(position)}9${"5".repeat(39 - position)}`;
    assert.notEqual(identiconSvg(zero), identiconSvg(nine), `digit ${position}`);
  }
});
