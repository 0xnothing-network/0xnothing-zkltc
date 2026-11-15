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

/**
 * Android launcher icons and splash images. Each file replaces the same-named
 * PNG of Capacitor's generated shell at the same pixel size, so no XML resource
 * changes: scripts/configure-android.ts copies native/android/res over android/.
 */
const androidRes = new URL("../native/android/res/", import.meta.url);
const ANDROID_BG = "#0b0c0e"; // --bg of the dark theme, as capacitor.config.ts
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
const SPLASHES = {
  drawable: [480, 320],
  "drawable-land-mdpi": [480, 320],
  "drawable-land-hdpi": [800, 480],
  "drawable-land-xhdpi": [1280, 720],
  "drawable-land-xxhdpi": [1600, 960],
  "drawable-land-xxxhdpi": [1920, 1280],
  "drawable-port-mdpi": [320, 480],
  "drawable-port-hdpi": [480, 800],
  "drawable-port-xhdpi": [720, 1280],
  "drawable-port-xxhdpi": [960, 1600],
  "drawable-port-xxxhdpi": [1280, 1920],
};

async function writeAndroid(dir, name, image) {
  const folder = new URL(`${dir}/`, androidRes);
  await mkdir(folder, { recursive: true });
  await image.png({ compressionLevel: 9 }).toFile(fileURLToPath(new URL(name, folder)));
  console.log(`[wallet] native/android/res/${dir}/${name}`);
}

function masked(size, shape) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">${shape}</svg>`,
  );
}

for (const [density, scale] of Object.entries(DENSITIES)) {
  const dir = `mipmap-${density}`;
  const legacy = Math.round(48 * scale);
  const radius = Math.round(legacy * 0.18);
  await writeAndroid(dir, "ic_launcher.png", sharp(source)
    .resize(legacy, legacy, { fit: "cover", kernel: "lanczos3" })
    .ensureAlpha()
    .composite([{ input: masked(legacy, `<rect width="${legacy}" height="${legacy}" rx="${radius}" fill="white"/>`), blend: "dest-in" }]));
  await writeAndroid(dir, "ic_launcher_round.png", sharp(source)
    .resize(legacy, legacy, { fit: "cover", kernel: "lanczos3" })
    .ensureAlpha()
    .composite([{ input: masked(legacy, `<circle cx="${legacy / 2}" cy="${legacy / 2}" r="${legacy / 2}" fill="white"/>`), blend: "dest-in" }]));
  // Adaptive foreground: 108dp, opaque, so the scaffold's white background layer
  // never shows. Unscaled, the N and its red dot stay inside the 66dp safe-zone
  // circle that every launcher mask keeps (a 1.2x zoom already pushes the dot out).
  const layer = Math.round(108 * scale);
  await writeAndroid(dir, "ic_launcher_foreground.png", sharp(source)
    .resize(layer, layer, { fit: "cover", kernel: "lanczos3" }));
}

// Splash: the mark on the wallet's dark background. "lighten" drops the logo's
// black field into ANDROID_BG and keeps the white N and the red dot.
for (const [dir, [width, height]] of Object.entries(SPLASHES)) {
  const mark = Math.round(Math.min(width, height) * 0.6);
  const logo = await sharp(source).resize(mark, mark, { fit: "cover", kernel: "lanczos3" }).toBuffer();
  await writeAndroid(dir, "splash.png", sharp({
    create: { width, height, channels: 3, background: ANDROID_BG },
  }).composite([{ input: logo, blend: "lighten" }]));
}
