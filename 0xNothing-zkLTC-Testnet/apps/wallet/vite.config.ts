import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/** Single source of truth for the version the UI shows. */
const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

/**
 * Main bundle: the React app (index.html) plus the MV3 service worker.
 *
 * The service worker is emitted as ESM because MV3 allows
 * `"background": { "type": "module" }`; the dapp-facing content/inpage scripts
 * cannot be ESM, so they are built separately as IIFE by vite.config.inject.ts.
 *
 * No @vitejs/plugin-react on purpose: Vite's built-in JSX transform (Oxc as of
 * Vite 8) covers everything this app needs and keeps the dependency surface of a
 * key-holding wallet as small as possible (cost: no Fast Refresh in `dev`).
 */
export default defineConfig({
  base: "./",
  define: {
    __WALLET_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  // Stated rather than inherited from tsconfig.json: the bundle's JSX runtime is
  // not something to leave to whichever tsconfig the transform happens to find.
  oxc: {
    jsx: { runtime: "automatic", importSource: "react" },
  },
  build: {
    target: "chrome120",
    outDir: "dist",
    emptyOutDir: true,
    assetsInlineLimit: 0,
    sourcemap: false,
    modulePreload: { polyfill: false },
    // The default 500 kB warning is advice about a network cost this bundle does
    // not pay: the popup is read from local disk, and the fix it suggests —
    // dynamic import() — is the one thing the service worker in this same build
    // is not allowed to do. Raised, not disabled, so a real jump still shows.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL("./index.html", import.meta.url)),
        background: fileURLToPath(new URL("./src/extension/background.ts", import.meta.url)),
      },
      output: {
        // The manifest references background.js by name, so it must not be hashed.
        entryFileNames: (chunk) =>
          chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  server: { port: 5183, strictPort: false },
});
