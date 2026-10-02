/**
 * Background removal support in the browser: prepare an engine upload and turn the engine's
 * grayscale matte into a Studio Zero layer mask (white RGB, coverage in alpha).
 * The engine owns the model; nothing here pretends to be AI.
 */
import type { Asset } from "./model.ts";
import { loadAssetImage } from "./masking.ts";

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_EDGE = 2048;

export function dataUrlBytes(data: string) {
  const base64 = data.length - data.indexOf(",") - 1;
  return (
    Math.floor(base64 * 0.75) -
    (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0)
  );
}

export function hasTransparency(pixels: Uint8ClampedArray) {
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] < 255) return true;
  return false;
}

/**
 * A copy for the engine: at most 2048 px on the long edge (the model works at 1024 px),
 * JPEG unless transparency must be kept, and always under the 8 MB API limit.
 */
export async function engineUpload(asset: Asset) {
  const image = await loadAssetImage(asset);
  let scale = Math.min(
    1,
    MAX_EDGE / Math.max(image.naturalWidth, image.naturalHeight),
  );
  for (let attempt = 0; attempt < 6; attempt++) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const transparent = hasTransparency(
      ctx.getImageData(0, 0, canvas.width, canvas.height).data,
    );
    const data = transparent
      ? canvas.toDataURL("image/png")
      : canvas.toDataURL("image/jpeg", 0.95);
    if (dataUrlBytes(data) <= MAX_UPLOAD_BYTES)
      return { data, width: canvas.width, height: canvas.height };
    scale *= 0.75;
  }
  throw Error(
    "This image is too large to send. Resize it in the image editor first.",
  );
}

/** Converts a grayscale matte (white = subject) into a mask asset at the image's own size. */
export async function maskFromMatte(
  matte: Blob,
  width: number,
  height: number,
) {
  const url = URL.createObjectURL(matte);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, width, height);
    const pixels = ctx.getImageData(0, 0, width, height);
    const d = pixels.data;
    for (let i = 0; i < d.length; i += 4) {
      const coverage = d[i]; // grayscale: R = G = B
      d[i] = d[i + 1] = d[i + 2] = 255;
      d[i + 3] = coverage;
    }
    ctx.putImageData(pixels, 0, 0);
    return { data: canvas.toDataURL("image/png"), width, height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Swaps hidden and visible areas of a mask asset (keep the background, drop the subject). */
export async function invertMask(mask: Asset) {
  const img = await loadAssetImage(mask);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = pixels.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = d[i + 1] = d[i + 2] = 255;
    d[i + 3] = 255 - d[i + 3];
  }
  ctx.putImageData(pixels, 0, 0);
  return {
    data: canvas.toDataURL("image/png"),
    width: canvas.width,
    height: canvas.height,
  };
}
