import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(join(root, "0xNothing-zkLTC-Testnet/apps/web/package.json"));
const ts = require("typescript");
const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".sol", ".yul", ".py", ".ps1", ".sh", ".cmd", ".bat", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".graphql", ".css", ".html", ".xml", ".svg", ".hbs", ".ejs", ".example"]);
const files = [...new Set(execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).split("\0").filter(Boolean))].sort();
const inventory = [];
const findings = [];
const missing = [];
const excluded = [];

function category(path) {
  if (path.includes("/lib/openzeppelin-contracts/")) return "vendored";
  if (path.startsWith("output/") || path.includes("/generated/") || path.includes("/abis/") && extname(path) === ".json") return "generated-or-artifact";
  if (path.startsWith(".codex/") || path.startsWith("graft/")) return "agent-metadata";
  if (/(^|\/)(tests?|mocks|helpers)\//.test(path) || /\.(test|t)\./.test(path)) return "test";
  return "project";
}

function resolveImport(path, specifier) {
  const target = resolve(root, dirname(path), specifier);
  return [target, ...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".d.ts", ".json", ".css", "/index.ts", "/index.tsx", "/index.js"].map((suffix) => target + suffix), target.replace(/\.js$/, ".ts")].some(existsSync);
}

for (const path of files) {
  if (path.startsWith("output/source-audit-2026-09-30/")) continue;
  if (!sourceExtensions.has(extname(path)) && !/(^|\/)(Dockerfile|\.[^/]*ignore)$/.test(path)) {
    excluded.push({ path, reason: "Not a recognized source/configuration extension; retained for coverage inspection" });
    continue;
  }
  if (!existsSync(join(root, path))) { missing.push(path); continue; }
  const bytes = readFileSync(join(root, path));
  const text = bytes.toString("utf8");
  const kind = category(path);
  inventory.push({ path, category: kind, bytes: bytes.length, lines: text.split("\n").length, sha256: createHash("sha256").update(bytes).digest("hex") });
  if (/\.[cm]?[jt]sx?$/.test(path)) {
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    for (const diagnostic of source.parseDiagnostics) {
      findings.push({ path, category: kind, rule: "syntax", line: source.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " ") });
    }
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      const specifier = statement.moduleSpecifier;
      if (!specifier || !ts.isStringLiteral(specifier)) continue;
      if (specifier.text.startsWith(".") && !resolveImport(path, specifier.text)) {
        findings.push({ path, category: kind, rule: "unresolved-relative-import", specifier: specifier.text });
      }
      if (kind === "project" && /(^|\/)(tests?|mocks)\/|\.test\./.test(specifier.text)) {
        findings.push({ path, category: kind, rule: "production-imports-test-code", specifier: specifier.text });
      }
    }
  } else if (extname(path) === ".json" || extname(path) === ".jsonc") {
    try {
      if (/\/(tsconfig[^/]*|jsconfig)\.json$/.test(path) || extname(path) === ".jsonc") {
        const parsed = ts.parseConfigFileTextToJson(path, text);
        if (parsed.error) throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, " "));
      } else JSON.parse(text.replace(/^\uFEFF/, ""));
    }
    catch (error) { findings.push({ path, category: kind, rule: "json-syntax", message: error.message }); }
  }
}

const contractParity = [];
for (const file of inventory.filter((file) => file.path.startsWith("0xNothing-zkLTC-Mainnet/contracts/src/"))) {
  const sibling = inventory.find((candidate) => candidate.path === file.path.replace("0xNothing-zkLTC-Mainnet/", "0xNothing-zkLTC-Testnet/"));
  if (sibling) contractParity.push({ mainnet: file.path, testnet: sibling.path, identical: file.sha256 === sibling.sha256 });
}
const summary = {
  inventoryCount: inventory.length,
  categories: Object.fromEntries([...new Set(inventory.map((file) => file.category))].map((kind) => [kind, inventory.filter((file) => file.category === kind).length])),
  totalBytes: inventory.reduce((sum, file) => sum + file.bytes, 0),
  findings, missingWorkingTreePaths: missing, contractParity, excludedNonSourceCount: excluded.length,
  limitation: "Complete byte inventory and automated syntax/import screening of tracked and unignored source/configuration files; this is not a complete manual semantic or independent security audit. Ignored dependencies, build caches, secrets and binary assets are outside this inventory.",
};
writeFileSync(new URL("inventory.json", import.meta.url), JSON.stringify({ summary, files: inventory, excluded }, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
