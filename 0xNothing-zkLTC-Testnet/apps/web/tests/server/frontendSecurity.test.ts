import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import test from "node:test";

const WEB_ROOT = new URL("../../", import.meta.url);

function walk(dir: URL, files: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name.startsWith(".")) continue;
    const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.isDirectory()) walk(child, files);
    else if ([".ts", ".tsx", ".js", ".mjs", ".json", ".md"].includes(extname(entry.name))) {
      files.push(child.pathname);
    }
  }
  return files;
}

test("next.config fails closed on secret-like NEXT_PUBLIC names and ships a strict CSP", () => {
  const source = readFileSync(new URL("../../next.config.ts", import.meta.url), "utf8");
  assert.match(source, /PINATA\|JWT\|SECRET\|PRIVATE_KEY\|SIGNER/);
  assert.match(source, /must stay server-only/);
  assert.match(source, /Content-Security-Policy/);
  assert.match(source, /frame-ancestors 'none'/);
  assert.match(source, /object-src 'none'/);
  assert.match(source, /X-Frame-Options/);
  assert.match(source, /Strict-Transport-Security/);
  assert.match(source, /Permissions-Policy/);
  assert.match(source, /Cross-Origin-Resource-Policy/);
});

test("middleware rate-limits public API traffic after proxy auth", () => {
  const source = readFileSync(new URL("../../middleware.ts", import.meta.url), "utf8");
  assert.match(source, /publicApiRateLimitedResponse/);
});

test("PINATA_JWT is never read from a NEXT_PUBLIC_ variable", () => {
  for (const file of walk(WEB_ROOT)) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /process\.env\.NEXT_PUBLIC_[A-Z0-9_]*(?:PINATA|JWT|SECRET|PRIVATE_KEY)/u, file);
  }
});

test("Fi and Pump contract reads pin the LitVM chain id", () => {
  for (const file of walk(WEB_ROOT)) {
    if (!file.includes("/features/fi/") && !file.includes("/features/pump/")) continue;
    if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
    const source = readFileSync(file, "utf8");
    if (!source.includes("useReadContract(") && !source.includes("useBalance(")) continue;
    for (const hook of ["useReadContract", "useBalance"] as const) {
      let searchFrom = 0;
      while (source.includes(`${hook}(`, searchFrom)) {
        const start = source.indexOf(`${hook}(`, searchFrom);
        const slice = source.slice(start, start + 280);
        assert.match(slice, /chainId\s*:/, `${file} ${hook} is missing chainId`);
        searchFrom = start + hook.length;
      }
    }
  }
});

test("web package requires Node 22+", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    engines?: { node?: string };
  };
  assert.match(pkg.engines?.node ?? "", />=22/);
  assert.equal(readFileSync(new URL("../../.nvmrc", import.meta.url), "utf8").trim(), "22");
});
