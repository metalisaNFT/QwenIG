/**
 * Frame helpers shared by the Animate tab and the frame editor: cached images, canvas ⇄ asset,
 * same-size frames, and engine background removal baked into a frame's alpha.
 */
import type { Asset } from "./model.ts";
import type { StudioService, Task } from "./service.ts";
import { engineUpload, maskFromMatte } from "./background.ts";
import { loadAssetImage } from "./masking.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const images = new Map<string, HTMLImageElement>();
export function assetImage(asset: Asset) {
  let img = images.get(asset.id);
  if (!img || img.src !== asset.data) {
    img = new Image();
    img.src = asset.data;
    images.set(asset.id, img);
  }
  return img;
}
export async function assetCanvas(asset: Asset) {
  const img = await loadAssetImage(asset);
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext("2d")!.drawImage(img, 0, 0);
  return c;
}
export function canvasAsset(c: HTMLCanvasElement): Asset {
  return { id: crypto.randomUUID(), data: c.toDataURL("image/png"), width: c.width, height: c.height };
}
/** Same size for every frame: the largest, each frame standing bottom-centre. */
export function normalize(frames: HTMLCanvasElement[]) {
  const w = Math.max(...frames.map((f) => f.width)),
    hgt = Math.max(...frames.map((f) => f.height));
  return frames.map((f) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = hgt;
    c.getContext("2d")!.drawImage(f, Math.floor((w - f.width) / 2), hgt - f.height);
    return c;
  });
}

/** Ask the engine for a subject matte and bake it into the frame's alpha. */
export async function cutOut(engine: StudioService, asset: Asset, cancelled: () => boolean) {
  const upload = await engineUpload(asset);
  let task: Task = await engine.removeBackground(upload.data);
  const deadline = Date.now() + 10 * 60 * 1000;
  while (task.status === "queued" || task.status === "running") {
    if (cancelled()) {
      void engine.cancelTask(task.id).catch(() => {});
      throw Error("Cancelled.");
    }
    if (Date.now() > deadline) throw Error("Background removal took too long.");
    await sleep(500);
    task = await engine.task(task.id);
  }
  if (task.status !== "succeeded") throw Error(task.message);
  const mask = await maskFromMatte(await engine.taskMask(task.id), asset.width, asset.height);
  const frame = await assetCanvas(asset);
  const ctx = frame.getContext("2d")!;
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(await loadAssetImage({ id: "m", ...mask }), 0, 0);
  return frame;
}

