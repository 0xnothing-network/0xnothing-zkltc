import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/**
 * Rasterises the project brand mark into the PNG sizes Chrome and Android need.
 *
 * apps/web/public/0xNothing.jpg stays the single source of brand truth — the
 * wallet keeps no second copy, so a logo change there flows here with one
 * command. (public/icon.svg is the 0xPixel wordmark, not the project mark.)
 *
 * sharp is borrowed from apps/web/node_modules instead of being added as a
 * wallet dependency: it is a build-only need and pulls native binaries.
 * The generated PNGs are committed, so contributors never have to run this.
 */
const walletRoot = fileURLToPath(new URL("..", import.meta.url));
const sourcePath = fileURLToPath(new URL("../../web/public/0xNothing.jpg", import.meta.url));
const outDir = new URL("../public/icons/", import.meta.url);

const SIZES = [16, 32, 48, 128, 192, 512];

async function loadSharp() {
  const candidates = [
    new URL("../../web/node_modules/sharp/dist/index.mjs", import.meta.url),
    new URL("../node_modules/sharp/dist/index.mjs", import.meta.url),
  ];
  for (const candidate of candidates) {
    try {
      const mod = await import(candidate.href);
      return mod.default ?? mod;
    } catch {
      // try the next location
    }
  }
  return null;
}

const sharp = await loadSharp();
if (!sharp) {
  console.error(
    "[wallet] sharp not found. Run `npm install` in apps/web first, " +
      "or keep the committed PNGs in public/icons/.",
  );
  process.exit(1);
}

const source = await readFile(sourcePath);
await mkdir(outDir, { recursive: true });

for (const size of SIZES) {
  const out = fileURLToPath(new URL(`icon-${size}.png`, outDir));
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
      `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="white"/></svg>`,
  );
  await sharp(source)
    .resize(size, size, { fit: "cover", kernel: "lanczos3" })
    .ensureAlpha()
    .composite([{ input: mask, blend: "dest-in" }])
    .png({ compressionLevel: 9, palette: size <= 48 })
    .toFile(out);
  console.log(`[wallet] icons/icon-${size}.png`);
}

console.log(`[wallet] wrote ${SIZES.length} icons from ${sourcePath.replace(walletRoot, "")}`);
