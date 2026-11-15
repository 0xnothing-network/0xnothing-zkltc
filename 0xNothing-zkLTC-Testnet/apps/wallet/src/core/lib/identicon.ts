/**
 * A small picture drawn from an address, so two addresses that share their
 * first and last characters still look different at a glance. Every value is
 * drawn from a mix of all 40 digits: digits read directly would give a look-alike
 * the colour of the very characters it copies, and leave the rest unread. No
 * dependency, no randomness, the same picture on every surface.
 *
 * Injection safety: nothing from the input reaches the markup except numbers
 * computed from validated hex digits, so the result can be used as an image
 * source without further escaping. Import-free so tests load it directly.
 */
const ADDRESS = /^0x[0-9a-f]{40}$/u;
const GRID = 5;
/** Columns 0..2; 3 and 4 mirror 1 and 0. */
const FREE_COLUMNS = 3;

/** FNV-1a over the text, then murmur3's finalizer so every input bit reaches every output bit. */
function mix(text: string, seed: number): number {
  let hash = (0x811c9dc5 ^ seed) >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

export function identiconSvg(address: string): string {
  if (typeof address !== "string") return "";
  const hex = address.toLowerCase();
  if (!ADDRESS.test(hex)) return "";
  // Two differently seeded passes: 64 bits, of which colour and grid use 28.
  const colour = mix(hex, 0x9e3779b9);
  const grid = mix(hex, 0x7f4a7c15);

  const hue = colour % 360;
  const saturation = 55 + ((colour >>> 16) % 16);
  const back = (hue + 180) % 360;

  const on: boolean[] = [];
  for (let cell = 0; cell < GRID * FREE_COLUMNS; cell += 1) on.push(((grid >>> cell) & 1) === 1);
  // A tile with no cell on would read as an empty box: draw the centre column.
  if (!on.includes(true)) {
    for (let row = 0; row < GRID; row += 1) on[row * FREE_COLUMNS + 2] = true;
  }

  const cells: string[] = [];
  for (let row = 0; row < GRID; row += 1) {
    for (let column = 0; column < FREE_COLUMNS; column += 1) {
      if (!on[row * FREE_COLUMNS + column]) continue;
      cells.push(`M${column} ${row}h1v1h-1z`);
      const mirror = GRID - 1 - column;
      if (mirror !== column) cells.push(`M${mirror} ${row}h1v1h-1z`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 7 7" shape-rendering="crispEdges">`
    + `<rect x="-1" y="-1" width="7" height="7" fill="hsl(${back},25%,20%)"/>`
    + `<path fill="hsl(${hue},${saturation}%,60%)" d="${cells.join("")}"/></svg>`;
}

/** For <img src>; "" for an invalid address so the caller can fall back. */
export function identiconDataUrl(address: string): string {
  const markup = identiconSvg(address);
  return markup ? `data:image/svg+xml,${encodeURIComponent(markup)}` : "";
}
