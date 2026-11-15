import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import config, { entryChunkOrder, entryChunkScripts } from "../../vite.config.ts";

/**
 * O6: Chrome 1234 refuses modulepreload links on extension pages ("cross-world
 * extension resource mismatch"), so the built page lists the entry's chunks as
 * module scripts instead, in the order ES modules evaluate them.
 */
type Bundle = Parameters<typeof entryChunkOrder>[0];
const chunk = (fileName: string, imports: string[]) => ({ type: "chunk", fileName, imports });
const bundle = (...chunks: ReturnType<typeof chunk>[]): Bundle =>
  Object.fromEntries(chunks.map((c) => [c.fileName, c])) as unknown as Bundle;

test("the entry's chunks come in evaluation order: dependencies first, in import order, each once", () => {
  const graph = bundle(
    chunk("assets/index.js", ["assets/a.js", "assets/b.js"]),
    chunk("assets/a.js", ["assets/c.js", "assets/b.js"]),
    chunk("assets/b.js", ["assets/c.js"]),
    chunk("assets/c.js", []),
    chunk("assets/lazy.js", ["assets/c.js"]),
  );
  // index -> a -> c, b; then index's own b is already done. The lazy chunk (a
  // dynamic import) never appears.
  assert.deepEqual(entryChunkOrder(graph, "assets/index.js"), ["assets/c.js", "assets/b.js", "assets/a.js"]);
  assert.deepEqual(entryChunkOrder(graph, "assets/c.js"), []);
  assert.deepEqual(entryChunkOrder(bundle(), "assets/missing.js"), []);
});

test("a cycle in the entry's static graph fails the build instead of reordering modules", () => {
  // Each module script is its own evaluation root: b.js tagged ahead would run
  // index.js before itself, the reverse of the entry's order.
  const toEntry = bundle(
    chunk("assets/index.js", ["assets/a.js"]),
    chunk("assets/a.js", ["assets/b.js"]),
    chunk("assets/b.js", ["assets/index.js"]),
  );
  assert.throws(() => entryChunkOrder(toEntry, "assets/index.js"), /cycle \(assets\/b\.js -> assets\/index\.js\)/u);
  const between = bundle(
    chunk("assets/index.js", ["assets/a.js"]),
    chunk("assets/a.js", ["assets/b.js"]),
    chunk("assets/b.js", ["assets/c.js"]),
    chunk("assets/c.js", ["assets/a.js"]),
  );
  assert.throws(() => entryChunkOrder(between, "assets/index.js"), /cycle \(assets\/c\.js -> assets\/a\.js\)/u);
  // A diamond (two paths to one chunk) is not a cycle.
  const diamond = bundle(
    chunk("assets/index.js", ["assets/a.js", "assets/b.js"]),
    chunk("assets/a.js", ["assets/c.js"]),
    chunk("assets/b.js", ["assets/c.js"]),
    chunk("assets/c.js", []),
  );
  assert.deepEqual(entryChunkOrder(diamond, "assets/index.js"), ["assets/c.js", "assets/a.js", "assets/b.js"]);
});

test("the built page gets the module scripts ahead of the entry and fails the build without its entry tag", () => {
  const plugin = entryChunkScripts();
  const hook = plugin.transformIndexHtml as { order: string; handler: (html: string, ctx: unknown) => string };
  assert.equal(plugin.apply, "build");
  assert.equal(hook.order, "post");
  const graph = bundle(chunk("assets/index-1.js", ["assets/r-2.js", "assets/w-3.js"]), chunk("assets/w-3.js", ["assets/r-2.js"]), chunk("assets/r-2.js", []));
  const entry = `<script type="module" crossorigin src="./assets/index-1.js"></script>`;
  const html = `<head>\n    ${entry}\n    <link rel="stylesheet" href="./assets/index.css">\n</head>`;
  const out = hook.handler(html, { chunk: graph["assets/index-1.js"], bundle: graph });
  assert.equal(
    out,
    `<head>\n    <script type="module" crossorigin src="./assets/r-2.js"></script>\n    `
      + `<script type="module" crossorigin src="./assets/w-3.js"></script>\n    ${entry}\n    <link rel="stylesheet" href="./assets/index.css">\n</head>`,
  );
  assert.doesNotMatch(out, /modulepreload/u);
  assert.throws(() => hook.handler("<head></head>", { chunk: graph["assets/index-1.js"], bundle: graph }), /lost its entry tag/u);
  // Dev server pages (no bundle) pass through untouched.
  assert.equal(hook.handler(html, {}), html);
});

test("modulepreload stays off for the page only; lazy screens keep their preloads", () => {
  const preload = config.build?.modulePreload;
  assert.ok(preload && typeof preload === "object");
  assert.equal(preload.polyfill, false);
  const resolve = preload.resolveDependencies!;
  assert.deepEqual(resolve("index.html", ["assets/a.js"], { hostId: "index.html", hostType: "html" }), []);
  assert.deepEqual(resolve("assets/Send.js", ["assets/a.js"], { hostId: "assets/index.js", hostType: "js" }), ["assets/a.js"]);
  assert.ok(config.plugins?.some((p) => p && typeof p === "object" && "name" in p && p.name === "wallet-entry-chunk-scripts"));
  const source = readFileSync(new URL("../../vite.config.ts", import.meta.url), "utf8");
  assert.match(source, /hostType === "html" \? \[\] : deps/u);
});
