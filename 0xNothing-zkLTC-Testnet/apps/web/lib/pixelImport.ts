export type PixelImportMode = "fit" | "fill";

export interface PixelImportOptions {
  gridSize: number;
  mode?: PixelImportMode;
  colors?: number;
}

export interface PixelImageSource {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function colorDistance(a: [number, number, number], b: [number, number, number]): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

function hexColor(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((value) => clamp(value).toString(16).padStart(2, "0")).join("")}`;
}

export function rgbaToPixelGrid(source: PixelImageSource, options: PixelImportOptions): string[][] {
  const { gridSize, mode = "fit", colors = 32 } = options;
  if (![8, 16, 32, 64, 128, 256].includes(gridSize) && gridSize !== 2 && gridSize !== 4 || !Number.isInteger(source.width) || !Number.isInteger(source.height) || source.width <= 0 || source.height <= 0 || source.width * source.height > 16_777_216 || !Number.isInteger(colors) || colors < 1 || colors > 64) {
    throw new Error("Invalid image dimensions");
  }
  if (source.data.length < source.width * source.height * 4) throw new Error("Invalid image data");

  const scale = mode === "fill"
    ? Math.max(gridSize / source.width, gridSize / source.height)
    : Math.min(gridSize / source.width, gridSize / source.height);
  const drawWidth = source.width * scale;
  const drawHeight = source.height * scale;
  const offsetX = (gridSize - drawWidth) / 2;
  const offsetY = (gridSize - drawHeight) / 2;
  const samples: Array<[number, number, number, number]> = [];

  for (let y = 0; y < gridSize; y += 1) {
    for (let x = 0; x < gridSize; x += 1) {
      const sourceX = Math.floor((x + 0.5 - offsetX) / scale);
      const sourceY = Math.floor((y + 0.5 - offsetY) / scale);
      if (sourceX < 0 || sourceX >= source.width || sourceY < 0 || sourceY >= source.height) {
        samples.push([0, 0, 0, 0]);
        continue;
      }
      const index = (sourceY * source.width + sourceX) * 4;
      samples.push([source.data[index], source.data[index + 1], source.data[index + 2], source.data[index + 3]]);
    }
  }

  const palette: Array<[number, number, number]> = [];
  for (const [r, g, b, a] of samples) {
    if (a < 128) continue;
    const color: [number, number, number] = [r, g, b];
    if (!palette.some((item) => colorDistance(item, color) < 900)) palette.push(color);
    if (palette.length >= Math.max(1, Math.min(64, colors))) break;
  }

  const grid: string[][] = [];
  for (let y = 0; y < gridSize; y += 1) {
    const row: string[] = [];
    for (let x = 0; x < gridSize; x += 1) {
      const [r, g, b, a] = samples[y * gridSize + x];
      if (a < 128 || palette.length === 0) row.push("transparent");
      else {
        const nearest = palette.reduce((best, color) =>
          colorDistance(color, [r, g, b]) < colorDistance(best, [r, g, b]) ? color : best,
        palette[0]);
        row.push(hexColor(nearest[0], nearest[1], nearest[2]));
      }
    }
    grid.push(row);
  }
  return grid;
}

export async function importImageFile(file: File, options: PixelImportOptions): Promise<string[][]> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("Choose a PNG, JPEG, or WebP image");
  if (file.size > 10 * 1024 * 1024) throw new Error("Choose an image smaller than 10 MB");
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
  if (bitmap.width * bitmap.height > 16_777_216) throw new Error("Choose an image below 16 megapixels");
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Image decoder is unavailable");
  context.drawImage(bitmap, 0, 0);
  const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
  return rgbaToPixelGrid(image, options);
  } finally {
    bitmap.close();
  }
}
