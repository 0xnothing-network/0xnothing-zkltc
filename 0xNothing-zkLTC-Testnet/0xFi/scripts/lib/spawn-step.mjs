import { spawn } from "node:child_process";
import process from "node:process";

/**
 * Run one child process as a pipeline step and reject unless it exits 0.
 *
 * Shared by deploy.mjs, direct-governance.mjs and the migrate-* orchestrators,
 * which each spawn their own finalizer/preflight steps. stdio is inherited so
 * the child's operator log stays interleaved in real time.
 */
export async function runStep(command, args, extraEnv = {}, cwd = process.cwd()) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}
