/** Canonical V2 binary runs: x, y, width minus one, red, green, blue. */
export function pixelDataToV2PackedBytes(pixelData: string[][], gridSize: number): `0x${string}` {
  if (![8, 16, 32, 64, 128, 256].includes(gridSize) || pixelData.length !== gridSize) {
    throw new Error("Invalid pixel grid size");
  }
  const bytes: number[] = [];
  for (let y = 0; y < gridSize; y++) {
    const row = pixelData[y];
    if (row.length !== gridSize) throw new Error("Invalid pixel grid row");
    for (let x = 0; x < gridSize;) {
      const color = row[x];
      if (color === "transparent") { x++; continue; }
      const match = /^#([0-9a-f]{6})$/i.exec(color);
      if (!match) throw new Error("Invalid pixel color");
      const rgb = Number.parseInt(match[1], 16);
      let width = 1;
      while (x + width < gridSize && row[x + width].toLowerCase() === color.toLowerCase()) width++;
      bytes.push(x, y, width - 1, rgb >> 16, (rgb >> 8) & 255, rgb & 255);
      if (bytes.length > 4096 * 6) throw new Error("Artwork has more than 4,096 color runs. Reduce detail or colors before minting.");
      x += width;
    }
  }
  return `0x${bytes.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

/** Bound complete undo snapshots by cell count as well as count. */
export function pixelHistoryLimit(gridSize: number): number {
  return Math.max(1, Math.min(50, Math.floor(262_144 / (gridSize * gridSize))));
}

/** Keep large grids usable even when the viewport is narrower than the grid. */
export function pixelCellSize(containerSize: number, gridSize: number): number {
  const size = Math.max(1, containerSize) / gridSize;
  return size < 1 ? size : Math.floor(size);
}
