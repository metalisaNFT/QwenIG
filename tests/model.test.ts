import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blankProject,
  newLayer,
  parseProject,
  History,
  visible,
  locked,
  validateSettings,
  bounds,
} from "../src/model.ts";

test("portable project round-trip preserves assets, view, groups, metadata and masks", () => {
  const p = blankProject();
  const l = newLayer("image", -280, 650);
  l.assetId = "asset";
  l.groupId = "group";
  p.assets.asset = {
    id: "asset",
    width: 1,
    height: 1,
    data: "data:image/png;base64,AAAA",
  };
  l.metadata = {
    ...p.settings,
    prompt: "an idea",
    seed: 82,
    model: "qwen",
    jobId: "job",
    createdAt: "2026-09-22",
    runner: "sd.cpp",
    runnerRevision: "abc",
  };
  p.groups.push({ id: "group", name: "Studies", visible: true, locked: false });
  p.layers.push(l);
  const m = newLayer("mask", 0, 0);
  m.mask = {
    targetLayerId: l.id,
    strokes: [
      {
        points: [
          [0, 1],
          [2, 3],
        ],
        radius: 12,
        erase: false,
      },
    ],
  };
  p.layers.push(m);
  p.gallery.push({ id: "job", assetId: "asset", metadata: l.metadata });
  p.view = { x: -20, y: 52, zoom: 0.4, grid: false };
  const loaded = parseProject(JSON.stringify(p));
  assert.equal(loaded.layers[0].metadata?.seed, 82);
  assert.equal(loaded.assets.asset.data, p.assets.asset.data);
  assert.deepEqual(loaded.view, p.view);
  assert.deepEqual(loaded.layers[1].mask, m.mask);
  assert.equal(loaded.gallery.length, 1);
});
test("reject remote assets, duplicate IDs, invalid numeric settings and missing images", () => {
  const p = blankProject(),
    l = newLayer("image", 0, 0);
  l.assetId = "a";
  p.layers.push(l);
  assert.throws(() => parseProject(JSON.stringify(p)), /Missing/);
  p.assets.a = {
    id: "a",
    data: "https://tracker.example/a.png",
    width: 1,
    height: 1,
  };
  assert.throws(() => parseProject(JSON.stringify(p)), /embedded/);
  p.assets.a.data = "data:image/png;base64,AAAA";
  p.layers.push({ ...l });
  assert.throws(() => parseProject(JSON.stringify(p)), /Duplicate/);
  assert.throws(
    () => validateSettings({ ...p.settings, prompt: "hi", width: 513 }),
    /multiples/,
  );
  assert.throws(
    () => validateSettings({ ...p.settings, prompt: "hi", seed: NaN }),
    /Seed/,
  );
});
test("undo and redo restore pre-change snapshots without duplicated layers", () => {
  const p = blankProject(),
    h = new History();
  h.push(p);
  p.layers.push(newLayer("note", 20, 30));
  const before = h.undo(p)!;
  assert.equal(before.layers.length, 0);
  const after = h.redo(before)!;
  assert.equal(after.layers.length, 1);
  h.push(after);
  after.layers[0].x = 90;
  assert.equal(h.undo(after)!.layers[0].x, 20);
  assert.equal(p.layers[0].x, 20);
});
test("groups propagate visibility and locking; bounds support negative coordinates", () => {
  const p = blankProject(),
    l = newLayer("note", -40, -60);
  p.layers.push(l);
  p.groups.push({ id: "g", name: "Group", visible: false, locked: true });
  l.groupId = "g";
  assert.equal(visible(p, l), false);
  assert.equal(locked(p, l), true);
  assert.deepEqual(bounds(p.layers), {
    x: -40,
    y: -60,
    width: 260,
    height: 180,
  });
});

import { History as UndoHistory, blankProject as fresh, snapshot } from "../src/model.ts";
test("history snapshots share immutable assets and videos but not structure", () => {
  const p = fresh();
  p.assets.a = { id: "a", data: "data:image/png;base64,AAAA", width: 1, height: 1 };
  p.videos.v = { id: "v", data: "data:video/mp4;base64,AAAA", width: 1, height: 1, duration: 1, fps: 24 };
  p.layers.push({ id: "l", kind: "image", name: "x", x: 0, y: 0, width: 16, height: 16, visible: true, locked: false, groupId: null, assetId: "a" });
  const s = snapshot(p);
  assert.equal(s.assets.a, p.assets.a);
  assert.equal(s.videos.v, p.videos.v);
  assert.notEqual(s.layers[0], p.layers[0]);
  const h = new UndoHistory();
  h.push(p);
  p.layers[0].x = 99;
  delete p.videos.v;
  const back = h.undo(p)!;
  assert.equal(back.layers[0].x, 0);
  assert.ok(back.videos.v);
  assert.equal(h.redo(back)!.layers[0].x, 99);
});
