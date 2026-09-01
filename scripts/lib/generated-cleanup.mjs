import { execFile } from "node:child_process";
import { lstat, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Keep this list explicit. In particular, generated Graph bindings committed to
// Git are deliberately absent so a cleanup can never turn them into deletions.
export const GENERATED_DIRECTORIES = Object.freeze([
  "0xNothing-zkLTC-Mainnet/contracts/cache",
  "0xNothing-zkLTC-Mainnet/contracts/out",
  "0xNothing-zkLTC-Mainnet/subgraphs/0xpump/build",
  "0xNothing-zkLTC-Mainnet/subgraphs/0xpump/generated",
  "0xNothing-zkLTC-Testnet/0xFi/contracts/cache",
  "0xNothing-zkLTC-Testnet/0xFi/contracts/out",
  "0xNothing-zkLTC-Testnet/0xFi/subgraph/build",
  "0xNothing-zkLTC-Testnet/apps/wallet/dist",
  "0xNothing-zkLTC-Testnet/apps/web/.next",
  "0xNothing-zkLTC-Testnet/apps/web/.next-dev",
  "0xNothing-zkLTC-Testnet/apps/web/.open-next",
  "0xNothing-zkLTC-Testnet/contracts/cache",
  "0xNothing-zkLTC-Testnet/contracts/out",
  "0xNothing-zkLTC-Testnet/subgraphs/0xpixel-marketplace/build",
  "0xNothing-zkLTC-Testnet/subgraphs/0xpump/build",
  "0xNothing-zkLTC-Testnet/subgraphs/0xpump/generated",
]);

export function parseCleanupArguments(args) {
  let dryRun = false;
  for (const argument of args) {
    if (argument === "--dry-run") dryRun = true;
    else throw new Error(`Unknown cleanup option: ${argument}`);
  }
  return { dryRun };
}

export function resolveWorkspacePath(workspaceRoot, relativePath) {
  if (typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath)) {
    throw new Error(`Refusing invalid cleanup target: ${String(relativePath)}`);
  }

  const root = path.resolve(workspaceRoot);
  const absolutePath = path.resolve(root, relativePath);
  const relativeToRoot = path.relative(root, absolutePath);
  if (
    !relativeToRoot
    || relativeToRoot === ".."
    || relativeToRoot.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeToRoot)
  ) {
    throw new Error(`Refusing to clean outside workspace: ${relativePath}`);
  }
  return absolutePath;
}

async function targetStatus(targetPath) {
  try {
    return await lstat(targetPath);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

export async function findGitTrackedFiles({ workspaceRoot, relativePath }) {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", path.resolve(workspaceRoot), "ls-files", "-z", "--", relativePath],
    { encoding: "utf8", maxBuffer: 1024 * 1024, windowsHide: true },
  );
  return stdout.split("\0").filter(Boolean);
}

export async function cleanGeneratedDirectories({
  workspaceRoot,
  dryRun = false,
  directories = GENERATED_DIRECTORIES,
  findTrackedFiles = findGitTrackedFiles,
  log = console.log,
}) {
  if (!Array.isArray(directories) || new Set(directories).size !== directories.length) {
    throw new Error("Generated cleanup allowlist must contain unique paths");
  }

  const targets = [];
  for (const relativePath of directories) {
    const absolutePath = resolveWorkspacePath(workspaceRoot, relativePath);
    const status = await targetStatus(absolutePath);
    if (!status) continue;
    if (status.isSymbolicLink()) {
      throw new Error(`Refusing to recursively clean a symbolic link: ${relativePath}`);
    }
    if (!status.isDirectory()) {
      throw new Error(`Refusing to clean a non-directory target: ${relativePath}`);
    }
    const trackedFiles = await findTrackedFiles({ workspaceRoot, relativePath });
    if (trackedFiles.length > 0) {
      throw new Error(
        `Refusing to clean ${relativePath}; Git tracks ${trackedFiles.length} file(s) inside it`,
      );
    }
    targets.push({ absolutePath, relativePath });
  }

  for (const { absolutePath, relativePath } of targets) {
    if (dryRun) log(`would remove: ${relativePath}`);
    else {
      await rm(absolutePath, { recursive: true, force: true });
      log(`removed: ${relativePath}`);
    }
  }
  return targets.length;
}
