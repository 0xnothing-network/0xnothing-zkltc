/**
 * Grid data parser & exporter for pixel art.
 * Converts pixelData (string[][]) to PNG base64 or JSON for export/sharing.
 */

/** Convert pixelData 2D array to a PNG data URL (base64). */
export function pixelDataToPNG(pixelData: string[][], gridSize: number, outputSize = 512): string {
  if (typeof document === "undefined") return "";
  const canvas = document.createElement("canvas");
  canvas.width = outputSize;
  canvas.height = outputSize;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  const pixelSize = outputSize / gridSize;

  ctx.fillStyle = "#0F0F23";
  ctx.fillRect(0, 0, outputSize, outputSize);

  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      const color = pixelData[y]?.[x];
      if (color && color !== "transparent") {
        ctx.fillStyle = color;
        ctx.fillRect(x * pixelSize, y * pixelSize, pixelSize, pixelSize);
      }
    }
  }

  return canvas.toDataURL("image/png").split(",")[1] ?? "";
}

/** Convert pixelData 2D array to the compact on-chain text format. */
export function pixelDataToOnchainText(pixelData: string[][], gridSize: number): string {
  const lines: string[] = [];
  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      const color = pixelData[y]?.[x];
      if (color && color !== "transparent") {
        lines.push(`[${x},${y}]=${color.toUpperCase()}`);
      }
    }
  }
  return lines.join(" ");
}

/**
 * Pack pixelData into RLE binary form for on-chain storage.
 *
 * Format: rows of runs. Each pixel is a horizontal run of identical color.
 * Each run = 5 bytes: [x(1)] [y(1)] [count(1)] [r,g,b(3)]
 *   - count: number of consecutive pixels (1..64), unsigned
 *   - x: starting x, 0..63
 *   - y: row index, 0..63
 *
 * Worst case (alternating colors per pixel): 64*64 runs * 5B = 20480 bytes
 * (same as previous format).
 * Realistic art: typically 60-90% smaller.
 *
 * Returns "0x" + lowercase hex string, suitable for viem bytes arg.
 */
export function pixelDataToPackedBytes(pixelData: string[][], gridSize: number): `0x${string}` {
  const parts: number[] = [];
  for (let y = 0; y < gridSize; y++) {
    let x = 0;
    while (x < gridSize) {
      const color = pixelData[y]?.[x];
      if (!color || color === "transparent") {
        x++;
        continue;
      }
      const m = /^#?([0-9a-fA-F]{6})$/.exec(color);
      if (!m) {
        x++;
        continue;
      }
      const rgb = parseInt(m[1], 16);
      const r = (rgb >> 16) & 0xff;
      const g = (rgb >> 8) & 0xff;
      const b = rgb & 0xff;
      // Count run length within same row + same color
      let count = 1;
      while (
        x + count < gridSize &&
        pixelData[y]?.[x + count] === color
      ) {
        count++;
        if (count === 64) break;
      }
      parts.push(x & 0xff, y & 0xff, count & 0xff, r, g, b);
      x += count;
    }
  }
  let hex = "0x";
  for (let i = 0; i < parts.length; i++) {
    hex += parts[i].toString(16).padStart(2, "0");
  }
  return hex as `0x${string}`;
}

/** Convert pixelData 2D array to a compact JSON string matching AIPromptGenerator's input format. */
export function pixelDataToJSON(pixelData: string[][], gridSize: number): string {
  return pixelDataToOnchainText(pixelData, gridSize).replaceAll(" ", "\n");
}

type SvgRun = { x: number; y: number; width: number; color: string };

/**
 * Ceiling on the raw on-chain blob this renderer will walk, mirroring the
 * wallet's port of the same function. Valid data cannot reach it: a full 256×256
 * grid is 786 434 packed characters, and ~1.2 MB in the verbose text form.
 */
const MAX_PIXEL_DATA_LENGTH = 2_000_000;

/** Render immutable on-chain pixel data as compact SVG markup. */
export function pixelDataToSVGMarkup(pixelData: string, gridSize: number): string {
  if (
    !pixelData
    || pixelData.length > MAX_PIXEL_DATA_LENGTH
    || !Number.isInteger(gridSize)
    || gridSize <= 0
    || gridSize > 256
  ) return "";

  const runs = /^(0x)?[0-9a-fA-F]+$/.test(pixelData)
    ? packedDataToRuns(pixelData, gridSize)
    : textDataToRuns(pixelData, gridSize);
  if (runs.length === 0) return "";

  const pathsByColor = new Map<string, string[]>();
  for (const run of runs) {
    const segments = pathsByColor.get(run.color) ?? [];
    segments.push(`M${run.x} ${run.y}h${run.width}v1h-${run.width}z`);
    pathsByColor.set(run.color, segments);
  }
  const paths = [...pathsByColor.entries()]
    .map(([color, segments]) => `<path fill="${color}" d="${segments.join("")}"/>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${gridSize}" height="${gridSize}" viewBox="0 0 ${gridSize} ${gridSize}" shape-rendering="crispEdges">${paths}</svg>`;
}

function packedDataToRuns(pixelData: string, gridSize: number): SvgRun[] {
  const clean = pixelData.startsWith("0x") ? pixelData.slice(2) : pixelData;
  if (clean.length === 0 || clean.length % 12 !== 0) return [];
  const runs: SvgRun[] = [];
  for (let index = 0; index < clean.length; index += 12) {
    // One run per cell is already the worst case a grid can hold; anything past
    // that is padding, and walking it only grows the SVG.
    if (runs.length >= gridSize * gridSize) break;
    const x = parseInt(clean.slice(index, index + 2), 16);
    const y = parseInt(clean.slice(index + 2, index + 4), 16);
    const count = parseInt(clean.slice(index + 4, index + 6), 16);
    const color = `#${clean.slice(index + 6, index + 12).toUpperCase()}`;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(count)) continue;
    if (x >= gridSize || y >= gridSize || count <= 0) continue;
    runs.push({ x, y, width: Math.min(count, gridSize - x), color });
  }
  return runs;
}

function textDataToRuns(text: string, gridSize: number): SvgRun[] {
  const rows = Array.from({ length: gridSize }, () => new Map<number, string>());
  const re = /\[(\d+),(\d+)\]\s*=\s*(#[0-9A-Fa-f]{6})/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const x = parseInt(match[1]);
    const y = parseInt(match[2]);
    if (x >= gridSize || y >= gridSize) continue;
    rows[y].set(x, match[3].toUpperCase());
  }

  const runs: SvgRun[] = [];
  for (let y = 0; y < rows.length; y++) {
    const pixels = [...rows[y].entries()].sort((left, right) => left[0] - right[0]);
    for (let index = 0; index < pixels.length;) {
      const [x, color] = pixels[index];
      let width = 1;
      while (
        index + width < pixels.length &&
        pixels[index + width][0] === x + width &&
        pixels[index + width][1] === color
      ) {
        width += 1;
      }
      runs.push({ x, y, width, color });
      index += width;
    }
  }
  return runs;
}

/** Download pixelData as a PNG file. */
export function downloadAsPNG(pixelData: string[][], gridSize: number, filename = "pixel-art.png") {
  const base64 = pixelDataToPNG(pixelData, gridSize);
  if (!base64) return;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: "image/png" });
  downloadAsFileBlob(blob, filename);
}

/** Download pixelData as a compact JSON file. */
export function downloadAsJSON(pixelData: string[][], gridSize: number, filename = "pixel-art.txt") {
  const content = pixelDataToJSON(pixelData, gridSize);
  const blob = new Blob([content], { type: "text/plain" });
  downloadAsFileBlob(blob, filename);
}

function downloadAsFileBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
