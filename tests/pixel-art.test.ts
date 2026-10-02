import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyPalette,
  buildPalette,
  countColors,
  detectBlockSize,
  hardAlpha,
  makePixels,
  outline,
  pixelArt,
  pixelate,
  snapGrid,
  targetSize,
  type Pixels,
} from "../src/pixel-art.ts";

function fill(img: Pixels, x0: number, y0: number, x1: number, y1: number, rgba: number[]) {
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) img.data.set(rgba, (y * img.width + x) * 4);
}
const at = (img: Pixels, x: number, y: number) => Array.from(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

test("target size keeps aspect", () => {
  assert.deepEqual(targetSize(1024, 512, 64), { width: 64, height: 32 });
  assert.deepEqual(targetSize(10, 10, 64), { width: 10, height: 10 });
});

test("pixelate averages flat cells and keeps thin dark lines", () => {
  const img = makePixels(32, 32);
  fill(img, 0, 0, 32, 32, [240, 240, 240, 255]);
  fill(img, 15, 0, 16, 32, [10, 10, 10, 255]); // 1-px dark vertical line
  const out = pixelate(img, 4, 4);
  assert.deepEqual(at(out, 0, 0), [240, 240, 240, 255]);
  assert.deepEqual(at(out, 1, 2), [10, 10, 10, 255]); // cell containing the line stays dark
});

test("pixelate decides transparency by majority", () => {
  const img = makePixels(8, 8);
  fill(img, 0, 0, 8, 8, [0, 0, 0, 0]);
  fill(img, 0, 0, 4, 8, [200, 0, 0, 255]);
  const out = pixelate(img, 2, 1);
  assert.equal(at(out, 0, 0)[3], 255);
  assert.equal(at(out, 1, 0)[3], 0);
});

test("detects and snaps off-grid blocks", () => {
  // 12×12 logical pixels drawn as 6-px blocks with anti-aliased seams.
  const block = 6,
    logical = 12;
  const img = makePixels(block * logical, block * logical);
  for (let y = 0; y < logical; y++)
    for (let x = 0; x < logical; x++) {
      const c = (x + y) % 3 === 0 ? [220, 40, 40, 255] : (x * y) % 2 ? [30, 60, 200, 255] : [250, 220, 90, 255];
      fill(img, x * block, y * block, (x + 1) * block, (y + 1) * block, c);
      fill(img, x * block, y * block, x * block + 1, (y + 1) * block, [128, 128, 128, 255]); // seam
    }
  assert.equal(detectBlockSize(img), 6);
  const snapped = snapGrid(img, 6);
  assert.equal(snapped.width, 12);
  assert.deepEqual(at(snapped, 0, 0), [220, 40, 40, 255]);
  assert.deepEqual(at(snapped, 1, 1), [30, 60, 200, 255]);
  assert.ok(countColors(snapped) <= 3);
});

test("palette is deterministic, limited and uses real colours", () => {
  const img = makePixels(64, 1);
  for (let x = 0; x < 64; x++) img.data.set([x * 4, 255 - x * 4, 128, 255], x * 4);
  const a = buildPalette([img], 4),
    b = buildPalette([img], 4);
  assert.deepEqual(a, b);
  assert.equal(a.length, 4);
  const mapped = applyPalette(img, a);
  assert.ok(countColors(mapped) <= 4);
  for (const c of a) assert.ok(c[0] % 4 === 0 && c[2] === 128);
});

test("dithering and hard alpha", () => {
  const img = makePixels(8, 8);
  fill(img, 0, 0, 8, 8, [128, 128, 128, 100]);
  assert.equal(at(hardAlpha(img), 0, 0)[3], 0);
  fill(img, 0, 0, 8, 8, [128, 128, 128, 255]);
  const dithered = applyPalette(img, [[0, 0, 0], [255, 255, 255]], 1);
  assert.equal(countColors(dithered), 2); // mid grey becomes a black/white pattern
});

test("outline wraps opaque shapes only in transparent pixels", () => {
  const img = makePixels(5, 5);
  fill(img, 2, 2, 3, 3, [200, 100, 50, 255]);
  const out = outline(img, [0, 0, 0]);
  assert.deepEqual(at(out, 2, 1), [0, 0, 0, 255]);
  assert.deepEqual(at(out, 2, 2), [200, 100, 50, 255]);
  assert.equal(at(out, 0, 0)[3], 0);
});

test("full pipeline with a shared palette", () => {
  const img = makePixels(64, 64);
  fill(img, 0, 0, 64, 64, [0, 0, 0, 0]);
  fill(img, 16, 16, 48, 48, [90, 160, 70, 255]);
  const palette: [number, number, number][] = [[90, 160, 70], [20, 20, 20]];
  const result = pixelArt(img, { method: "resize", targetWidth: 16, blockSize: 0, colors: 8, dither: 0, outline: "auto", palette });
  assert.equal(result.pixels.width, 16);
  assert.equal(at(result.pixels, 0, 0)[3], 0);
  assert.equal(at(result.pixels, 8, 8)[3], 255);
  assert.ok(countColors(result.pixels) <= 3);
  assert.deepEqual(result.palette, palette);
});
