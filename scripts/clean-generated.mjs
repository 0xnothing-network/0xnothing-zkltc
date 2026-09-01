import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  cleanGeneratedDirectories,
  parseCleanupArguments,
} from "./lib/generated-cleanup.mjs";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { dryRun } = parseCleanupArguments(process.argv.slice(2));
const cleaned = await cleanGeneratedDirectories({ workspaceRoot, dryRun });

console.log(
  `${dryRun ? "found" : "cleaned"} ${cleaned} generated director${cleaned === 1 ? "y" : "ies"}`,
);
