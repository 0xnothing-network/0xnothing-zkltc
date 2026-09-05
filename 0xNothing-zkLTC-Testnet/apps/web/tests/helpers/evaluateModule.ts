import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

/** Execute the actual module with explicit boundaries, without network or React DOM. */
export function evaluateModule<T>(
  file: URL,
  imports: Record<string, unknown>,
  globals: Record<string, unknown> = {},
): T {
  const code = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: file.pathname,
  }).outputText;
  const exports = {};
  runInNewContext(code, {
    exports,
    require(name: string) {
      if (!Object.hasOwn(imports, name)) throw new Error(`Unexpected import: ${name}`);
      return imports[name];
    },
    ...globals,
  }, { filename: file.pathname });
  return exports as T;
}
