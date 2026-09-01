import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * The wallet duplicates the site's design tokens instead of importing them —
 * an extension ships as a fixed bundle, and reaching into apps/web at build time
 * would couple the two trees. The duplicate is only honest while it is identical,
 * which is what this test enforces: every `--fi-*` the wallet declares must
 * carry the site's value, character for character.
 *
 * A token the wallet does not use (the site's grid widths, layer indices) is not
 * required; a token it declares differently is a bug.
 */
const WALLET_CSS = new URL("../../src/styles/wallet.css", import.meta.url);
const SITE_CSS = new URL("../../../web/app/0xFi/globals.css", import.meta.url);
const ASSETS_TS = new URL("../../src/config/assets.ts", import.meta.url);

function tokensIn(path: URL, selector: string): Map<string, string> {
  const css = readFileSync(path, "utf8");
  const start = css.indexOf(selector);
  assert.notEqual(start, -1, `${selector} is missing from ${path.pathname}`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  const block = css.slice(open + 1, close);
  const found = new Map<string, string>();
  for (const line of block.split(";")) {
    const [name = "", ...rest] = line.split(":");
    const key = name.trim();
    if (!key.startsWith("--fi-")) continue;
    found.set(key, rest.join(":").trim());
  }
  return found;
}

test("wallet design tokens match the site's, value for value", () => {
  const wallet = tokensIn(WALLET_CSS, ".w-root {");
  const site = tokensIn(SITE_CSS, ".fi-root {");

  assert.ok(wallet.size >= 18, `the wallet only declares ${wallet.size} --fi-* tokens`);
  for (const [key, value] of wallet) {
    const expected = site.get(key);
    assert.notEqual(expected, undefined, `${key} does not exist in 0xFi/globals.css`);
    assert.equal(value, expected, `${key} drifted between the wallet and the site`);
  }
});

test("the wallet's own tokens stay out of the --fi- namespace", () => {
  const css = readFileSync(WALLET_CSS, "utf8");
  const open = css.indexOf("{", css.indexOf(".w-root {"));
  const block = css.slice(open + 1, css.indexOf("}", open));
  const own = block
    .split(";")
    .map((line) => line.split(":")[0]?.trim() ?? "")
    .filter((name) => name.startsWith("--") && !name.startsWith("--fi-"));
  assert.deepEqual(own, ["--w-gutter", "--w-nav-height"]);
});

test("canonical zkLTC and NUSD carry the verified CORE mark", () => {
  const source = readFileSync(ASSETS_TS, "utf8");
  const native = source.slice(source.indexOf("export const NATIVE_TOKEN"), source.indexOf("/** Native metadata"));
  const nusd = source.slice(source.indexOf("export const NUSD_TOKEN"), source.indexOf("export const BUILTIN_TOKENS"));
  assert.match(native, /verified:\s*true/u);
  assert.match(nusd, /verified:\s*true/u);
});
