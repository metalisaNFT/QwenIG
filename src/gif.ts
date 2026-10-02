/**
 * Animated GIF (GIF89a) encoder with no dependencies.
 *
 * One global palette for the whole animation (median cut on a 15-bit histogram, refined with a
 * couple of k-means passes) so colours do not flicker between frames; optional 4×4 ordered
 * dithering; real transparency (palette index 0) when frames have transparent pixels; per-frame
 * delays; loop forever or play once.
 */
import type { Pixels, RGB } from "./pixel-art.ts";

export interface GifFrame {
  pixels: Pixels;
  /** Milliseconds this frame is shown. GIF stores hundredths of a second (minimum 20 ms). */
  delay: number;
}
export interface GifOptions {
  loop?: boolean;
  /** 2…256 palette entries (including the transparent one). */
  colors?: number;
  /** 0…1 ordered-dither strength. */
  dither?: number;
  /** Keep transparent pixels transparent (alpha < 128). Off: they are composited on `matte`. */
  transparent?: boolean;
  matte?: RGB;
}

const bayer4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const bin = (r: number, g: number, b: number) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

/** Median cut over a weighted 15-bit colour histogram. */
export function medianCut(hist: Uint32Array, k: number): RGB[] {
  type Box = { bins: number[]; count: number };
  const used: number[] = [];
  for (let i = 0; i < hist.length; i++) if (hist[i]) used.push(i);
  if (!used.length) return [[0, 0, 0]];
  const channel = (b: number, c: number) => (c === 0 ? b >> 10 : c === 1 ? (b >> 5) & 31 : b & 31);
  const weight = (bins: number[]) => bins.reduce((s, b) => s + hist[b], 0);
  const boxes: Box[] = [{ bins: used, count: weight(used) }];
  while (boxes.length < k) {
    // Split the box with the most pixels × widest range; stop when nothing can split.
    let pick = -1,
      best = 0,
      axis = 0;
    boxes.forEach((box, i) => {
      if (box.bins.length < 2) return;
      for (let c = 0; c < 3; c++) {
        let lo = 31,
          hi = 0;
        for (const b of box.bins) {
          const v = channel(b, c);
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        const score = (hi - lo) * Math.sqrt(box.count);
        if (score > best) (best = score), (pick = i), (axis = c);
      }
    });
    if (pick < 0) break;
    const box = boxes[pick];
    box.bins.sort((a, b) => channel(a, axis) - channel(b, axis));
    let half = box.count / 2,
      cut = 0;
    for (; cut < box.bins.length - 1; cut++) {
      half -= hist[box.bins[cut]];
      if (half <= 0) break;
    }
    cut = Math.min(cut, box.bins.length - 2); // both halves keep at least one colour
    const left = box.bins.slice(0, cut + 1),
      right = box.bins.slice(cut + 1);
    boxes.splice(pick, 1, { bins: left, count: weight(left) }, { bins: right, count: weight(right) });
  }
  const centre = (b: number): RGB => [((b >> 10) << 3) | 4, (((b >> 5) & 31) << 3) | 4, ((b & 31) << 3) | 4];
  let palette: RGB[] = boxes.map((box) => {
    const s = [0, 0, 0];
    for (const b of box.bins) {
      const c = centre(b);
      for (let i = 0; i < 3; i++) s[i] += c[i] * hist[b];
    }
    return s.map((v) => Math.round(v / box.count)) as RGB;
  });
  // Two k-means passes pull each colour to the middle of the pixels it really serves.
  for (let pass = 0; pass < 2; pass++) {
    const sums = palette.map(() => [0, 0, 0, 0]);
    for (const b of used) {
      const c = centre(b);
      const i = nearest(palette, c[0], c[1], c[2]);
      const s = sums[i];
      for (let j = 0; j < 3; j++) s[j] += c[j] * hist[b];
      s[3] += hist[b];
    }
    palette = palette.map((p, i) => (sums[i][3] ? (sums[i].slice(0, 3).map((v) => Math.round(v / sums[i][3])) as RGB) : p));
  }
  return palette;
}

function nearest(palette: RGB[], r: number, g: number, b: number) {
  let best = 0,
    bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i];
    // Weighted RGB distance (eyes are most sensitive to green).
    const d = 2 * (p[0] - r) ** 2 + 4 * (p[1] - g) ** 2 + 3 * (p[2] - b) ** 2;
    if (d < bestD) (bestD = d), (best = i);
  }
  return best;
}

/** Everything needed to turn RGBA frames into palette indices. */
export function gifPalette(frames: Pixels[], options: GifOptions = {}) {
  const transparent = options.transparent !== false && frames.some((f) => hasTransparency(f));
  const colors = Math.max(2, Math.min(256, Math.round(options.colors ?? 256)));
  const matte = options.matte ?? [255, 255, 255];
  const hist = new Uint32Array(32768);
  const total = frames.reduce((s, f) => s + f.width * f.height, 0);
  const step = Math.max(1, Math.floor(total / 400_000)); // sample big animations
  let seen = 0;
  for (const f of frames)
    for (let i = 0; i < f.data.length; i += 4, seen++) {
      if (seen % step) continue;
      const a = f.data[i + 3];
      if (transparent && a < 128) continue;
      const [r, g, b] = composite(f.data, i, transparent, matte);
      hist[bin(r, g, b)]++;
    }
  const palette = medianCut(hist, colors - (transparent ? 1 : 0));
  return { palette: transparent ? ([[0, 0, 0], ...palette] as RGB[]) : palette, transparent, offset: transparent ? 1 : 0, matte };
}

function hasTransparency(f: Pixels) {
  for (let i = 3; i < f.data.length; i += 4) if (f.data[i] < 128) return true;
  return false;
}

function composite(d: Uint8ClampedArray, i: number, transparent: boolean, matte: RGB): RGB {
  const a = d[i + 3];
  if (transparent || a === 255) return [d[i], d[i + 1], d[i + 2]];
  const k = a / 255;
  return [d[i] * k + matte[0] * (1 - k), d[i + 1] * k + matte[1] * (1 - k), d[i + 2] * k + matte[2] * (1 - k)];
}

/** Palette indices for one frame (transparent pixels → 0 when the palette reserves it). */
export function indexFrame(frame: Pixels, info: ReturnType<typeof gifPalette>, dither = 0, lut = new Int16Array(32768).fill(-1)) {
  const { width: w, height: h, data: d } = frame;
  const out = new Uint8Array(w * h);
  const colours = info.palette.slice(info.offset);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x,
        i = p * 4;
      if (info.transparent && d[i + 3] < 128) {
        out[p] = 0;
        continue;
      }
      let [r, g, b] = composite(d, i, info.transparent, info.matte);
      if (dither) {
        const o = ((bayer4[(y & 3) * 4 + (x & 3)] + 0.5) / 16 - 0.5) * dither * 48;
        r = Math.max(0, Math.min(255, r + o));
        g = Math.max(0, Math.min(255, g + o));
        b = Math.max(0, Math.min(255, b + o));
      }
      const key = bin(r | 0, g | 0, b | 0);
      let idx = lut[key];
      if (idx < 0) idx = lut[key] = nearest(colours, ((key >> 10) << 3) | 4, (((key >> 5) & 31) << 3) | 4, ((key & 31) << 3) | 4);
      out[p] = idx + info.offset;
    }
  return out;
}

/** LZW-compress palette indices into GIF sub-blocks. */
export function lzw(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const clear = 1 << minCodeSize,
    end = clear + 1;
  const bytes: number[] = [];
  let bitBuffer = 0,
    bitCount = 0,
    codeSize = minCodeSize + 1,
    next = end + 1;
  const emit = (code: number) => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      bytes.push(bitBuffer & 255);
      bitBuffer >>>= 8;
      bitCount -= 8;
    }
  };
  // Dictionary: (prefix code, next index) → code, as an open-addressed table reset by generation.
  const SIZE = 1 << 20;
  const keys = new Int32Array(SIZE),
    codes = new Int32Array(SIZE),
    stamps = new Int32Array(SIZE);
  let generation = 1;
  emit(clear);
  if (!indices.length) {
    emit(end);
  } else {
    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i];
      const key = (prefix << 8) | k;
      let slot = (key * 2654435761) >>> 12 & (SIZE - 1);
      let found = -1;
      while (stamps[slot] === generation) {
        if (keys[slot] === key) {
          found = codes[slot];
          break;
        }
        slot = (slot + 1) & (SIZE - 1);
      }
      if (found >= 0) {
        prefix = found;
        continue;
      }
      emit(prefix);
      if (next < 4096) {
        stamps[slot] = generation;
        keys[slot] = key;
        codes[slot] = next++;
        if (next > 1 << codeSize && codeSize < 12) codeSize++;
      } else {
        emit(clear);
        generation++;
        codeSize = minCodeSize + 1;
        next = end + 1;
      }
      prefix = k;
    }
    emit(prefix);
    emit(end);
  }
  if (bitCount > 0) bytes.push(bitBuffer & 255);
  // Sub-blocks of at most 255 bytes, then a zero-length terminator.
  const out = new Uint8Array(bytes.length + Math.ceil(bytes.length / 255) + 1);
  let o = 0;
  for (let i = 0; i < bytes.length; i += 255) {
    const n = Math.min(255, bytes.length - i);
    out[o++] = n;
    for (let j = 0; j < n; j++) out[o++] = bytes[i + j];
  }
  out[o++] = 0;
  return out.subarray(0, o);
}

class Bytes {
  parts: Uint8Array[] = [];
  push(...values: number[]) {
    this.parts.push(Uint8Array.from(values));
  }
  word(v: number) {
    this.push(v & 255, (v >> 8) & 255);
  }
  text(s: string) {
    this.push(...[...s].map((c) => c.charCodeAt(0)));
  }
  add(a: Uint8Array) {
    this.parts.push(a);
  }
  join() {
    const out = new Uint8Array(this.parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of this.parts) out.set(p, o), (o += p.length);
    return out;
  }
}

/** Encode frames of equal size. `onFrame` lets async callers report progress and yield. */
export function* gifChunks(frames: GifFrame[], options: GifOptions = {}): Generator<number, Uint8Array> {
  if (!frames.length) throw Error("A GIF needs at least one frame.");
  const { width, height } = frames[0].pixels;
  if (frames.some((f) => f.pixels.width !== width || f.pixels.height !== height)) throw Error("Every GIF frame must have the same size.");
  if (width > 65535 || height > 65535) throw Error("The GIF is too large.");
  const info = gifPalette(frames.map((f) => f.pixels), options);
  let bits = 1;
  while (1 << bits < info.palette.length) bits++;
  const out = new Bytes();
  out.text("GIF89a");
  out.word(width);
  out.word(height);
  out.push(0x80 | (7 << 4) | (bits - 1), 0, 0);
  const table = new Uint8Array(3 << bits);
  info.palette.forEach((c, i) => table.set(c, i * 3));
  out.add(table);
  if (options.loop !== false) {
    out.push(0x21, 0xff, 11);
    out.text("NETSCAPE2.0");
    out.push(3, 1, 0, 0, 0);
  }
  const lut = new Int16Array(32768).fill(-1);
  for (const [n, frame] of frames.entries()) {
    const delay = Math.max(2, Math.round(frame.delay / 10));
    // Disposal 2 (restore background) keeps transparent frames from piling up; 1 otherwise.
    out.push(0x21, 0xf9, 4, ((info.transparent ? 2 : 1) << 2) | (info.transparent ? 1 : 0));
    out.word(delay);
    out.push(0, 0);
    out.push(0x2c);
    out.word(0);
    out.word(0);
    out.word(width);
    out.word(height);
    out.push(0);
    const minCode = Math.max(2, bits);
    out.push(minCode);
    out.add(lzw(indexFrame(frame.pixels, info, options.dither ?? 0, lut), minCode));
    yield n + 1;
  }
  out.push(0x3b);
  return out.join();
}

export function encodeGIF(frames: GifFrame[], options: GifOptions = {}) {
  const it = gifChunks(frames, options);
  for (;;) {
    const step = it.next();
    if (step.done) return step.value;
  }
}

/** Same as encodeGIF but yields to the page between frames and reports progress. */
export async function encodeGIFAsync(frames: GifFrame[], options: GifOptions, progress?: (done: number, total: number) => void) {
  const it = gifChunks(frames, options);
  for (;;) {
    const step = it.next();
    if (step.done) return step.value;
    progress?.(step.value, frames.length);
    await new Promise((r) => setTimeout(r, 0));
  }
}
