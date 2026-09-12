// SPDX-License-Identifier: MIT
// Minimal dotenv loader — no dependency. Loads KEY=VALUE lines into process.env
// WITHOUT overriding variables already set (real env wins over the file). Quotes
// around values are stripped. Comments and blank lines are skipped.

import { existsSync, readFileSync } from "node:fs";

export function loadDotEnvFile(path: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (!existsSync(path)) return [];
  const seen: string[] = [];
  const text = readFileSync(path, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue; // ignore malformed lines rather than crash the server
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (env[key] === undefined) env[key] = value;
    seen.push(key);
  }
  return seen;
}
