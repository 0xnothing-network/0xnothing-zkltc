import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(join(root, "0xNothing-zkLTC-Testnet/apps/web/package.json"));
const ts = require("typescript");
const components = ["TradePanel", "CreateTokenForm", "NusdOraclePanel", "TokenDetail", "PumpStatsDashboard"];
function jsxTrees(text, file) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const roots = [];
  function visit(node) {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) {
      roots.push(node.getText(source));
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return roots;
}
const results = components.map((name) => {
  const path = `0xNothing-zkLTC-Testnet/apps/web/features/pump/components/${name}.tsx`;
  const before = jsxTrees(execFileSync("git", ["show", `HEAD:${path}`], { cwd: root, encoding: "utf8" }), path);
  const after = jsxTrees(readFileSync(join(root, path), "utf8"), path);
  return { path, jsxRoots: after.length, unchanged: JSON.stringify(before) === JSON.stringify(after) };
});
writeFileSync(join(root, "output/audit-2026-09-06/pump-jsx-preservation.json"), `${JSON.stringify(results, null, 2)}\n`);
console.log(JSON.stringify(results));
if (results.some((result) => !result.unchanged)) process.exitCode = 1;
