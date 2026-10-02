import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adjustRGB,
  colorMatrix,
  filterMarkup,
  isActive,
  isNeutral,
  neutralAdjustments,
  parseAdjustments,
  type Adjustments,
} from "../src/adjustments.ts";
import { brushProfile, isSoft } from "../src/image-editing.ts";
import { isRefined } from "../src/masking.ts";
import { blankProject, newLayer, parseProject, History } from "../src/model.ts";
import { duplicateLayers } from "../src/operations.ts";

const adj = (a: Partial<Adjustments>): Adjustments => ({
  ...neutralAdjustments,
  ...a,
});

test("neutral or hidden adjustments leave colours and filters untouched", () => {
  assert.deepEqual(adjustRGB([12, 130, 250], adj({})), [12, 130, 250]);
  assert.deepEqual(
    adjustRGB([12, 130, 250], adj({ brightness: 50, enabled: false })),
    [12, 130, 250],
  );
  assert.equal(filterMarkup(adj({})), "");
  assert.ok(isNeutral(adj({})) && !isActive(adj({})));
  assert.ok(!isActive(adj({ hue: 30, enabled: false })));
  assert.ok(isActive(adj({ hue: 30 })));
});

test("adjustments behave like their artist-facing names", () => {
  assert.deepEqual(
    adjustRGB([100, 100, 100], adj({ brightness: 50 })),
    [150, 150, 150],
  );
  assert.deepEqual(
    adjustRGB([200, 100, 50], adj({ brightness: -100 })),
    [0, 0, 0],
  );
  const [r, g, b] = adjustRGB([224, 64, 48], adj({ saturation: -100 }));
  assert.ok(r === g && g === b, "full desaturation is grey");
  assert.deepEqual(
    adjustRGB([200, 60, 128], adj({ contrast: -100 })),
    [128, 128, 128],
  );
  const warm = adjustRGB([128, 128, 128], adj({ warmth: 100 }));
  assert.ok(warm[0] > 128 && warm[2] < 128 && warm[1] === 128);
  const magenta = adjustRGB([128, 128, 128], adj({ tint: 100 }));
  assert.ok(magenta[1] < 128 && magenta[0] === 128);
  // Levels: black and white points stretch the range; midtones lighten above 1.
  const levels = adjustRGB([50, 200, 125], adj({ black: 50, white: 200 }));
  assert.deepEqual(levels.slice(0, 2), [0, 255]);
  assert.ok(Math.abs(levels[2] - 127.5) <= 1);
  assert.equal(adjustRGB([128, 128, 128], adj({ gamma: 2 }))[0], 181);
  assert.ok(adjustRGB([128, 128, 128], adj({ gamma: 0.5 }))[0] < 128);
});

test("one composed matrix equals applying each adjustment in order", () => {
  const a = adj({
    brightness: 20,
    contrast: 30,
    saturation: -25,
    hue: 40,
    warmth: 10,
  });
  const { m, o } = colorMatrix(a);
  const apply = (v: number[], mm: number[], oo: number[]) =>
    [0, 1, 2].map(
      (r) =>
        mm[r * 3] * v[0] + mm[r * 3 + 1] * v[1] + mm[r * 3 + 2] * v[2] + oo[r],
    );
  let step = [0.3, 0.5, 0.7];
  for (const single of [
    { brightness: 20 },
    { contrast: 30 },
    { saturation: -25 },
    { hue: 40 },
    { warmth: 10 },
  ]) {
    const s = colorMatrix(adj(single));
    step = apply(step, s.m, s.o);
  }
  apply([0.3, 0.5, 0.7], m, o).forEach((v, i) =>
    assert.ok(Math.abs(v - step[i]) < 1e-9),
  );
});

test("warmth still tints a fully desaturated image", () => {
  const [r, g, b] = adjustRGB(
    [224, 64, 48],
    adj({ saturation: -100, warmth: 60 }),
  );
  assert.ok(r > g && g > b);
});

test("filter markup contains only numeric SVG primitives", () => {
  const markup = filterMarkup(adj({ hue: 15, black: 20, gamma: 1.4 }));
  assert.match(markup, /^<feComponentTransfer>/);
  assert.match(markup, /type="gamma"/);
  assert.match(markup, /<feColorMatrix type="matrix" values="[-0-9. ]+"\/>$/);
  assert.doesNotMatch(filterMarkup(adj({ black: 20 })), /gamma|feColorMatrix/);
});

test("adjustment import is strict and fills defaults for partial data", () => {
  assert.deepEqual(parseAdjustments({ hue: 12 }), adj({ hue: 12 }));
  assert.equal(parseAdjustments({ enabled: false, hue: 1 }).enabled, false);
  for (const bad of [
    null,
    { hue: 400 },
    { brightness: "10" },
    { contrast: NaN },
    { gamma: 0 },
    { black: 200, white: 202 },
  ])
    assert.throws(() => parseAdjustments(bad), /Invalid image adjustments/);
});

function imageProject() {
  const p = blankProject(),
    l = newLayer("image", 0, 0);
  p.assets.a = {
    id: "a",
    width: 64,
    height: 64,
    data: "data:image/png;base64,AAAA",
  };
  p.assets.m = {
    id: "m",
    width: 64,
    height: 64,
    data: "data:image/png;base64,BBBB",
  };
  l.assetId = "a";
  p.layers.push(l);
  return p;
}

test("adjustments and mask refinements survive save, reopen, duplicate and undo", () => {
  const p = imageProject(),
    l = p.layers[0],
    history = new History();
  history.push(p);
  l.adjustments = adj({ saturation: -40, warmth: 25, gamma: 1.3 });
  l.layerMask = { assetId: "m", enabled: true, feather: 12, density: 0.75 };
  const reopened = parseProject(JSON.stringify(p));
  assert.deepEqual(reopened.layers[0].adjustments, l.adjustments);
  assert.deepEqual(reopened.layers[0].layerMask, l.layerMask);
  assert.equal(reopened.layers[0].assetId, "a", "pixels are untouched");
  const [copy] = duplicateLayers(p, new Set([l.id]));
  copy.adjustments!.hue = 90;
  copy.layerMask!.feather = 3;
  assert.equal(l.adjustments.hue, 0);
  assert.equal(l.layerMask.feather, 12);
  const undone = history.undo(p)!;
  assert.equal(undone.layers[0].adjustments, undefined);
  assert.equal(undone.layers[0].layerMask, undefined);
  assert.deepEqual(history.redo(undone)!.layers[0].adjustments, l.adjustments);
});

test("older version-2 files without the new fields still open unchanged", () => {
  const p = imageProject();
  p.layers[0].layerMask = { assetId: "m", enabled: false };
  const reopened = parseProject(JSON.stringify(p));
  assert.equal(reopened.layers[0].adjustments, undefined);
  assert.deepEqual(reopened.layers[0].layerMask, {
    assetId: "m",
    enabled: false,
  });
  assert.ok(!isRefined(reopened.layers[0].layerMask));
});

test("invalid refinements and adjustments on non-images are rejected", () => {
  const p = imageProject();
  p.layers[0].layerMask = { assetId: "m", enabled: true, feather: 9999 };
  assert.throws(() => parseProject(JSON.stringify(p)));
  p.layers[0].layerMask = { assetId: "m", enabled: true, density: -0.1 };
  assert.throws(() => parseProject(JSON.stringify(p)));
  const q = blankProject(),
    text = newLayer("text", 0, 0);
  (text as any).adjustments = { hue: 10 };
  q.layers.push(text);
  assert.throws(
    () => parseProject(JSON.stringify(q)),
    /Invalid image adjustments/,
  );
});

test("brush hardness maps to a solid core plus falloff within the brush size", () => {
  assert.deepEqual(brushProfile(40, 1), { core: 40, sigma: 0 });
  assert.deepEqual(brushProfile(40, 0), { core: 20, sigma: 5 });
  const mid = brushProfile(40, 0.5);
  assert.equal(mid.core, 30);
  // Core edge + two standard deviations reaches the brush radius.
  assert.equal(mid.core / 2 + mid.sigma * 2, 20);
  assert.ok(!isSoft({ x: 0, y: 0, width: 5, height: 5 }));
  assert.ok(isSoft({ x: 0, y: 0, width: 5, height: 5, feather: 2 }));
  assert.ok(isRefined({ feather: 1 }) && isRefined({ density: 0.5 }));
});
