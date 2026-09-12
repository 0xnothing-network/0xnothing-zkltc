// SPDX-License-Identifier: MIT
// ESM resolve hook: redirect "viem" (+ its subpaths) to the monorepo's installed
// copy under apps/web/node_modules, so quantum-wallet/{sdk,relayer} tests run
// without their own node_modules. Safe to keep even after a junction exists —
// both paths resolve to the very same package.
//
// Load with: node --import ../nodehooks.mjs ...
// (paths are relative to the package.json that runs the script)

import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const VIEM_ANCHOR = pathToFileURL(
  "c:/Users/tdat/Desktop/0xnothing/0xNothing-zkLTC-Testnet/apps/web/node_modules/viem/_esm/index.js",
).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "viem" || specifier.startsWith("viem/")) {
      // Re-run default resolution anchored INSIDE the real viem package: the
      // upward node_modules walk from there lands on apps/web/node_modules/viem,
      // whose package.json "exports" then resolves "." and "./accounts" etc.
      return nextResolve(specifier, {
        ...context,
        parentURL: VIEM_ANCHOR,
        // Clear the "conditions" override if any — viem is plain "import".
      });
    }
    return nextResolve(specifier, context);
  },
});
