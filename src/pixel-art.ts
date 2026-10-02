/**
 * Pixel art from any image, entirely in the browser. Pure functions over RGBA buffers.
 *
 * pixelate: contrast-aware downscale. Flat cells average; cells with an edge keep their minority
 *   extreme, so thin dark outlines and small highlights survive (the idea behind PixelOE).
 * snapGrid: for AI "pixel art" that is blocky but off-grid: detect the block size, then take the
 *   most common colour of each block.
 * palette (k-means in OKLab, deterministic) + ordered dithering, shared palettes for sprites,
 * hard alpha and a 1-pixel outline for transparent sprites.
 */

export interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}
export type RGB = [number, number, number];

export function makePixels(width: number, height: number): Pixels {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Output size for a target width (aspect preserved, at least 1 pixel). */
export function targetSize(width: number, height: number, targetWidth: number) {
  const w = Math.max(1, Math.min(width, Math.round(targetWidth)));
  return { width: w, height: Math.max(1, Math.round((height * w) / width)) };
}

/** Contrast-aware downscale to width × height cells. Alpha is decided by majority per cell. */
export function pixelate(src: Pixels, width: number, height: number, edgeThreshold = 40): Pixels {
  const out = makePixels(width, height);
  const sx = src.width / width,
    sy = src.height / height;
  const d = src.data;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy),
      y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx),
        x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let n = 0,
        opaque = 0,
        r = 0,
        g = 0,
        b = 0;
      let minL = 256,
        maxL = -1,
        minI = -1,
        maxI = -1;
      const lums: number[] = [];
      for (let yy = y0; yy < y1; yy++)
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * src.width + xx) * 4;
          n++;
          if (d[i + 3] < 128) continue;
          opaque++;
          r += d[i];
          g += d[i + 1];
          b += d[i + 2];
          const l = luma(d[i], d[i + 1], d[i + 2]);
          lums.push(l);
          if (l < minL) (minL = l), (minI = i);
          if (l > maxL) (maxL = l), (maxI = i);
        }
      const o = (y * width + x) * 4;
      if (opaque * 2 < n) continue; // transparent cell
      out.data[o + 3] = 255;
      if (maxL - minL > edgeThreshold) {
        lums.sort((a, b) => a - b);
        const median = lums[lums.length >> 1];
        // Keep the minority extreme: a thin dark line in a light cell stays dark, and vice versa.
        const pick = median - minL > maxL - median ? minI : maxI;
        out.data[o] = d[pick];
        out.data[o + 1] = d[pick + 1];
        out.data[o + 2] = d[pick + 2];
      } else {
        out.data[o] = Math.round(r / opaque);
        out.data[o + 1] = Math.round(g / opaque);
        out.data[o + 2] = Math.round(b / opaque);
      }
    }
  }
  return out;
}

/**
 * Estimate the block size of off-grid pixel art (2–64 px). Uses colour-change energy along rows
 * and columns and picks the period whose grid lines carry the most energy.
 */
export function detectBlockSize(src: Pixels, maxSize = 64) {
  const energy = (horizontal: boolean) => {
    const length = horizontal ? src.width : src.height;
    const across = horizontal ? src.height : src.width;
    const e = new Float64Array(length);
    const step = Math.max(1, Math.floor(across / 256));
    for (let a = 0; a < across; a += step)
      for (let i = 1; i < length; i++) {
        const p = horizontal ? (a * src.width + i) * 4 : (i * src.width + a) * 4;
        const q = horizontal ? p - 4 : p - src.width * 4;
        const d = src.data;
        e[i] += Math.abs(d[p] - d[q]) + Math.abs(d[p + 1] - d[q + 1]) + Math.abs(d[p + 2] - d[q + 2]) + Math.abs(d[p + 3] - d[q + 3]);
      }
    return e;
  };
  const score = (e: Float64Array, period: number) => {
    let best = 0;
    for (let phase = 0; phase < period; phase++) {
      let on = 0,
        count = 0;
      for (let i = phase; i < e.length; i += period) (on += e[i]), count++;
      best = Math.max(best, count ? on / count : 0);
    }
    let total = 0;
    for (const v of e) total += v;
    return best / (total / e.length + 1e-9);
  };
  const ex = energy(true),
    ey = energy(false);
  let bestSize = 1,
    bestScore = 0;
  for (let size = 2; size <= Math.min(maxSize, Math.floor(Math.min(src.width, src.height) / 4)); size++) {
    // Prefer the larger of near-equal periods only when it clearly wins (multiples also score well).
    const s = (score(ex, size) + score(ey, size)) / 2;
    if (s > bestScore * 1.08) (bestScore = s), (bestSize = size);
  }
  return bestScore > 2 ? bestSize : 1;
}

/** Snap off-grid pixel art: most common colour per detected block. */
export function snapGrid(src: Pixels, blockSize: number): Pixels {
  const width = Math.max(1, Math.round(src.width / blockSize)),
    height = Math.max(1, Math.round(src.height / blockSize));
  const out = makePixels(width, height);
  const sx = src.width / width,
    sy = src.height / height;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const counts = new Map<number, number>();
      // Sample the inner part of each block: edges are where anti-aliasing lives.
      const x0 = Math.floor(x * sx + sx * 0.2),
        x1 = Math.max(x0 + 1, Math.ceil((x + 1) * sx - sx * 0.2));
      const y0 = Math.floor(y * sy + sy * 0.2),
        y1 = Math.max(y0 + 1, Math.ceil((y + 1) * sy - sy * 0.2));
      for (let yy = y0; yy < Math.min(y1, src.height); yy++)
        for (let xx = x0; xx < Math.min(x1, src.width); xx++) {
          const i = (yy * src.width + xx) * 4,
            d = src.data;
          const key = d[i + 3] < 128 ? -1 : ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3);
          counts.set(key, (counts.get(key) || 0) + 1);
        }
      let key = -1,
        best = -1;
      for (const [k, c] of counts) if (c > best) (best = c), (key = k);
      const o = (y * width + x) * 4;
      if (key < 0) continue;
      // Average the exact pixels of the winning bucket for a faithful colour.
      let r = 0,
        g = 0,
        b = 0,
        n = 0;
      for (let yy = y0; yy < Math.min(y1, src.height); yy++)
        for (let xx = x0; xx < Math.min(x1, src.width); xx++) {
          const i = (yy * src.width + xx) * 4,
            d = src.data;
          if (d[i + 3] >= 128 && (((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3)) === key)
            (r += d[i]), (g += d[i + 1]), (b += d[i + 2]), n++;
        }
      out.data[o] = Math.round(r / n);
      out.data[o + 1] = Math.round(g / n);
      out.data[o + 2] = Math.round(b / n);
      out.data[o + 3] = 255;
    }
  return out;
}

// OKLab ---------------------------------------------------------------------------------------
const lin = (c: number) => {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
export function oklab(r: number, g: number, b: number): RGB {
  const R = lin(r),
    G = lin(g),
    B = lin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
const dist = (a: RGB, b: RGB) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/** A palette of up to `k` colours for one or more images (k-means++ in OKLab, deterministic). */
export function buildPalette(images: Pixels[], k: number): RGB[] {
  const counts = new Map<number, number>();
  for (const img of images)
    for (let i = 0; i < img.data.length; i += 4) {
      if (img.data[i + 3] < 128) continue;
      const key = (img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2];
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  const colors = [...counts.entries()].map(([key, w]) => ({
    rgb: [(key >> 16) & 255, (key >> 8) & 255, key & 255] as RGB,
    lab: oklab((key >> 16) & 255, (key >> 8) & 255, key & 255),
    w,
  }));
  if (!colors.length) return [];
  if (colors.length <= k) return colors.map((c) => c.rgb);
  colors.sort((a, b) => b.w - a.w);
  // k-means++ with a fixed pseudo-random sequence (same input → same palette).
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const centers: RGB[] = [colors[0].lab];
  const nearest = colors.map((c) => dist(c.lab, centers[0]));
  while (centers.length < k) {
    let total = 0;
    for (let i = 0; i < colors.length; i++) total += nearest[i] * colors[i].w;
    if (total <= 0) break;
    let target = rand() * total,
      pick = 0;
    for (; pick < colors.length - 1; pick++) {
      target -= nearest[pick] * colors[pick].w;
      if (target <= 0) break;
    }
    centers.push(colors[pick].lab);
    for (let i = 0; i < colors.length; i++) nearest[i] = Math.min(nearest[i], dist(colors[i].lab, colors[pick].lab));
  }
  const assign = new Int32Array(colors.length);
  for (let iteration = 0; iteration < 16; iteration++) {
    let moved = false;
    for (let i = 0; i < colors.length; i++) {
      let best = 0,
        bestD = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const dd = dist(colors[i].lab, centers[c]);
        if (dd < bestD) (bestD = dd), (best = c);
      }
      if (assign[i] !== best) (assign[i] = best), (moved = true);
    }
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < colors.length; i++) {
      const s = sums[assign[i]],
        c = colors[i];
      s[0] += c.lab[0] * c.w;
      s[1] += c.lab[1] * c.w;
      s[2] += c.lab[2] * c.w;
      s[3] += c.w;
    }
    sums.forEach((s, c) => {
      if (s[3]) centers[c] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]];
    });
    if (!moved && iteration) break;
  }
  // Report each cluster as its most frequent real colour (no invented in-between colours).
  const best = centers.map(() => ({ rgb: [0, 0, 0] as RGB, w: -1 }));
  for (let i = 0; i < colors.length; i++) {
    const b = best[assign[i]];
    if (colors[i].w > b.w) (b.w = colors[i].w), (b.rgb = colors[i].rgb);
  }
  return best.filter((b) => b.w >= 0).map((b) => b.rgb);
}

const bayer4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** Map every opaque pixel to the nearest palette colour; optional 4×4 ordered dithering. */
export function applyPalette(src: Pixels, palette: RGB[], dither = 0): Pixels {
  const out = makePixels(src.width, src.height);
  if (!palette.length) return { ...src, data: new Uint8ClampedArray(src.data) };
  const labs = palette.map((c) => oklab(...c));
  const cache = new Map<number, number>();
  for (let y = 0; y < src.height; y++)
    for (let x = 0; x < src.width; x++) {
      const i = (y * src.width + x) * 4,
        d = src.data;
      if (d[i + 3] < 128) continue;
      const offset = dither ? ((bayer4[(y & 3) * 4 + (x & 3)] + 0.5) / 16 - 0.5) * dither * 64 : 0;
      const r = Math.max(0, Math.min(255, d[i] + offset)),
        g = Math.max(0, Math.min(255, d[i + 1] + offset)),
        b = Math.max(0, Math.min(255, d[i + 2] + offset));
      const key = (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
      let pick = cache.get(key);
      if (pick === undefined) {
        const lab = oklab(r, g, b);
        let bestD = Infinity;
        pick = 0;
        for (let c = 0; c < labs.length; c++) {
          const dd = dist(lab, labs[c]);
          if (dd < bestD) (bestD = dd), (pick = c);
        }
        cache.set(key, pick);
      }
      out.data[i] = palette[pick][0];
      out.data[i + 1] = palette[pick][1];
      out.data[i + 2] = palette[pick][2];
      out.data[i + 3] = 255;
    }
  return out;
}

/** Hard alpha: every pixel fully opaque or fully transparent. */
export function hardAlpha(src: Pixels, threshold = 128): Pixels {
  const out = { ...src, data: new Uint8ClampedArray(src.data) };
  for (let i = 3; i < out.data.length; i += 4) out.data[i] = out.data[i] >= threshold ? 255 : 0;
  return out;
}

/** A 1-pixel outline around opaque shapes (4-neighbour), drawn into transparent pixels. */
export function outline(src: Pixels, color: RGB | "auto"): Pixels {
  const out = { ...src, data: new Uint8ClampedArray(src.data) };
  const { width: w, height: h, data: d } = src;
  let fill = color as RGB;
  if (color === "auto") {
    // Darkest opaque colour, darkened further: reads as an outline in most palettes.
    let best = 256;
    fill = [0, 0, 0];
    for (let i = 0; i < d.length; i += 4)
      if (d[i + 3] >= 128) {
        const l = luma(d[i], d[i + 1], d[i + 2]);
        if (l < best) (best = l), (fill = [d[i] * 0.5, d[i + 1] * 0.5, d[i + 2] * 0.5]);
      }
  }
  const opaque = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && d[(y * w + x) * 4 + 3] >= 128;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (opaque(x, y)) continue;
      if (opaque(x - 1, y) || opaque(x + 1, y) || opaque(x, y - 1) || opaque(x, y + 1)) {
        const i = (y * w + x) * 4;
        out.data[i] = fill[0];
        out.data[i + 1] = fill[1];
        out.data[i + 2] = fill[2];
        out.data[i + 3] = 255;
      }
    }
  return out;
}

export interface PixelArtOptions {
  /** "resize": contrast-aware downscale to targetWidth. "snap": detect and snap off-grid blocks. */
  method: "resize" | "snap";
  targetWidth: number;
  /** Block size for "snap"; 0 = detect. */
  blockSize: number;
  /** 0 = keep colours. */
  colors: number;
  /** 0–1 ordered dithering strength. */
  dither: number;
  outline: "none" | "auto" | "black";
  palette?: RGB[];
}

export function pixelArt(src: Pixels, options: PixelArtOptions) {
  let img: Pixels;
  let blockSize = 0;
  if (options.method === "snap") {
    blockSize = options.blockSize || detectBlockSize(src);
    img = snapGrid(src, Math.max(1, blockSize));
  } else {
    const size = targetSize(src.width, src.height, options.targetWidth);
    img = pixelate(src, size.width, size.height);
  }
  img = hardAlpha(img);
  const palette = options.palette ?? (options.colors ? buildPalette([img], options.colors) : undefined);
  if (palette?.length) img = applyPalette(img, palette, options.dither);
  if (options.outline !== "none") img = outline(img, options.outline === "black" ? [0, 0, 0] : "auto");
  return { pixels: img, blockSize, palette: palette ?? [] };
}

export function countColors(src: Pixels) {
  const set = new Set<number>();
  for (let i = 0; i < src.data.length; i += 4)
    if (src.data[i + 3] >= 128) set.add((src.data[i] << 16) | (src.data[i + 1] << 8) | src.data[i + 2]);
  return set.size;
}
