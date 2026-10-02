import { test } from "node:test";
import assert from "node:assert/strict";
import { EFFECTS, PRESETS, applyStack, cleanStack, glitchFrames, rhythm, rng } from "../src/glitch.ts";
import type { Pixels } from "../src/pixel-art.ts";

/** A 48×32 test card: a horizontal gradient with a bright square and a transparent corner. */
function card(): Pixels {
  const w = 48,
    h = 32,
    data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const bright = x > 16 && x < 32 && y > 8 && y < 24;
      data[i] = bright ? 250 : x * 5;
      data[i + 1] = bright ? 240 : y * 7;
      data[i + 2] = bright ? 230 : 120;
      data[i + 3] = x < 4 && y < 4 ? 0 : 255;
    }
  return { width: w, height: h, data };
}
const differs = (a: Pixels, b: Pixels) => a.data.some((v, i) => v !== b.data[i]);

test("every effect keeps the size, changes the picture, and leaves the input untouched", () => {
  const src = card();
  const before = new Uint8ClampedArray(src.data);
  for (const e of EFFECTS) {
    const out = e.apply(src, { strength: 0.8, seed: 7, t: 0.25 });
    assert.equal(out.width, src.width, e.id);
    assert.equal(out.data.length, src.data.length, e.id);
    assert.ok(differs(out, src), `${e.id} changed nothing`);
  }
  assert.deepEqual(src.data, before);
});

test("effects are deterministic for a seed and vary with it", () => {
  const src = card();
  for (const id of ["slices", "blocks", "noise", "vhs"]) {
    const a = applyStack(src, [{ id, strength: 0.7 }], 3);
    const b = applyStack(src, [{ id, strength: 0.7 }], 3);
    const c = applyStack(src, [{ id, strength: 0.7 }], 4);
    assert.deepEqual(a.data, b.data, id);
    assert.ok(differs(a, c), `${id} ignores the seed`);
  }
});

test("zero strength and unknown effects are a clean copy", () => {
  const src = card();
  const out = applyStack(src, [{ id: "rgb", strength: 0 }, { id: "nope", strength: 1 }], 1);
  assert.deepEqual(out.data, src.data);
  assert.notEqual(out.data, src.data);
  assert.deepEqual(cleanStack([{ id: "rgb", strength: 4 }, { id: "x", strength: 1 }, null]), [{ id: "rgb", strength: 1 }]);
});

test("pixel sort only reorders pixels within a row", () => {
  const src = card();
  const out = applyStack(src, [{ id: "sort", strength: 1 }], 2);
  for (let y = 0; y < src.height; y++) {
    const row = (p: Pixels) => {
      const v = new Uint32Array(p.data.buffer, p.data.byteOffset, p.width * p.height);
      return [...v.slice(y * p.width, (y + 1) * p.width)].sort();
    };
    assert.deepEqual(row(out), row(src), `row ${y}`);
  }
});

test("presets use real effects; rhythm stays within 0…1", () => {
  for (const p of PRESETS) assert.deepEqual(cleanStack(p.stack), p.stack, p.name);
  for (const kind of ["steady", "bursts", "pulse"] as const)
    for (let f = 0; f < 24; f++) {
      const m = rhythm(kind, f, 24, 9);
      assert.ok(m >= 0 && m <= 1, `${kind} ${f}: ${m}`);
    }
  assert.equal(rhythm("pulse", 0, 12, 1), 0);
  const r = rng(5);
  assert.ok([r(), r(), r()].every((v) => v >= 0 && v < 1));
});

test("glitch animation: frames differ from each other and bursts include calm frames", () => {
  const frames = glitchFrames(card(), PRESETS[0].stack, { frames: 12, rhythm: "bursts", seed: 11 });
  assert.equal(frames.length, 12);
  assert.ok(differs(frames[0], frames[1]) || differs(frames[1], frames[2]));
  const calm = [...Array(12).keys()].filter((f) => rhythm("bursts", f, 12, 11) < 0.2);
  assert.ok(calm.length > 0 && calm.length < 12);
});
