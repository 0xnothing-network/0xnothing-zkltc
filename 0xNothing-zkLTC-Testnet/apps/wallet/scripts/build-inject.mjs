import { fileURLToPath } from "node:url";
import { build } from "vite";

/**
 * The two dapp-facing scripts must be classic (non-module) scripts:
 *
 *  - content.js runs in the ISOLATED world and relays messages to the service
 *    worker; Chrome only loads manifest content scripts as classic scripts.
 *  - inpage.js runs in the MAIN world and installs the EIP-1193 provider; it
 *    must not create module scope or the page could not be reached at
 *    document_start.
 *
 * Both are emitted with stable, unhashed names because public/manifest.json
 * references them verbatim. Run after `vite build`, which owns emptying dist/.
 */
const root = fileURLToPath(new URL("..", import.meta.url));

const targets = [
  { name: "content", entry: "src/extension/content.ts" },
  { name: "inpage", entry: "src/extension/inpage.ts" },
];

for (const target of targets) {
  await build({
    root,
    configFile: false,
    logLevel: "warn",
    build: {
      target: "chrome120",
      outDir: "dist",
      emptyOutDir: false,
      sourcemap: false,
      lib: {
        entry: fileURLToPath(new URL(`../${target.entry}`, import.meta.url)),
        formats: ["iife"],
        name: `__0xnothingWallet_${target.name}`,
        fileName: () => `${target.name}.js`,
      },
      rollupOptions: {
        // `extend: true` so the IIFE augments the global it names instead of
        // replacing whatever else is already there. A lib build emits one file
        // by itself, so nothing needs to ask for inlined dynamic imports.
        output: { extend: true },
      },
    },
  });
  console.log(`[wallet] built dist/${target.name}.js`);
}
