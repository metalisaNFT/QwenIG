/**
 * Glitch effects and filters on raw RGBA pixels. Every effect is pure and seeded, so the same
 * settings always give the same picture (previews match results, animations are repeatable).
 *
 *   strength  0…1   how strong the effect is (0 = untouched)
 *   seed      int   picks the random slices, blocks, grain…
 *   t         0…1   animation phase, so waves roll and tracking bands travel over a loop
 *
 * Effects run in the order of a stack; glitchFrames() turns one image into a looping animation.
 */
import type { Pixels } from "./pixel-art.ts";

export interface EffectInput {
  strength: number;
  seed: number;
  t: number;
}
export interface EffectDef {
  id: string;
  label: string;
  hint: string;
  apply(src: Pixels, input: EffectInput): Pixels;
}
export interface StackItem {
  id: string;
  strength: number;
}
export type Rhythm = "steady" | "bursts" | "pulse";

/** mulberry32: small, fast, good enough for visual randomness. */
export function rng(seed: number) {
  let a = seed >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clone = (p: Pixels): Pixels => ({ width: p.width, height: p.height, data: new Uint8ClampedArray(p.data) });
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const lum = (d: Uint8ClampedArray, i: number) => (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
const wrap = (v: number, n: number) => ((v % n) + n) % n;

function rgbSplit(src: Pixels, { strength, seed, t }: EffectInput): Pixels {
  const { width: w, height: h, data: s } = src;
  const r = rng(seed);
  const angle = r() * Math.PI * 2;
  const amount = Math.max(1, strength * Math.max(w, h) * 0.022) * (0.75 + 0.25 * Math.sin(2 * Math.PI * t));
  const dx = Math.round(Math.cos(angle) * amount),
    dy = Math.round(Math.sin(angle) * amount * 0.35);
  const out = clone(src),
    d = out.data;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const ri = (clamp(y + dy, 0, h - 1) * w + clamp(x + dx, 0, w - 1)) * 4;
      const bi = (clamp(y - dy, 0, h - 1) * w + clamp(x - dx, 0, w - 1)) * 4;
      d[i] = s[ri];
      d[i + 2] = s[bi + 2];
      d[i + 3] = Math.max(s[i + 3], s[ri + 3], s[bi + 3]);
    }
  return out;
}

function sliceShift(src: Pixels, { strength, seed }: EffectInput): Pixels {
  const { width: w, height: h, data: s } = src;
  const r = rng(seed);
  const out = clone(src),
    d = out.data;
  const slices = 3 + Math.round(strength * 14);
  for (let n = 0; n < slices; n++) {
    const y0 = Math.floor(r() * h);
    const band = 1 + Math.floor(r() * (2 + h * 0.07 * strength));
    const shift = Math.round((r() * 2 - 1) * w * 0.16 * strength);
    if (!shift) continue;
    for (let y = y0; y < Math.min(h, y0 + band); y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4,
          j = (y * w + wrap(x - shift, w)) * 4;
        d[i] = s[j];
        d[i + 1] = s[j + 1];
        d[i + 2] = s[j + 2];
        d[i + 3] = s[j + 3];
      }
  }
  return out;
}

function blocks(src: Pixels, { strength, seed }: EffectInput): Pixels {
  const { width: w, height: h, data: s } = src;
  const r = rng(seed);
  const out = clone(src),
    d = out.data;
  const count = 3 + Math.round(strength * 36);
  const perms = [[0, 1, 2], [2, 1, 0], [1, 2, 0], [0, 2, 1], [2, 0, 1]];
  for (let n = 0; n < count; n++) {
    const bw = 2 + Math.floor(r() * w * (0.04 + 0.18 * strength)),
      bh = 2 + Math.floor(r() * h * (0.02 + 0.08 * strength));
    const sx = Math.floor(r() * w),
      sy = Math.floor(r() * h),
      tx = clamp(sx + Math.round((r() * 2 - 1) * w * 0.2), 0, w - 1),
      ty = clamp(sy + Math.round((r() * 2 - 1) * h * 0.05), 0, h - 1);
    const p = r() < 0.5 ? perms[0] : perms[1 + Math.floor(r() * 4)];
    for (let y = 0; y < bh && ty + y < h; y++)
      for (let x = 0; x < bw && tx + x < w; x++) {
        const j = (wrap(sy + y, h) * w + wrap(sx + x, w)) * 4,
          i = ((ty + y) * w + tx + x) * 4;
        d[i] = s[j + p[0]];
        d[i + 1] = s[j + p[1]];
        d[i + 2] = s[j + p[2]];
        d[i + 3] = s[j + 3];
      }
  }
  return out;
}

function pixelSort(src: Pixels, { strength, seed }: EffectInput): Pixels {
  const { width: w, height: h } = src;
  const out = clone(src),
    d = out.data;
  const view = new Uint32Array(d.buffer, d.byteOffset, w * h);
  // Brighter than `low` joins a run; more strength = lower threshold = longer streaks.
  const low = 0.92 - 0.72 * strength;
  const r = rng(seed);
  const run: number[] = [],
    keys: number[] = [];
  const flush = (y: number, end: number) => {
    if (run.length > 1) {
      const order = run.map((_, k) => k).sort((a, b) => keys[a] - keys[b]);
      const sorted = order.map((k) => run[k]);
      for (let k = 0; k < sorted.length; k++) view[y * w + end - sorted.length + k] = sorted[k];
    }
    run.length = 0;
    keys.length = 0;
  };
  for (let y = 0; y < h; y++) {
    if (r() > 0.35 + 0.65 * strength) continue; // weaker settings leave some rows alone
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (d[i + 3] >= 128 && lum(d, i) >= low) {
        run.push(view[y * w + x]);
        keys.push(lum(d, i));
      } else flush(y, x);
    }
    flush(y, w);
  }
  return out;
}

function scanlines(src: Pixels, { strength, t }: EffectInput): Pixels {
  const { width: w, height: h } = src;
  const out = clone(src),
    d = out.data;
  const spacing = Math.max(2, Math.round(Math.min(w, h) / 240) + 1);
  const roll = Math.floor(t * spacing * 4);
  const dark = 1 - 0.65 * strength;
  for (let y = 0; y < h; y++) {
    if ((y + roll) % spacing) continue;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      d[i] *= dark;
      d[i + 1] *= dark;
      d[i + 2] *= dark;
    }
  }
  return out;
}

function noise(src: Pixels, { strength, seed }: EffectInput): Pixels {
  const out = clone(src),
    d = out.data;
  const r = rng(seed);
  const amount = 90 * strength;
  for (let i = 0; i < d.length; i += 4) {
    const n = (r() + r() - 1) * amount;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  return out;
}

function vhs(src: Pixels, { strength, seed, t }: EffectInput): Pixels {
  const { width: w, height: h, data: s } = src;
  const r = rng(seed);
  const out = clone(src),
    d = out.data;
  // Colour bleeds sideways: chroma is shifted and smeared, brightness stays sharp.
  const shift = Math.max(1, Math.round(w * 0.012 * strength + 1));
  const smear = Math.max(1, Math.round(w * 0.01 * strength + 1));
  const row = new Float32Array(w * 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const j = (y * w + clamp(x - shift, 0, w - 1)) * 4;
      const Y = 0.299 * s[j] + 0.587 * s[j + 1] + 0.114 * s[j + 2];
      row[x * 2] = s[j + 2] - Y; // U
      row[x * 2 + 1] = s[j] - Y; // V
    }
    let su = 0,
      sv = 0;
    for (let x = 0; x < w + smear; x++) {
      if (x < w) (su += row[x * 2]), (sv += row[x * 2 + 1]);
      if (x - smear >= 0) (su -= row[(x - smear) * 2]), (sv -= row[(x - smear) * 2 + 1]);
      const at = x - Math.floor(smear / 2);
      if (at < 0 || at >= w) continue;
      const i = (y * w + at) * 4;
      const n = Math.min(x + 1, smear);
      const U = (su / n) * (1 - 0.25 * strength),
        V = (sv / n) * (1 - 0.25 * strength);
      const Y = 0.299 * s[i] + 0.587 * s[i + 1] + 0.114 * s[i + 2];
      d[i] = Y + V;
      d[i + 2] = Y + U;
      d[i + 1] = (Y - 0.299 * d[i] - 0.114 * d[i + 2]) / 0.587;
    }
  }
  // A tracking band rolls down the frame over the loop.
  const band = Math.max(2, Math.round(h * (0.03 + 0.07 * strength)));
  const top = Math.floor((r() + t) * h) % h;
  for (let y = top; y < Math.min(h, top + band); y++) {
    const off = Math.round((r() * 2 - 1) * w * 0.05 * strength);
    const lift = 20 + 60 * strength * r();
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4,
        j = (y * w + wrap(x - off, w)) * 4;
      const n = (r() - 0.5) * 120 * strength;
      d[i] = s[j] + lift + n;
      d[i + 1] = s[j + 1] + lift + n;
      d[i + 2] = s[j + 2] + lift + n;
      d[i + 3] = s[j + 3];
    }
  }
  return out;
}

function wave(src: Pixels, { strength, seed, t }: EffectInput): Pixels {
  const { width: w, height: h, data: s } = src;
  const out = clone(src),
    d = out.data;
  const amp = strength * w * 0.035;
  const length = h / (1.5 + (seed % 3));
  for (let y = 0; y < h; y++) {
    const off = Math.round(amp * Math.sin((2 * Math.PI * y) / length + 2 * Math.PI * t));
    if (!off) continue;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4,
        j = (y * w + clamp(x - off, 0, w - 1)) * 4;
      d[i] = s[j];
      d[i + 1] = s[j + 1];
      d[i + 2] = s[j + 2];
      d[i + 3] = s[j + 3];
    }
  }
  return out;
}

function crt(src: Pixels, { strength, t }: EffectInput): Pixels {
  const { width: w, height: h } = src;
  const out = scanlines(src, { strength: strength * 0.8, seed: 0, t }),
    d = out.data;
  const mask = 0.35 * strength;
  const cx = w / 2,
    cy = h / 2,
    far = Math.hypot(cx, cy);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const c = x % 3; // phosphor stripes: each column favours one channel
      for (let k = 0; k < 3; k++) d[i + k] *= k === c ? 1 + mask * 0.5 : 1 - mask * 0.5;
      const v = 1 - strength * 0.55 * Math.pow(Math.hypot(x - cx, y - cy) / far, 2.2);
      d[i] *= v;
      d[i + 1] *= v;
      d[i + 2] *= v;
    }
  return out;
}

function posterize(src: Pixels, { strength }: EffectInput): Pixels {
  const out = clone(src),
    d = out.data;
  const levels = Math.max(2, Math.round(2 + (1 - strength) * 10));
  const step = 255 / (levels - 1);
  for (let i = 0; i < d.length; i += 4)
    for (let k = 0; k < 3; k++) d[i + k] = Math.round(d[i + k] / step) * step;
  return out;
}

function channelSwap(src: Pixels, { strength, seed }: EffectInput): Pixels {
  const out = clone(src),
    d = out.data,
    s = src.data;
  const perms = [[2, 1, 0], [1, 2, 0], [2, 0, 1], [0, 2, 1], [1, 0, 2]];
  const p = perms[Math.floor(rng(seed)() * perms.length)];
  for (let i = 0; i < d.length; i += 4)
    for (let k = 0; k < 3; k++) d[i + k] = s[i + k] + (s[i + p[k]] - s[i + k]) * strength;
  return out;
}

const PAPER = [244, 240, 230];
function halftone(src: Pixels, { strength }: EffectInput): Pixels {
  const { width: w, height: h, data: s } = src;
  const out = clone(src),
    d = out.data;
  const cell = Math.max(3, Math.round((Math.min(w, h) / 120) * (1 + 2.5 * strength)));
  for (let cy = 0; cy < h; cy += cell)
    for (let cx = 0; cx < w; cx += cell) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0,
        n = 0;
      for (let y = cy; y < Math.min(h, cy + cell); y++)
        for (let x = cx; x < Math.min(w, cx + cell); x++) {
          const i = (y * w + x) * 4;
          r += s[i];
          g += s[i + 1];
          b += s[i + 2];
          a += s[i + 3];
          n++;
        }
      (r /= n), (g /= n), (b /= n), (a /= n);
      const dark = 1 - (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      const radius = (cell / 2) * Math.sqrt(dark) * 1.25 + 0.3;
      const mx = cx + cell / 2,
        my = cy + cell / 2;
      const ink = [r * 0.55, g * 0.55, b * 0.55];
      const mix = 0.35 + 0.65 * strength; // low strength keeps more of the photo
      for (let y = cy; y < Math.min(h, cy + cell); y++)
        for (let x = cx; x < Math.min(w, cx + cell); x++) {
          const i = (y * w + x) * 4;
          const inside = Math.hypot(x + 0.5 - mx, y + 0.5 - my) <= radius;
          for (let k = 0; k < 3; k++) {
            const tone = inside ? ink[k] : PAPER[k];
            d[i + k] = s[i + k] + (tone - s[i + k]) * mix;
          }
          d[i + 3] = a;
        }
    }
  return out;
}

function vignette(src: Pixels, { strength }: EffectInput): Pixels {
  const { width: w, height: h } = src;
  const out = clone(src),
    d = out.data;
  const cx = w / 2,
    cy = h / 2,
    far = Math.hypot(cx, cy);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = 1 - strength * 0.85 * Math.pow(Math.hypot(x - cx, y - cy) / far, 2);
      d[i] *= v;
      d[i + 1] *= v;
      d[i + 2] *= v;
    }
  return out;
}

export const EFFECTS: EffectDef[] = [
  { id: "rgb", label: "RGB split", hint: "Red and blue drift apart", apply: rgbSplit },
  { id: "slices", label: "Slice shift", hint: "Horizontal bands jump sideways", apply: sliceShift },
  { id: "blocks", label: "Block glitch", hint: "Corrupted blocks with swapped colours", apply: blocks },
  { id: "sort", label: "Pixel sort", hint: "Bright runs melt into streaks", apply: pixelSort },
  { id: "vhs", label: "VHS", hint: "Colour bleed and a rolling tracking band", apply: vhs },
  { id: "wave", label: "Wave", hint: "Rows ripple; it rolls when animated", apply: wave },
  { id: "scan", label: "Scanlines", hint: "Dark lines like an old screen", apply: scanlines },
  { id: "crt", label: "CRT", hint: "Phosphor stripes, scanlines and vignette", apply: crt },
  { id: "noise", label: "Noise", hint: "Film grain", apply: noise },
  { id: "swap", label: "Channel swap", hint: "Colours trade places", apply: channelSwap },
  { id: "posterize", label: "Posterize", hint: "Fewer tones per channel", apply: posterize },
  { id: "halftone", label: "Halftone", hint: "Printed dot screen", apply: halftone },
  { id: "vignette", label: "Vignette", hint: "Darker edges", apply: vignette },
];
const byId = new Map(EFFECTS.map((e) => [e.id, e]));

export const PRESETS: { name: string; stack: StackItem[] }[] = [
  { name: "Classic glitch", stack: [{ id: "rgb", strength: 0.5 }, { id: "slices", strength: 0.5 }, { id: "noise", strength: 0.15 }] },
  { name: "VHS tape", stack: [{ id: "vhs", strength: 0.6 }, { id: "scan", strength: 0.35 }, { id: "noise", strength: 0.2 }] },
  { name: "Datamosh", stack: [{ id: "blocks", strength: 0.6 }, { id: "sort", strength: 0.35 }, { id: "rgb", strength: 0.3 }] },
  { name: "CRT monitor", stack: [{ id: "crt", strength: 0.6 }, { id: "wave", strength: 0.12 }] },
  { name: "Melt", stack: [{ id: "sort", strength: 0.7 }, { id: "wave", strength: 0.25 }] },
  { name: "Print", stack: [{ id: "halftone", strength: 0.55 }, { id: "vignette", strength: 0.3 }] },
];

/** Keep only known effects with strengths in 0…1 (stacks come from the UI and saved settings). */
export function cleanStack(stack: unknown): StackItem[] {
  if (!Array.isArray(stack)) return [];
  return stack
    .filter((s) => s && byId.has(s.id))
    .slice(0, 12)
    .map((s) => ({ id: String(s.id), strength: clamp(Number(s.strength) || 0, 0, 1) }));
}

/** Run a stack of effects. `scale` multiplies every strength (animation rhythm). */
export function applyStack(src: Pixels, stack: StackItem[], seed: number, t = 0, scale = 1): Pixels {
  let out = src;
  stack.forEach((item, k) => {
    const strength = clamp(item.strength * scale, 0, 1);
    const effect = byId.get(item.id);
    if (!effect || strength <= 0) return;
    out = effect.apply(out, { strength, seed: (seed + k * 101) >>> 0, t });
  });
  return out === src ? clone(src) : out;
}

/** How hard each frame of an animation glitches. Bursts: mostly calm, a few frames go wild. */
export function rhythm(kind: Rhythm, frame: number, frames: number, seed: number) {
  if (kind === "pulse") return 0.5 - 0.5 * Math.cos((2 * Math.PI * frame) / Math.max(1, frames));
  if (kind === "bursts") {
    const r = rng(seed * 31 + frame * 7919)();
    return r < 0.65 ? r * 0.18 : 0.55 + (r - 0.65) * 1.28;
  }
  return 1;
}

/** One still → `frames` animation frames; each frame gets its own randomness and phase. */
export function glitchFrames(src: Pixels, stack: StackItem[], options: { frames: number; rhythm: Rhythm; seed: number }) {
  const n = clamp(Math.round(options.frames), 1, 120);
  return Array.from({ length: n }, (_, f) =>
    applyStack(src, stack, (options.seed + f * 7919) >>> 0, f / n, rhythm(options.rhythm, f, n, options.seed)),
  );
}
