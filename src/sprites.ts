/**
 * Sprite sheets: frame alignment, sheet packing and engine-agnostic JSON
 * (Aseprite "array" format, readable by Godot, Phaser, Unity importers and most tools).
 * Pure layout functions are separate from the canvas helpers.
 */
import type { Pixels } from "./pixel-art.ts";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Bounding box of pixels with alpha ≥ threshold, or null for a fully transparent frame. */
export function alphaBounds(p: Pixels, threshold = 8): Box | null {
  let x0 = p.width,
    y0 = p.height,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < p.height; y++)
    for (let x = 0; x < p.width; x++)
      if (p.data[(y * p.width + x) * 4 + 3] >= threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** One crop for every frame (their union), so the character does not jitter between frames. */
export function unionBox(boxes: (Box | null)[], pad = 0, limit?: { width: number; height: number }): Box | null {
  const real = boxes.filter((b): b is Box => !!b);
  if (!real.length) return null;
  let x0 = Math.min(...real.map((b) => b.x)) - pad,
    y0 = Math.min(...real.map((b) => b.y)) - pad,
    x1 = Math.max(...real.map((b) => b.x + b.width)) + pad,
    y1 = Math.max(...real.map((b) => b.y + b.height)) + pad;
  if (limit) {
    x0 = Math.max(0, x0);
    y0 = Math.max(0, y0);
    x1 = Math.min(limit.width, x1);
    y1 = Math.min(limit.height, y1);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export interface SheetLayout {
  cell: { width: number; height: number };
  columns: number;
  rows: number;
  padding: number;
  width: number;
  height: number;
  /** Where each frame's image is drawn (centred horizontally, standing on the cell bottom). */
  frames: Box[];
  /** Cell rectangles. */
  cells: Box[];
}

/** Pack frames into a grid of equal cells; the cell is the largest frame. */
export function sheetLayout(sizes: { width: number; height: number }[], columns = 0, padding = 0): SheetLayout {
  const n = sizes.length;
  if (!n) throw Error("A sprite needs at least one frame.");
  const cols = Math.max(1, Math.min(n, columns || Math.ceil(Math.sqrt(n))));
  const rows = Math.ceil(n / cols);
  const cw = Math.max(...sizes.map((s) => s.width)),
    ch = Math.max(...sizes.map((s) => s.height));
  const cells: Box[] = [],
    frames: Box[] = [];
  sizes.forEach((s, i) => {
    const cx = padding + (i % cols) * (cw + padding),
      cy = padding + Math.floor(i / cols) * (ch + padding);
    cells.push({ x: cx, y: cy, width: cw, height: ch });
    frames.push({ x: cx + Math.floor((cw - s.width) / 2), y: cy + (ch - s.height), width: s.width, height: s.height });
  });
  return {
    cell: { width: cw, height: ch },
    columns: cols,
    rows,
    padding,
    width: padding + cols * (cw + padding),
    height: padding + rows * (ch + padding),
    frames,
    cells,
  };
}

/** Aseprite-style JSON (array form) for a packed sheet. */
export function sheetJSON(
  name: string,
  image: string,
  layout: SheetLayout,
  durations: number[],
  loop = true,
) {
  return {
    frames: layout.cells.map((cell, i) => ({
      filename: `${name} ${i}`,
      frame: { x: cell.x, y: cell.y, w: cell.width, h: cell.height },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: cell.width, h: cell.height },
      sourceSize: { w: cell.width, h: cell.height },
      duration: Math.round(durations[i]),
    })),
    meta: {
      app: "Studio Zero",
      version: "1",
      image,
      format: "RGBA8888",
      size: { w: layout.width, h: layout.height },
      scale: "1",
      frameTags: [{ name, from: 0, to: layout.cells.length - 1, direction: loop ? "forward" : "forward", repeat: loop ? "0" : "1" }],
      pivot: { x: 0.5, y: 1 },
    },
  };
}

export function frameDurations(frames: { duration?: number }[], fps: number) {
  return frames.map((f) => f.duration ?? 1000 / fps);
}

/** Safe file stem for downloads. */
export function fileStem(name: string) {
  return name.trim().replace(/[^\w\- ]+/g, "").replace(/\s+/g, "-").slice(0, 60) || "sprite";
}

// Canvas helpers --------------------------------------------------------------------------------

export function canvasPixels(c: HTMLCanvasElement): Pixels {
  const d = c.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height);
  return { width: c.width, height: c.height, data: d.data };
}

export function pixelsCanvas(p: Pixels) {
  const c = document.createElement("canvas");
  c.width = p.width;
  c.height = p.height;
  c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(p.data), p.width, p.height), 0, 0);
  return c;
}

export function composeSheet(frames: CanvasImageSource[], layout: SheetLayout) {
  const c = document.createElement("canvas");
  c.width = layout.width;
  c.height = layout.height;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  frames.forEach((f, i) => {
    const b = layout.frames[i];
    ctx.drawImage(f, b.x, b.y, b.width, b.height);
  });
  return c;
}

export function crop(source: CanvasImageSource, box: Box) {
  const c = document.createElement("canvas");
  c.width = box.width;
  c.height = box.height;
  c.getContext("2d")!.drawImage(source, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);
  return c;
}
