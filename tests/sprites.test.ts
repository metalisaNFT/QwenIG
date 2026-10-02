import { test } from "node:test";
import assert from "node:assert/strict";
import { alphaBounds, fileStem, frameDurations, sheetJSON, sheetLayout, unionBox } from "../src/sprites.ts";
import { frameTimes } from "../src/video.ts";
import { editFrame, outpaintPlan, placeOutpaint, markedFraction } from "../src/ai-edit.ts";
import { makePixels } from "../src/pixel-art.ts";

test("alpha bounds and union crop", () => {
  const p = makePixels(10, 10);
  p.data[(3 * 10 + 4) * 4 + 3] = 255;
  p.data[(6 * 10 + 7) * 4 + 3] = 255;
  assert.deepEqual(alphaBounds(p), { x: 4, y: 3, width: 4, height: 4 });
  assert.equal(alphaBounds(makePixels(4, 4)), null);
  assert.deepEqual(unionBox([{ x: 2, y: 2, width: 2, height: 2 }, null, { x: 5, y: 1, width: 1, height: 1 }], 1, { width: 8, height: 8 }), {
    x: 1, y: 0, width: 6, height: 5,
  });
});

test("sheet layout centres frames on a shared cell, feet on the floor", () => {
  const layout = sheetLayout([{ width: 10, height: 20 }, { width: 6, height: 12 }, { width: 10, height: 20 }], 2, 1);
  assert.deepEqual(layout.cell, { width: 10, height: 20 });
  assert.equal(layout.columns, 2);
  assert.equal(layout.rows, 2);
  assert.equal(layout.width, 1 + 2 * 11);
  assert.equal(layout.height, 1 + 2 * 21);
  assert.deepEqual(layout.frames[1], { x: 11 + 1 + 2, y: 1 + 8, width: 6, height: 12 });
  assert.deepEqual(layout.cells[2], { x: 1, y: 22, width: 10, height: 20 });
  assert.throws(() => sheetLayout([]));
});

test("sheet JSON is Aseprite-style", () => {
  const layout = sheetLayout([{ width: 8, height: 8 }, { width: 8, height: 8 }]);
  const json = sheetJSON("walk", "walk.png", layout, frameDurations([{}, { duration: 250 }], 10));
  assert.equal(json.frames.length, 2);
  assert.deepEqual(json.frames[1].frame, { x: 8, y: 0, w: 8, h: 8 });
  assert.equal(json.frames[0].duration, 100);
  assert.equal(json.frames[1].duration, 250);
  assert.deepEqual(json.meta.size, { w: 16, h: 8 });
  assert.equal(json.meta.frameTags[0].to, 1);
  assert.equal(fileStem(" Hero / walk!! "), "Hero-walk");
});

test("video frame times are evenly spaced", () => {
  assert.deepEqual(frameTimes(4, 4), [0.5, 1.5, 2.5, 3.5]);
  assert.deepEqual(frameTimes(4, 2, 1, 3), [1.5, 2.5]);
  assert.ok(frameTimes(1, 1)[0] < 1);
});

test("AI edit frames and outpaint placement", () => {
  assert.deepEqual(editFrame(3000, 2000, 1024), { width: 1024, height: 672 });
  const plan = outpaintPlan(100, 50, { left: 0.5, right: 0.5, top: 0, bottom: 0 });
  assert.deepEqual(plan, { width: 200, height: 50, offsetX: 50, offsetY: 0 });
  // Layer shows the 100×50 asset at 2× on the canvas.
  const placed = placeOutpaint({ x: 0, y: 0, width: 200, height: 100, rotation: 0 }, { width: 100, height: 50 }, plan);
  assert.deepEqual(placed, { x: -100, y: 0, width: 400, height: 100 });
  const onlyRight = outpaintPlan(100, 50, { left: 0, right: 1, top: 0, bottom: 0 });
  const flipped = placeOutpaint({ x: 0, y: 0, width: 100, height: 50, flipX: true }, { width: 100, height: 50 }, onlyRight);
  assert.deepEqual(flipped, { x: -100, y: 0, width: 200, height: 50 }); // mirrored layer grows to the left
  const rotated = placeOutpaint({ x: 0, y: 0, width: 100, height: 50, rotation: 180 }, { width: 100, height: 50 }, onlyRight);
  assert.ok(Math.abs(rotated.x + 100) < 1e-9 && Math.abs(rotated.y) < 1e-9);
  const mask = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]);
  assert.equal(markedFraction(mask), 0.5);
});
