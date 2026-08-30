/**
 * Renders on-chain pixel data as SVG markup, ported from
 * apps/web/lib/gridParser.ts (`pixelDataToSVGMarkup` and its two parsers).
 *
 * The wallet has no Next.js route handler behind it, so /api/pixel-image is not
 * available — NFT previews are produced entirely on the client from the same
 * `tokenData.pixelData` string the site reads.
 *
 * Injection safety: every value interpolated into the markup is constrained
 * numerically or by a strict hex pattern before it is used, so the output can be
 * mounted with dangerouslySetInnerHTML without sanitising chain input again.
 */
interface SvgRun {
  x: number;
  y: number;
  width: number;
  color: string;
}

const HEX_ONLY = /^(0x)?[0-9a-fA-F]+$/u;
const TEXT_PIXEL = /\[(\d+),(\d+)\]\s*=\s*(#[0-9A-Fa-f]{6})/gu;
const MAX_PIXEL_DATA_LENGTH = 2_000_000;

export function pixelDataToSvgMarkup(pixelData: string, gridSize: number): string {
  if (
    !pixelData
    || pixelData.length > MAX_PIXEL_DATA_LENGTH
    || !Number.isInteger(gridSize)
    || gridSize <= 0
    || gridSize > 256
  ) return "";

  const runs = HEX_ONLY.test(pixelData)
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
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 ${gridSize} ${gridSize}" shape-rendering="crispEdges">${paths}</svg>`;
}

/** For <img src>; avoids base64 so the string stays inspectable. */
export function pixelDataToSvgDataUrl(pixelData: string, gridSize: number): string {
  const markup = pixelDataToSvgMarkup(pixelData, gridSize);
  if (!markup) return "";
  return `data:image/svg+xml,${encodeURIComponent(markup)}`;
}

/** Packed RLE: 12 hex chars per run = x(2) y(2) count(2) rrggbb(6). */
function packedDataToRuns(pixelData: string, gridSize: number): SvgRun[] {
  const clean = pixelData.startsWith("0x") ? pixelData.slice(2) : pixelData;
  if (clean.length === 0 || clean.length % 12 !== 0) return [];
  const runs: SvgRun[] = [];
  for (let index = 0; index < clean.length; index += 12) {
    if (runs.length >= gridSize * gridSize) break;
    const x = Number.parseInt(clean.slice(index, index + 2), 16);
    const y = Number.parseInt(clean.slice(index + 2, index + 4), 16);
    const count = Number.parseInt(clean.slice(index + 4, index + 6), 16);
    const color = `#${clean.slice(index + 6, index + 12).toUpperCase()}`;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(count)) continue;
    if (x >= gridSize || y >= gridSize || count <= 0) continue;
    runs.push({ x, y, width: Math.min(count, gridSize - x), color });
  }
  return runs;
}

/** Text form: `[x,y]=#RRGGBB` pairs, coalesced into horizontal runs. */
function textDataToRuns(text: string, gridSize: number): SvgRun[] {
  const rows = Array.from({ length: gridSize }, () => new Map<number, string>());
  TEXT_PIXEL.lastIndex = 0;
  let match = TEXT_PIXEL.exec(text);
  while (match !== null) {
    const x = Number.parseInt(match[1] ?? "", 10);
    const y = Number.parseInt(match[2] ?? "", 10);
    const color = match[3];
    if (color && x < gridSize && y < gridSize) rows[y]?.set(x, color.toUpperCase());
    match = TEXT_PIXEL.exec(text);
  }

  const runs: SvgRun[] = [];
  for (let y = 0; y < rows.length; y += 1) {
    const pixels = [...(rows[y]?.entries() ?? [])].sort((left, right) => left[0] - right[0]);
    for (let index = 0; index < pixels.length; ) {
      const entry = pixels[index]!;
      const [x, color] = entry;
      let width = 1;
      while (
        index + width < pixels.length &&
        pixels[index + width]![0] === x + width &&
        pixels[index + width]![1] === color
      ) {
        width += 1;
      }
      runs.push({ x, y, width, color });
      index += width;
    }
  }
  return runs;
}
