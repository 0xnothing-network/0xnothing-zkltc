import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";

const PLACEHOLDER = /__[A-Z0-9_]+__/gu;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const UNSIGNED_INTEGER = /^\d+$/u;
const NETWORK = /^[A-Za-z0-9_-]+$/u;

function replacementValue(token, input) {
  const value = String(input);
  if (!value || /[\0\r\n]/u.test(value)) {
    throw new Error(`${token} contains an unsafe manifest value`);
  }
  if (token === "__NETWORK__" && !NETWORK.test(value)) {
    throw new Error(`${token} must be a safe network identifier`);
  }
  if (token.endsWith("_ADDRESS__") && !EVM_ADDRESS.test(value)) {
    throw new Error(`${token} must be a 20-byte EVM address`);
  }
  if (token.endsWith("_BLOCK__")) {
    if (!UNSIGNED_INTEGER.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new Error(`${token} must be a JavaScript-safe unsigned integer`);
    }
  }
  return value;
}

export function renderSubgraphManifest(template, replacements) {
  if (typeof template !== "string" || !template) {
    throw new Error("Subgraph template is empty");
  }

  const expected = new Set(template.match(PLACEHOLDER) || []);
  let manifest = template;
  for (const [token, input] of Object.entries(replacements)) {
    if (!/^__[A-Z0-9_]+__$/u.test(token)) {
      throw new Error(`Invalid subgraph placeholder: ${token}`);
    }
    if (!expected.has(token)) {
      throw new Error(`Subgraph template does not contain ${token}`);
    }
    manifest = manifest.replaceAll(token, replacementValue(token, input));
  }

  const unresolved = [...new Set(manifest.match(PLACEHOLDER) || [])];
  if (unresolved.length > 0) {
    throw new Error(`Subgraph template contains unresolved placeholders: ${unresolved.join(", ")}`);
  }
  return manifest;
}

export async function writeFileIfChanged(targetPath, contents) {
  try {
    if (await readFile(targetPath, "utf8") === contents) return false;
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }

  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, targetPath);
  } finally {
    await unlink(temporaryPath).catch((error) => {
      if (!error || error.code !== "ENOENT") throw error;
    });
  }
  return true;
}
