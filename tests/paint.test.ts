import { test } from "node:test";
import assert from "node:assert/strict";
import { floodRegion } from "../src/paint.ts";
import {
  blendModes,
  blankProject,
  newLayer,
  parseProject,
} from "../src/model.ts";

const rgba = (values: number[]) =>
  new Uint8ClampedArray(values.flatMap((v) => [v, v, v, 255]));
test("bucket fills connected pixels without wrapping across rows", () => {
  const mask = floodRegion(rgba([0, 0, 200, 200, 0, 200]), 3, 2, 2, 0, 0);
  assert.deepEqual([...mask], [0, 0, 255, 0, 0, 255]);
});
test("noncontiguous fill reaches disconnected matching islands", () => {
  assert.deepEqual(
    [...floodRegion(rgba([0, 255, 0]), 3, 1, 0, 0, 0, false)],
    [255, 0, 255],
  );
});
test("tolerance compares to seed rather than leaking through a color ramp", () => {
  assert.deepEqual(
    [...floodRegion(rgba([0, 10, 20, 30]), 4, 1, 0, 0, 15)],
    [255, 255, 0, 0],
  );
});
test("transparent pixels ignore invisible RGB but never match opaque pixels", () => {
  const data = new Uint8ClampedArray([
    255, 0, 0, 0, 0, 255, 0, 0, 0, 0, 0, 255,
  ]);
  assert.deepEqual([...floodRegion(data, 3, 1, 0, 0, 0)], [255, 255, 0]);
});
test("selection forms a barrier to a connected fill", () => {
  const selection = new Uint8ClampedArray([
    0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 255,
  ]);
  assert.deepEqual(
    [...floodRegion(rgba([0, 0, 0]), 3, 1, 0, 0, 0, true, selection)],
    [255, 0, 0],
  );
  assert.deepEqual(
    [...floodRegion(rgba([0, 0, 0]), 3, 1, 1, 0, 0, true, selection)],
    [0, 0, 0],
  );
});
test("large uniform regions fill without recursive stack overflow", () => {
  const mask = floodRegion(
    new Uint8ClampedArray(512 * 512 * 4),
    512,
    512,
    0,
    0,
    0,
  );
  assert.ok(mask.every((v) => v === 255));
  assert.ok(floodRegion(rgba([0]), 1, 1, -1, 0, 0).every((v) => v === 0));
});
test("every supported blend mode survives project save and reload", () => {
  const project = blankProject();
  for (const blendMode of blendModes) {
    const layer = newLayer("text", 0, 0);
    layer.blendMode = blendMode;
    project.layers.push(layer);
  }
  assert.deepEqual(
    parseProject(JSON.stringify(project)).layers.map((l) => l.blendMode),
    [...blendModes],
  );
});
