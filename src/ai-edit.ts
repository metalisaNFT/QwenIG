/**
 * AI edits of an image layer, prepared in the browser and run on the connected engine.
 * Results are new layers aligned over the source: the source is never overwritten, and for
 * inpaint/outpaint the result is masked to the regenerated area, so untouched pixels stay exact.
 *
 * Masks: the engine wants white = regenerate, black = keep. Studio layer masks store visibility
 * in alpha (white RGB). The "area" painted in the region editor is stored as a layer-mask-style
 * asset where HIDDEN (alpha 0) means "marked for change".
 */
import type { Asset, Layer } from "./model.ts";
import { generationDimensions } from "./resolution.ts";

export type EditOperation =
  | "edit"
  | "inpaint"
  | "outpaint"
  | "image-to-image"
  | "variations";

/** Studio edit modes: the engine operations plus "repose", an instruction edit guided by a pose skeleton. */
export type EditMode = EditOperation | "repose";
/** The engine operation (and capability) behind a studio edit mode. */
export const editOperation = (mode: EditMode): EditOperation => (mode === "repose" ? "edit" : mode);

export const editModes: {
  id: EditMode;
  label: string;
  hint: string;
  strength?: number;
}[] = [
  {
    id: "edit",
    label: "Change with words",
    hint: "Describe the change: “make the jacket red”, “move the cup to the left”, “add rain”. The whole image is re-rendered to follow your instruction.",
  },
  {
    id: "inpaint",
    label: "Repaint an area",
    hint: "Mark the area to change, then describe what belongs there. Everything outside the area stays exactly as it is.",
    strength: 1,
  },
  {
    id: "outpaint",
    label: "Extend the canvas",
    hint: "Grow the image beyond its edges. Describe the wider scene; the original pixels stay untouched.",
    strength: 1,
  },
  {
    id: "image-to-image",
    label: "Re-imagine",
    hint: "Keep the composition and re-render it with your prompt. Lower strength stays closer to the original.",
    strength: 0.6,
  },
  {
    id: "repose",
    label: "Change the pose",
    hint: "Set a pose for the person (detected from the layer, then drag the joints). Optional: describe anything else to change. Identity and clothing are kept; the pose is followed closely, not exactly.",
  },
  {
    id: "variations",
    label: "Variations",
    hint: "Small changes in the same spirit. Uses the original prompt if you leave it empty.",
    strength: 0.45,
  },
];

export interface Frame {
  width: number;
  height: number;
}

/** Engine frame for an image: multiples of 32, long edge ≈ `longEdge`, aspect preserved. */
export function editFrame(width: number, height: number, longEdge: number): Frame {
  return generationDimensions(longEdge, width, height);
}

export interface Sides {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Outpaint plan in source pixels: the grown canvas and where the original sits inside it. */
export function outpaintPlan(width: number, height: number, sides: Sides) {
  const clamp = (v: number) => Math.max(0, Math.min(2, v));
  const left = Math.round(width * clamp(sides.left)),
    right = Math.round(width * clamp(sides.right)),
    top = Math.round(height * clamp(sides.top)),
    bottom = Math.round(height * clamp(sides.bottom));
  return {
    width: width + left + right,
    height: height + top + bottom,
    offsetX: left,
    offsetY: top,
  };
}

/**
 * Where an outpainted result goes on the canvas. Works in the layer's own (rotated, flipped)
 * frame, so the original part of the result lands exactly over the source layer.
 */
export function placeOutpaint(
  layer: Pick<Layer, "x" | "y" | "width" | "height" | "rotation" | "flipX" | "flipY">,
  asset: { width: number; height: number },
  plan: ReturnType<typeof outpaintPlan>,
) {
  const sx = layer.width / asset.width,
    sy = layer.height / asset.height;
  const width = plan.width * sx,
    height = plan.height * sy;
  // Offset between centres, in the layer's local frame (flips mirror it).
  let dx = (plan.width / 2 - plan.offsetX - asset.width / 2) * sx;
  let dy = (plan.height / 2 - plan.offsetY - asset.height / 2) * sy;
  if (layer.flipX) dx = -dx;
  if (layer.flipY) dy = -dy;
  const a = ((layer.rotation || 0) * Math.PI) / 180;
  const cx = layer.x + layer.width / 2 + dx * Math.cos(a) - dy * Math.sin(a);
  const cy = layer.y + layer.height / 2 + dx * Math.sin(a) + dy * Math.cos(a);
  return { x: cx - width / 2, y: cy - height / 2, width, height };
}

/** Fraction of pixels marked for regeneration in an engine mask (white = regenerate). */
export function markedFraction(engineMask: Uint8ClampedArray) {
  let marked = 0;
  for (let i = 0; i < engineMask.length; i += 4) if (engineMask[i] > 127) marked++;
  return marked / (engineMask.length / 4);
}

// Browser canvas helpers ----------------------------------------------------------------------

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

function canvas(width: number, height: number) {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
}

async function load(src: string) {
  const image = new Image();
  image.src = src;
  await image.decode();
  return image;
}

function bytes(data: string) {
  return Math.floor((data.length - data.indexOf(",") - 1) * 0.75);
}

function encode(c: HTMLCanvasElement, keepAlpha: boolean) {
  const data = keepAlpha ? c.toDataURL("image/png") : c.toDataURL("image/jpeg", 0.95);
  if (bytes(data) <= MAX_UPLOAD_BYTES) return data;
  const smaller = c.toDataURL("image/jpeg", 0.85);
  if (!keepAlpha && bytes(smaller) <= MAX_UPLOAD_BYTES) return smaller;
  throw Error("This image is too large to send at this quality. Choose a smaller edit size.");
}

function hasAlpha(c: HTMLCanvasElement) {
  const d = c.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 255) return true;
  return false;
}

/**
 * The source as the engine sees it, at the engine frame. For outpaint the original is placed
 * inside the grown canvas and the new margin is pre-filled with a blurred stretch of the image,
 * which gives the model colour context (the margin is fully regenerated anyway).
 */
export async function engineSource(
  asset: Asset,
  frame: Frame,
  plan?: ReturnType<typeof outpaintPlan>,
  transparent = false,
) {
  const image = await load(asset.data);
  const c = canvas(frame.width, frame.height);
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = "high";
  if (plan) {
    // Separate x/y scales: the frame is rounded to multiples of 32.
    const sx = frame.width / plan.width,
      sy = frame.height / plan.height;
    if (!transparent) {
      ctx.filter = "blur(24px)";
      ctx.drawImage(image, 0, 0, frame.width, frame.height);
      ctx.filter = "none";
    }
    ctx.drawImage(image, plan.offsetX * sx, plan.offsetY * sy, asset.width * sx, asset.height * sy);
  } else ctx.drawImage(image, 0, 0, frame.width, frame.height);
  return encode(c, transparent || hasAlpha(c));
}

/** Engine mask from a painted area asset (hidden = marked): white = regenerate. */
export async function engineMaskFromArea(area: Asset, frame: Frame) {
  const image = await load(area.data);
  const c = canvas(frame.width, frame.height);
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(image, 0, 0, frame.width, frame.height);
  const pixels = ctx.getImageData(0, 0, frame.width, frame.height);
  const d = pixels.data;
  for (let i = 0; i < d.length; i += 4) {
    const marked = 255 - d[i + 3];
    d[i] = d[i + 1] = d[i + 2] = marked > 127 ? 255 : 0;
    d[i + 3] = 255;
  }
  ctx.putImageData(pixels, 0, 0);
  return { data: c.toDataURL("image/png"), fraction: markedFraction(d) };
}

/**
 * Engine mask for outpaint: the new margin plus a thin band inside the original edge, so the
 * seam is regenerated and blends. `band` is in engine pixels.
 */
export function engineMaskForOutpaint(
  frame: Frame,
  plan: ReturnType<typeof outpaintPlan>,
  sourceWidth: number,
  sourceHeight: number,
  band = 16,
) {
  const c = canvas(frame.width, frame.height);
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, frame.width, frame.height);
  const sx = frame.width / plan.width,
    sy = frame.height / plan.height;
  const x = plan.offsetX * sx,
    y = plan.offsetY * sy,
    w = sourceWidth * sx,
    h = sourceHeight * sy;
  // Only grown edges get a blending band; edges that did not grow stay untouched.
  const left = plan.offsetX > 0 ? band : 0,
    top = plan.offsetY > 0 ? band : 0,
    right = plan.width - plan.offsetX - sourceWidth > 0 ? band : 0,
    bottom = plan.height - plan.offsetY - sourceHeight > 0 ? band : 0;
  ctx.fillStyle = "black";
  ctx.fillRect(x + left, y + top, w - left - right, h - top - bottom);
  return c.toDataURL("image/png");
}

/** Turns an engine mask (white = regenerated) into a layer mask asset at the result's size. */
export async function layerMaskFromEngineMask(engineMask: string, width: number, height: number) {
  const image = await load(engineMask);
  const c = canvas(width, height);
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(image, 0, 0, width, height);
  const pixels = ctx.getImageData(0, 0, width, height);
  const d = pixels.data;
  for (let i = 0; i < d.length; i += 4) {
    const visible = d[i];
    d[i] = d[i + 1] = d[i + 2] = 255;
    d[i + 3] = visible;
  }
  ctx.putImageData(pixels, 0, 0);
  return { data: c.toDataURL("image/png"), width, height };
}

/** An empty area (nothing marked) at the asset's size: fully visible, white. */
export function emptyArea(width: number, height: number) {
  const c = canvas(width, height);
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, width, height);
  return { data: c.toDataURL("image/png"), width, height };
}
