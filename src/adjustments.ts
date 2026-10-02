/**
 * Nondestructive per-layer colour adjustments.
 *
 * One definition drives three renderers so they cannot drift apart: an SVG filter used by
 * the DOM canvas (CSS `filter`) and by PNG export (`ctx.filter`), and `adjustRGB`, a plain
 * reference used by tests. Source pixels are never modified.
 */
export interface Adjustments {
  enabled: boolean;
  /** −100…100, multiplies light (−100 is black). */
  brightness: number;
  /** −100…100, scales distance from middle grey. */
  contrast: number;
  /** −100…100, −100 is greyscale. */
  saturation: number;
  /** −180…180 degrees. */
  hue: number;
  /** −100 cool … 100 warm. */
  warmth: number;
  /** −100 green … 100 magenta. */
  tint: number;
  /** Levels input black point, 0…250 (8-bit). */
  black: number;
  /** Levels input white point, 5…255 (8-bit), always above black. */
  white: number;
  /** Levels midtones, 0.25…4 (1 = unchanged; higher is lighter). */
  gamma: number;
}
export const neutralAdjustments: Adjustments = Object.freeze({
  enabled: true,
  brightness: 0,
  contrast: 0,
  saturation: 0,
  hue: 0,
  warmth: 0,
  tint: 0,
  black: 0,
  white: 255,
  gamma: 1,
});
export const adjustmentRanges = {
  brightness: [-100, 100],
  contrast: [-100, 100],
  saturation: [-100, 100],
  hue: [-180, 180],
  warmth: [-100, 100],
  tint: [-100, 100],
  black: [0, 250],
  white: [5, 255],
  gamma: [0.25, 4],
} as const;
export type AdjustmentKey = keyof typeof adjustmentRanges;
export const adjustmentKeys = Object.keys(adjustmentRanges) as AdjustmentKey[];

export function isNeutral(a?: Adjustments) {
  return !a || adjustmentKeys.every((k) => a[k] === neutralAdjustments[k]);
}
/** True when the layer currently looks different from its pixels. */
export function isActive(a?: Adjustments): a is Adjustments {
  return !!a && a.enabled && !isNeutral(a);
}

type Affine = { m: number[]; o: number[] }; // 3×3 row-major + offset, colour in 0…1
const identity = (): Affine => ({
  m: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  o: [0, 0, 0],
});
function then(first: Affine, second: Affine): Affine {
  const m = new Array(9).fill(0),
    o = [0, 0, 0];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++)
      for (let k = 0; k < 3; k++)
        m[r * 3 + c] += second.m[r * 3 + k] * first.m[k * 3 + c];
    o[r] = second.o[r];
    for (let k = 0; k < 3; k++) o[r] += second.m[r * 3 + k] * first.o[k];
  }
  return { m, o };
}
const diagonal = (r: number, g: number, b: number, offset = 0): Affine => ({
  m: [r, 0, 0, 0, g, 0, 0, 0, b],
  o: [offset, offset, offset],
});
/** Brightness → contrast → saturation → hue → warmth/tint, as one affine map. */
export function colorMatrix(a: Adjustments): Affine {
  let t = identity();
  const k = 1 + a.brightness / 100;
  t = then(t, diagonal(k, k, k));
  const f = 1 + a.contrast / 100;
  t = then(t, diagonal(f, f, f, 0.5 * (1 - f)));
  const s = 1 + a.saturation / 100;
  // Same luminance weights and form as CSS saturate() / feColorMatrix type="saturate".
  t = then(t, {
    m: [
      0.2126 + 0.7874 * s,
      0.7152 - 0.7152 * s,
      0.0722 - 0.0722 * s,
      0.2126 - 0.2126 * s,
      0.7152 + 0.2848 * s,
      0.0722 - 0.0722 * s,
      0.2126 - 0.2126 * s,
      0.7152 - 0.7152 * s,
      0.0722 + 0.9278 * s,
    ],
    o: [0, 0, 0],
  });
  const h = (a.hue * Math.PI) / 180,
    cos = Math.cos(h),
    sin = Math.sin(h);
  // CSS hue-rotate() matrix.
  t = then(t, {
    m: [
      0.213 + cos * 0.787 - sin * 0.213,
      0.715 - cos * 0.715 - sin * 0.715,
      0.072 - cos * 0.072 + sin * 0.928,
      0.213 - cos * 0.213 + sin * 0.143,
      0.715 + cos * 0.285 + sin * 0.14,
      0.072 - cos * 0.072 - sin * 0.283,
      0.213 - cos * 0.213 - sin * 0.787,
      0.715 - cos * 0.715 + sin * 0.715,
      0.072 + cos * 0.928 + sin * 0.072,
    ],
    o: [0, 0, 0],
  });
  // Colour grading last, so warmth and tint still tint a desaturated image.
  const w = a.warmth / 100,
    u = a.tint / 100;
  t = then(t, diagonal(1 + 0.18 * w, 1 - 0.18 * u, 1 - 0.18 * w));
  return t;
}
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
function levelsActive(a: Adjustments) {
  return a.black !== 0 || a.white !== 255 || a.gamma !== 1;
}
function matrixActive(a: Adjustments) {
  return (
    ["brightness", "contrast", "saturation", "hue", "warmth", "tint"] as const
  ).some((k) => a[k] !== 0);
}
/** Reference implementation for 8-bit RGB, used to verify the rendered filter. */
export function adjustRGB(rgb: [number, number, number], a: Adjustments) {
  let c = rgb.map((v) => v / 255);
  if (!isActive(a)) return rgb.slice() as [number, number, number];
  if (levelsActive(a)) {
    const lo = a.black / 255,
      hi = a.white / 255;
    c = c.map((v) => clamp01((v - lo) / (hi - lo)) ** (1 / a.gamma));
  }
  if (matrixActive(a)) {
    const { m, o } = colorMatrix(a);
    c = [0, 1, 2].map((r) =>
      clamp01(
        m[r * 3] * c[0] + m[r * 3 + 1] * c[1] + m[r * 3 + 2] * c[2] + o[r],
      ),
    );
  }
  return c.map((v) => Math.round(v * 255)) as [number, number, number];
}
const round = (v: number) => +v.toFixed(6);
/** SVG filter primitives; exported for tests. Empty when nothing changes. */
export function filterMarkup(a: Adjustments) {
  let markup = "";
  if (levelsActive(a)) {
    const lo = a.black / 255,
      hi = a.white / 255,
      slope = round(1 / (hi - lo)),
      intercept = round(-lo / (hi - lo)),
      exponent = round(1 / a.gamma);
    const funcs = (attrs: string) =>
      ["R", "G", "B"].map((ch) => `<feFunc${ch} ${attrs}/>`).join("");
    markup += `<feComponentTransfer>${funcs(`type="linear" slope="${slope}" intercept="${intercept}"`)}</feComponentTransfer>`;
    if (a.gamma !== 1)
      markup += `<feComponentTransfer>${funcs(`type="gamma" amplitude="1" exponent="${exponent}" offset="0"`)}</feComponentTransfer>`;
  }
  if (matrixActive(a)) {
    const { m, o } = colorMatrix(a);
    const rows = [0, 1, 2].map((r) =>
      [m[r * 3], m[r * 3 + 1], m[r * 3 + 2], 0, o[r]].map(round).join(" "),
    );
    markup += `<feColorMatrix type="matrix" values="${rows.join("  ")}  0 0 0 1 0"/>`;
  }
  return markup;
}
const filters = new Map<string, Element>();
let defs: SVGSVGElement | null = null;
function hash(text: string) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = (h * 33) ^ text.charCodeAt(i);
  return (h >>> 0).toString(36);
}
/**
 * CSS/canvas filter value for a layer's adjustments ("none" when inactive). The referenced
 * SVG filter is created on demand in the current document and reused by identical settings.
 */
export function adjustmentFilter(a?: Adjustments) {
  if (!isActive(a)) return "none";
  const markup = filterMarkup(a);
  if (!markup) return "none";
  const id = `sz-adjust-${hash(markup)}`;
  const existing = filters.get(id);
  if (existing?.isConnected) {
    filters.delete(id);
    filters.set(id, existing); // most recently used last
    return `url(#${id})`;
  }
  if (!defs?.isConnected) {
    const ns = "http://www.w3.org/2000/svg";
    defs = document.createElementNS(ns, "svg");
    defs.setAttribute("aria-hidden", "true");
    defs.setAttribute("width", "0");
    defs.setAttribute("height", "0");
    defs.style.position = "absolute";
    defs.style.pointerEvents = "none";
    document.body.append(defs);
    filters.clear();
  }
  const holder = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  // Markup is generated from validated numbers only.
  holder.innerHTML = `<filter id="${id}" color-interpolation-filters="sRGB">${markup}</filter>`;
  const filter = holder.firstElementChild!;
  defs.append(filter);
  filters.set(id, filter);
  while (filters.size > 400) {
    const [oldest, element] = filters.entries().next().value!;
    element.remove();
    filters.delete(oldest);
  }
  return `url(#${id})`;
}
/** Strict reconstruction for project import. */
export function parseAdjustments(raw: any): Adjustments {
  if (!raw || typeof raw !== "object")
    throw Error("Invalid image adjustments.");
  const out: Adjustments = {
    ...neutralAdjustments,
    enabled: raw.enabled !== false,
  };
  for (const key of adjustmentKeys) {
    if (raw[key] === undefined) continue;
    const [min, max] = adjustmentRanges[key];
    const v = raw[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max)
      throw Error("Invalid image adjustments.");
    out[key] = v;
  }
  if (out.white - out.black < 5) throw Error("Invalid image adjustments.");
  return out;
}
