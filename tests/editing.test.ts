import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampRect,
  validatePixelSize,
  polygonSelection,
} from "../src/image-editing.ts";
import { duplicateLayers } from "../src/operations.ts";
import { nativeExportScale } from "../src/export.ts";
import { generationDimensions } from "../src/resolution.ts";
import { blankProject, newLayer, parseProject, History } from "../src/model.ts";

test("crop selection supports reversed drags and clamps to image pixels", () => {
  assert.deepEqual(clampRect({ x: 700, y: 50 }, { x: -20, y: 10 }, 512, 256), {
    x: 0,
    y: 10,
    width: 512,
    height: 40,
  });
  assert.deepEqual(clampRect({ x: 10, y: 10 }, { x: 10, y: 10 }, 512, 256), {
    x: 10,
    y: 10,
    width: 0,
    height: 0,
  });
});
test("pixel resize enforces finite integer sizes and memory limits", () => {
  validatePixelSize(2048, 2048);
  for (const [w, h] of [
    [0, 32],
    [32, NaN],
    [32.5, 64],
    [8192, 8192],
    [20000, 16],
  ])
    assert.throws(() => validatePixelSize(w, h));
});
test("2K framing stays within engine bounds and 32-pixel alignment", () => {
  assert.deepEqual(generationDimensions(2048, 1024, 1024), {
    width: 2048,
    height: 2048,
  });
  assert.deepEqual(generationDimensions(2048, 1344, 768), {
    width: 2048,
    height: 1184,
  });
  assert.deepEqual(generationDimensions(1536, 768, 1344), {
    width: 864,
    height: 1536,
  });
});
function fixture() {
  const p = blankProject(),
    l = newLayer("image", 0, 0);
  p.assets.original = {
    id: "original",
    width: 2048,
    height: 1024,
    data: "data:image/png;base64,AAAA",
  };
  p.assets.edited = {
    id: "edited",
    width: 1024,
    height: 512,
    data: "data:image/png;base64,BBBB",
  };
  l.assetId = "original";
  l.width = 560;
  l.height = 280;
  p.layers.push(l);
  return p;
}
test("full-resolution export recovers native pixels of previously reduced canvas layers", () => {
  const p = fixture();
  assert.equal(nativeExportScale(p), 2048 / 560);
  assert.equal(Math.ceil(p.layers[0].width * nativeExportScale(p)), 2048);
  p.layers[0].visible = false;
  assert.equal(nativeExportScale(p), 1);
});
test("reference order and preserved originals survive saving and project undo", () => {
  const p = fixture(),
    history = new History();
  p.references = ["edited", "original"];
  history.push(p);
  p.layers[0].assetId = "edited";
  p.layers[0].originalAssetId = "original";
  const loaded = parseProject(JSON.stringify(p));
  assert.deepEqual(loaded.references, ["edited", "original"]);
  assert.equal(loaded.layers[0].originalAssetId, "original");
  assert.equal(history.undo(p)?.layers[0].assetId, "original");
  const old = JSON.parse(JSON.stringify(p));
  delete old.references;
  assert.deepEqual(parseProject(JSON.stringify(old)).references, []);
  p.references = ["missing"];
  assert.throws(() => parseProject(JSON.stringify(p)), /Missing reference/);
  p.references = ["original", "original"];
  assert.throws(() => parseProject(JSON.stringify(p)), /distinct/);
});

test("mask state survives project saves, duplication and undo without changing source pixels", () => {
  const p = fixture(),
    history = new History();
  const l = p.layers[0];
  l.layerMask = { assetId: "edited", enabled: true };
  const loaded = parseProject(JSON.stringify(p));
  assert.deepEqual(loaded.layers[0].layerMask, l.layerMask);
  history.push(p);
  l.layerMask.enabled = false;
  assert.equal(history.undo(p)?.layers[0].layerMask?.enabled, true);
  assert.equal(l.assetId, "original");
  duplicateLayers(p, new Set([l.id]));
  p.layers[1].layerMask!.enabled = true;
  assert.equal(l.layerMask.enabled, false);
  l.layerMask.assetId = "missing";
  assert.throws(() => parseProject(JSON.stringify(p)), /Missing layer mask/);
  l.layerMask.assetId = "edited";
  l.kind = "note";
  assert.throws(() => parseProject(JSON.stringify(p)), /Invalid layer mask/);
});

test("lasso bounds enclose fractional points and keep a stable snapshot", () => {
  const points: [number, number][] = [
    [10.5, 20.3],
    [100.2, 21],
    [40, 80.8],
  ];
  const selection = polygonSelection(points);
  assert.deepEqual(
    [selection.x, selection.y, selection.width, selection.height],
    [10, 20, 91, 61],
  );
  points[0][0] = 500;
  assert.equal(selection.points![0][0], 10.5);
});

test("engine uploads measure decoded bytes and detect transparency", async () => {
  const { dataUrlBytes, hasTransparency } =
    await import("../src/background.ts");
  assert.equal(dataUrlBytes("data:image/png;base64,AAAA"), 3);
  assert.equal(dataUrlBytes("data:image/png;base64,AAA="), 2);
  assert.equal(
    hasTransparency(new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255])),
    false,
  );
  assert.equal(
    hasTransparency(new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 254])),
    true,
  );
});
