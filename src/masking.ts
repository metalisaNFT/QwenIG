import type { Asset, Layer } from "./model.ts";
import {
  applyOperation,
  featherAlpha,
  type EditOperation,
} from "./image-editing.ts";

export async function loadAssetImage(asset: Asset) {
  const image = new Image();
  image.src = asset.data;
  await image.decode();
  return image;
}
type MaskSource = HTMLImageElement | HTMLCanvasElement;
const sizeOf = (s: MaskSource) =>
  s instanceof HTMLImageElement
    ? { width: s.naturalWidth, height: s.naturalHeight }
    : { width: s.width, height: s.height };

/** Alpha masks stay separate from source pixels and follow local image geometry. */
export function maskSurface(image: MaskSource, mask?: MaskSource) {
  const c = document.createElement("canvas");
  ({ width: c.width, height: c.height } = sizeOf(image));
  const ctx = c.getContext("2d")!;
  if (mask) ctx.drawImage(mask, 0, 0, c.width, c.height);
  else {
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, c.width, c.height);
  }
  return c;
}

export function maskedImage(image: MaskSource, mask: MaskSource) {
  const c = maskSurface(image, mask);
  const ctx = c.getContext("2d")!;
  ctx.globalCompositeOperation = "source-in";
  ctx.drawImage(image, 0, 0);
  return c;
}

export type MaskSettings = Pick<
  NonNullable<Layer["layerMask"]>,
  "feather" | "density"
>;
/** Feather and density are live mask properties: the stored mask asset never changes. */
export function isRefined(settings?: MaskSettings) {
  return (settings?.feather ?? 0) > 0 || (settings?.density ?? 1) < 1;
}
/**
 * The mask as displayed and exported: optionally feathered (Gaussian, in mask pixels),
 * then density lifts hidden areas (density 0.6 keeps at least 40% visible everywhere).
 */
export function effectiveMask(
  mask: MaskSource,
  width: number,
  height: number,
  settings?: MaskSettings,
) {
  let c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  c.getContext("2d")!.drawImage(mask, 0, 0, width, height);
  c = featherAlpha(c, settings?.feather ?? 0);
  const density = settings?.density ?? 1;
  if (density < 1) {
    const out = document.createElement("canvas");
    out.width = width;
    out.height = height;
    const ctx = out.getContext("2d")!;
    ctx.globalAlpha = 1 - density;
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, width, height);
    ctx.globalAlpha = 1;
    ctx.drawImage(c, 0, 0);
    c = out;
  }
  return c;
}

const refined = new Map<string, string>(); // key → blob URL (LRU order)
const latestForAsset = new Map<string, string>(); // assetId → last ready URL
const pending = new Map<string, string>(); // assetId → key being computed
const wanted = new Map<string, { asset: Asset; settings: MaskSettings }>();
const refinedKey = (asset: Asset, s: MaskSettings) =>
  `${asset.id}|${s.feather ?? 0}|${s.density ?? 1}`;
/**
 * URL of the refined mask for CSS `mask-image`. Computed asynchronously and cached;
 * until ready, the most recent refinement of the same mask (or the raw mask) is returned
 * and `onReady` fires once the requested version exists.
 */
export function refinedMaskURL(
  asset: Asset,
  settings: MaskSettings,
  onReady: () => void,
): string {
  if (!isRefined(settings)) return asset.data;
  const key = refinedKey(asset, settings);
  const ready = refined.get(key);
  if (ready) {
    wanted.delete(asset.id);
    refined.delete(key);
    refined.set(key, ready);
    return ready;
  }
  wanted.set(asset.id, { asset, settings });
  if (!pending.has(asset.id)) void compute(asset.id, onReady);
  return latestForAsset.get(asset.id) ?? asset.data;
}
async function compute(assetId: string, onReady: () => void) {
  const job = wanted.get(assetId);
  if (!job) return;
  wanted.delete(assetId);
  const key = refinedKey(job.asset, job.settings);
  pending.set(assetId, key);
  try {
    const image = await loadAssetImage(job.asset);
    const canvas = effectiveMask(
      image,
      image.naturalWidth,
      image.naturalHeight,
      job.settings,
    );
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    if (blob) {
      const url = URL.createObjectURL(blob);
      refined.set(key, url);
      latestForAsset.set(assetId, url);
      while (refined.size > 24) {
        const [oldKey, oldUrl] = refined.entries().next().value!;
        refined.delete(oldKey);
        if (![...latestForAsset.values()].includes(oldUrl))
          URL.revokeObjectURL(oldUrl);
      }
    }
  } finally {
    pending.delete(assetId);
  }
  // A newer request arrived while this one ran (e.g. dragging the feather slider).
  if (wanted.has(assetId)) void compute(assetId, onReady);
  else onReady();
}

export function transformMask(
  mask: HTMLImageElement,
  source: HTMLImageElement,
  operations: EditOperation[],
) {
  let c = maskSurface(source, mask);
  for (const op of operations)
    if (["crop", "rotate", "flip", "resize"].includes(op.type))
      c = applyOperation(c, op);
  return { data: c.toDataURL("image/png"), width: c.width, height: c.height };
}
