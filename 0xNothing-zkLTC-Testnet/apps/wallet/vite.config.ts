import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin, type Rollup } from "vite";

/** Single source of truth for the version the UI shows. */
const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

/**
 * The entry's static chunks in the order ES modules evaluate them: depth first,
 * each chunk after the chunks it imports, in import order. That order holds only
 * while the graph has no cycle: each module script is its own evaluation root,
 * so modules in a cycle could run in another order than through the entry. A
 * cycle fails the build instead of shipping silently.
 */
export function entryChunkOrder(bundle: Rollup.OutputBundle, entry: string): string[] {
  const order: string[] = [];
  const seen = new Set([entry]);
  /** The chunks on the current path from the entry: an import of one is a back edge. */
  const path = new Set([entry]);
  const visit = (file: string): void => {
    const chunk = bundle[file];
    if (chunk?.type !== "chunk") return;
    for (const next of chunk.imports) {
      if (path.has(next)) {
        throw new Error(`[wallet] the entry's chunks import each other in a cycle (${file} -> ${next})`);
      }
      if (seen.has(next)) continue;
      seen.add(next);
      path.add(next);
      visit(next);
      path.delete(next);
      order.push(next);
    }
  };
  visit(entry);
  return order;
}

/**
 * Replaces the modulepreload links (switched off below) with one module script
 * per chunk of the entry's static graph, ahead of the entry. The page then asks
 * for every chunk at once, as the preloads did, so an older Chrome or Android
 * WebView does not wait for the entry to parse before it fetches the rest
 * (measured: removing the links alone cost ~9 ms of first paint on Chromium
 * 1194). The tags follow the evaluation order above, so every module still runs
 * once and in the same order as when the entry imported it.
 */
export function entryChunkScripts(): Plugin {
  return {
    name: "wallet-entry-chunk-scripts",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html, { chunk, bundle }) {
        if (!chunk || !bundle) return html;
        const entryTag = `<script type="module" crossorigin src="./${chunk.fileName}"></script>`;
        if (!html.includes(entryTag)) throw new Error(`[wallet] index.html lost its entry tag ${entryTag}`);
        const tags = entryChunkOrder(bundle, chunk.fileName)
          .map((file) => `<script type="module" crossorigin src="./${file}"></script>\n    `)
          .join("");
        return html.replace(entryTag, tags + entryTag);
      },
    },
  };
}

/**
 * Main bundle: the React app (index.html) plus the MV3 service worker.
 *
 * The service worker is emitted as ESM because MV3 allows
 * `"background": { "type": "module" }`; the dapp-facing content/inpage scripts
 * cannot be ESM, so they are built separately as IIFE by scripts/build-inject.mjs.
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
    // The CSS minifier drops the -webkit- prefixes its target does not need, and
    // at chrome120 that includes the -webkit-mask the chevrons declare: Android
    // System WebView below 120 then paints them as solid squares. The JS target
    // stays chrome120; only the stylesheet keeps what older WebViews still need.
    cssTarget: "chrome105",
    outDir: "dist",
    emptyOutDir: true,
    assetsInlineLimit: 0,
    sourcemap: false,
    // No modulepreload links in index.html: Chrome refuses them on an extension
    // page since build 1234 ("cross-world extension resource mismatch"), logs
    // two warnings per chunk and reads every chunk a second time. The entry's
    // chunks are listed as module scripts instead (entryChunkScripts). The
    // preloads Vite adds before a lazy screen's import() stay.
    modulePreload: {
      polyfill: false,
      resolveDependencies: (_file, deps, { hostType }) => (hostType === "html" ? [] : deps),
    },
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
  plugins: [entryChunkScripts()],
  server: { port: 5183, strictPort: false },
});
