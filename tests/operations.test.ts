import { test } from "node:test";
import assert from "node:assert/strict";
import {
  alignLayers,
  reorderLayers,
  duplicateLayers,
} from "../src/operations.ts";
import { blankProject, newLayer, parseProject } from "../src/model.ts";
test("alignment uses the full selection bounds while locked layers stay fixed", () => {
  const p = blankProject();
  const a = newLayer("note", -100, 50),
    b = newLayer("note", 500, 200);
  b.locked = true;
  p.layers = [a, b];
  alignLayers(p, new Set([a.id, b.id]), "right");
  assert.equal(a.x, 500);
  assert.equal(b.x, 500);
  alignLayers(p, new Set([a.id, b.id]), "top");
  assert.equal(b.y, 200);
  assert.equal(a.y, 50);
});
test("moving a multi-selection forward preserves internal order", () => {
  const p = blankProject();
  p.layers = ["A", "B", "C", "D"].map((name) => ({
    ...newLayer("note", 0, 0),
    name,
  }));
  const ids = new Set([p.layers[0].id, p.layers[1].id]);
  reorderLayers(p, ids, 1);
  assert.deepEqual(
    p.layers.map((l) => l.name),
    ["C", "A", "B", "D"],
  );
  reorderLayers(p, ids, -1);
  assert.deepEqual(
    p.layers.map((l) => l.name),
    ["A", "B", "C", "D"],
  );
});
test("duplicate keeps shared image assets and remaps mask targets within copied selection", () => {
  const p = blankProject(),
    a = newLayer("image", 0, 0),
    m = newLayer("mask", 0, 0);
  a.assetId = "a";
  m.mask = { targetLayerId: a.id, strokes: [] };
  p.layers = [a, m];
  const copies = duplicateLayers(p, new Set([a.id, m.id]));
  assert.equal(copies[0].assetId, "a");
  assert.notEqual(copies[0].id, a.id);
  assert.equal(copies[1].mask?.targetLayerId, copies[0].id);
  assert.equal(copies[0].x, 30);
});
test("appearance survives project import and old projects get defaults", () => {
  const p = blankProject();
  const l = newLayer("note", 0, 0);
  l.opacity = 0.35;
  l.blendMode = "multiply";
  l.noteColor = "rose";
  p.layers = [l];
  const q = parseProject(JSON.stringify(p));
  assert.equal(q.layers[0].opacity, 0.35);
  assert.equal(q.layers[0].blendMode, "multiply");
  assert.equal(q.layers[0].noteColor, "rose");
  delete l.opacity;
  assert.equal(parseProject(JSON.stringify(p)).layers[0].opacity, 1);
  l.opacity = 3;
  assert.throws(() => parseProject(JSON.stringify(p)));
});
