import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blankProject,
  newLayer,
  parseProject,
  bounds,
  History,
} from "../src/model.ts";
import {
  layerBounds,
  resizeFromCorner,
  normalizeAngle,
} from "../src/geometry.ts";
import { alignLayers } from "../src/operations.ts";
import { wrapText } from "../src/typography.ts";

test("rotated layer bounds include every corner without rounding a quarter turn", () => {
  const l = {
    ...newLayer("image", 10, 20),
    width: 200,
    height: 100,
    rotation: 90,
  };
  assert.deepEqual(layerBounds(l), { x: 60, y: -30, width: 100, height: 200 });
  assert.deepEqual(bounds([l]), layerBounds(l));
  l.rotation = 45;
  assert.ok(Math.abs(layerBounds(l).width - 300 / Math.sqrt(2)) < 1e-8);
  assert.equal(normalizeAngle(450), 90);
});
test("rotated resize keeps its opposite corner fixed and limits dimensions", () => {
  const l = {
    ...newLayer("image", 10, 20),
    width: 200,
    height: 100,
    rotation: 90,
  };
  const resized = resizeFromCorner(l, -100, 200);
  assert.deepEqual(resized, { x: -140, y: 70, width: 400, height: 200 });
  // Top-left at 90 degrees is center + (h/2,-w/2).
  assert.equal(
    resized.x + resized.width / 2 + resized.height / 2,
    l.x + l.width / 2 + l.height / 2,
  );
  assert.equal(
    resized.y + resized.height / 2 - resized.width / 2,
    l.y + l.height / 2 - l.width / 2,
  );
  assert.ok(resizeFromCorner(l, -1e6, 1e6).width <= 32768);
});
test("alignment compares rotated visible bounds while locked layers stay fixed", () => {
  const p = blankProject(),
    a = { ...newLayer("text", 0, 0), width: 200, height: 100, rotation: 90 },
    b = { ...newLayer("image", 400, 0), width: 100, height: 100, locked: true };
  p.layers = [a, b];
  alignLayers(p, new Set([a.id, b.id]), "right");
  const box = layerBounds(a);
  assert.equal(box.x + box.width, 500);
  assert.equal(b.x, 400);
});
test("editable text and transforms survive save, reopen, duplicate-safe snapshots and undo", () => {
  const p = blankProject(),
    l = newLayer("text", 30, 40);
  p.layers = [l];
  l.text = "Hello\nworld";
  l.rotation = 32;
  l.flipX = true;
  l.textStyle = {
    ...l.textStyle!,
    fontFamily: "Georgia",
    fontSize: 88,
    color: "#ff8800",
    bold: true,
    align: "center",
  };
  const restored = parseProject(JSON.stringify(p));
  assert.equal(restored.layers[0].kind, "text");
  assert.deepEqual(restored.layers[0].textStyle, l.textStyle);
  assert.equal(restored.layers[0].rotation, 32);
  assert.equal(restored.layers[0].flipX, true);
  const h = new History();
  h.push(p);
  l.text = "Changed";
  assert.equal(h.undo(p)?.layers[0].text, "Hello\nworld");
  l.textStyle!.fontSize = Infinity;
  assert.throws(() => parseProject(JSON.stringify(p)));
});
test("text wrapping preserves blank lines and splits words wider than the box", () => {
  const measure = (s: string) => s.length * 10;
  assert.deepEqual(wrapText("hello world\n\nx", 55, measure), [
    "hello",
    "world",
    "",
    "x",
  ]);
  assert.deepEqual(wrapText("abcdef", 30, measure), ["abc", "def"]);
});
