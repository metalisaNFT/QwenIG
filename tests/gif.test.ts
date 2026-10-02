import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeGIF, gifPalette, indexFrame, lzw, medianCut } from "../src/gif.ts";
import type { Pixels } from "../src/pixel-art.ts";

/** Minimal GIF LZW decoder (the reference behaviour browsers and PIL implement). */
function unlzw(blocks: Uint8Array, minCode: number) {
  const bytes: number[] = [];
  for (let i = 0; blocks[i]; i += blocks[i] + 1) bytes.push(...blocks.subarray(i + 1, i + 1 + blocks[i]));
  const clear = 1 << minCode,
    end = clear + 1;
  let size = minCode + 1,
    dict: number[][] = [],
    prev: number[] | null = null;
  const reset = () => {
    dict = Array.from({ length: clear + 2 }, (_, i) => [i]);
    size = minCode + 1;
    prev = null;
  };
  reset();
  const out: number[] = [];
  let buf = 0,
    bits = 0,
    pos = 0;
  for (;;) {
    while (bits < size && pos < bytes.length) (buf |= bytes[pos++] << bits), (bits += 8);
    if (bits < size) break;
    const code = buf & ((1 << size) - 1);
    buf >>>= size;
    bits -= size;
    if (code === clear) { reset(); continue; }
    if (code === end) break;
    const entry = code < dict.length ? dict[code] : [...prev!, prev![0]];
    out.push(...entry);
    if (prev) dict.push([...prev, entry[0]]);
    prev = entry;
    if (dict.length === 1 << size && size < 12) size++;
  }
  return out;
}

test("LZW round-trips short, repetitive and long random data (dictionary resets)", () => {
  let seed = 3;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 256);
  for (const [data, min] of [
    [Uint8Array.from([1]), 2],
    [Uint8Array.from([0, 1, 0, 1, 0, 1, 2, 3, 3, 3, 3, 3]), 2],
    [new Uint8Array(20000).fill(7), 8],
    [Uint8Array.from({ length: 60000 }, rand), 8],
  ] as const) assert.deepEqual(unlzw(lzw(data, min), min), [...data]);
});

const solid = (w: number, h: number, rgba: number[]): Pixels => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return { width: w, height: h, data };
};

test("palette: few colours stay exact; transparency reserves index 0", () => {
  const f = solid(4, 2, [255, 0, 0, 255]);
  f.data.set([0, 0, 255, 255], 4);
  f.data.set([0, 0, 0, 0], 8);
  const info = gifPalette([f], { colors: 8 });
  assert.ok(info.transparent);
  const idx = indexFrame(f, info);
  assert.equal(idx[2], 0);
  const red = info.palette[idx[0]], blue = info.palette[idx[1]];
  assert.ok(red[0] > 240 && red[2] < 16 && blue[2] > 240 && blue[0] < 16, JSON.stringify(info.palette));
  const opaque = gifPalette([solid(2, 2, [10, 20, 30, 255])], { transparent: true });
  assert.ok(!opaque.transparent); // nothing transparent: no slot wasted
  assert.ok(medianCut(new Uint32Array(32768), 4).length >= 1);
});

test("GIF file: header, loop block, delays, frame count and trailer", () => {
  const frames = [0, 1, 2].map((n) => ({ pixels: solid(5, 3, [n * 100, 50, 200, 255]), delay: 100 + n * 50 }));
  const gif = encodeGIF(frames, { loop: true });
  const text = (a: number, n: number) => String.fromCharCode(...gif.subarray(a, a + n));
  assert.equal(text(0, 6), "GIF89a");
  assert.equal(gif[6] | (gif[7] << 8), 5);
  assert.equal(gif[8] | (gif[9] << 8), 3);
  assert.ok(text(0, gif.length).includes("NETSCAPE2.0"));
  assert.equal(gif[gif.length - 1], 0x3b);
  const delays: number[] = [];
  for (let i = 0; i < gif.length - 7; i++)
    if (gif[i] === 0x21 && gif[i + 1] === 0xf9 && gif[i + 2] === 4) delays.push(gif[i + 4] | (gif[i + 5] << 8));
  assert.deepEqual(delays, [10, 15, 20]);
  const once = encodeGIF(frames, { loop: false });
  assert.ok(!String.fromCharCode(...once).includes("NETSCAPE"));
  assert.throws(() => encodeGIF([{ pixels: solid(2, 2, [0, 0, 0, 255]), delay: 5 }, { pixels: solid(3, 2, [0, 0, 0, 255]), delay: 5 }]), /same size/);
  // Very short delays are raised to 20 ms (browsers slow anything faster down to 100 ms).
  const fast = encodeGIF([{ pixels: solid(1, 1, [0, 0, 0, 255]), delay: 1 }]);
  const at = fast.findIndex((v, i) => v === 0x21 && fast[i + 1] === 0xf9);
  assert.equal(fast[at + 4], 2);
});
