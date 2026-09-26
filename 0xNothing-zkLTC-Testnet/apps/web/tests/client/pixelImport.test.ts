import assert from "node:assert/strict";
import test from "node:test";
import { rgbaToPixelGrid } from "../../lib/pixelImport.ts";

test("imports a fit image with transparent padding", () => {
  const data = new Uint8ClampedArray([
    255, 0, 0, 255, 255, 0, 0, 255,
  ]);
  const grid = rgbaToPixelGrid({ data, width: 2, height: 1 }, { gridSize: 4 });
  assert.equal(grid.length, 4);
  assert.equal(grid[0][0], "transparent");
  assert.equal(grid[1][1], "#ff0000");
  assert.equal(grid[2][2], "#ff0000");
});

test("fill mode crops the shorter dimension", () => {
  const data = new Uint8ClampedArray([
    255, 0, 0, 255, 0, 255, 0, 255,
  ]);
  const grid = rgbaToPixelGrid({ data, width: 2, height: 1 }, { gridSize: 2, mode: "fill" });
  assert.deepEqual(grid, [["#ff0000", "#00ff00"], ["#ff0000", "#00ff00"]]);
});
