import { bounds, visible, type Project, type Layer } from "./model.ts";
import { notePalette } from "./operations.ts";
import { renderTextLayer } from "./typography.ts";
import { effectiveMask, loadAssetImage, maskedImage } from "./masking.ts";
import { adjustmentFilter } from "./adjustments.ts";
import { drawFrame, loadVideo, seek, videoURL } from "./video.ts";
export interface ExportOptions {
  scale?: number;
  background?: "transparent" | "white" | "dark";
  padding?: number;
}
export function nativeExportScale(project: Project, selection?: Set<string>) {
  const scales = project.layers
    .filter(
      (l) =>
        visible(project, l) && l.assetId && (!selection || selection.has(l.id)),
    )
    .map((l) =>
      Math.max(
        project.assets[l.assetId!].width / l.width,
        project.assets[l.assetId!].height / l.height,
      ),
    );
  return scales.length ? Math.max(...scales) : 1;
}
export async function exportPNG(
  project: Project,
  selection?: Set<string>,
  options: ExportOptions = {},
) {
  const layers = project.layers.filter(
    (l) =>
      visible(project, l) &&
      l.kind !== "mask" &&
      (!selection || selection.has(l.id)),
  );
  const b = bounds(layers);
  if (!b) throw Error("There are no visible layers to export.");
  const scale = options.scale ?? 1,
    padding = options.padding ?? 0;
  const width = Math.ceil((b.width + padding * 2) * scale),
    height = Math.ceil((b.height + padding * 2) * scale);
  if (width > 16384 || height > 16384 || width * height > 64000000)
    throw Error(
      "Composition is too large. Move layers closer together or export a selection.",
    );
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.scale(scale, scale);
  // Composite layers on transparency first, matching the isolated canvas world.
  ctx.translate(padding, padding);
  for (const l of layers) {
    ctx.save();
    ctx.globalAlpha = l.opacity ?? 1;
    ctx.globalCompositeOperation =
      l.blendMode && l.blendMode !== "normal" ? l.blendMode : "source-over";
    ctx.translate(l.x - b.x + l.width / 2, l.y - b.y + l.height / 2);
    ctx.rotate(((l.rotation || 0) * Math.PI) / 180);
    ctx.scale(l.flipX ? -1 : 1, l.flipY ? -1 : 1);
    const x = -l.width / 2,
      y = -l.height / 2;
    if (l.assetId) {
      const img = new Image();
      img.src = project.assets[l.assetId].data;
      await img.decode();
      // Same order as the DOM canvas: adjustments (colour only), then the refined mask.
      let source: HTMLImageElement | HTMLCanvasElement = img;
      if (l.layerMask?.enabled) {
        const mask = await loadAssetImage(project.assets[l.layerMask.assetId]);
        source = maskedImage(
          img,
          effectiveMask(mask, img.naturalWidth, img.naturalHeight, l.layerMask),
        );
      }
      ctx.filter = adjustmentFilter(l.adjustments);
      ctx.imageSmoothingEnabled = !l.pixelated;
      ctx.drawImage(source, x, y, l.width, l.height);
      ctx.imageSmoothingEnabled = true;
      ctx.filter = "none";
    } else if (l.kind === "video" && l.videoId && project.videos[l.videoId]) {
      // A still: the first frame (export a frame you like with “Current frame → image”).
      const v = project.videos[l.videoId];
      try {
        const video = await loadVideo(videoURL(v.id, v.data));
        await seek(video, 0);
        ctx.drawImage(drawFrame(video), x, y, l.width, l.height);
      } catch {
        // A video this browser cannot decode is left out of the PNG rather than failing it.
      }
    } else if (l.kind === "text") {
      ctx.drawImage(
        renderTextLayer(l, Math.max(1, scale)),
        x,
        y,
        l.width,
        l.height,
      );
    } else {
      // Flatten card background and text before opacity/blend, like the DOM layer.
      const card = document.createElement("canvas");
      card.width = Math.ceil(l.width);
      card.height = Math.ceil(l.height);
      drawCard(card.getContext("2d")!, l, 0, 0);
      ctx.drawImage(card, x, y, l.width, l.height);
    }
    ctx.restore();
  }
  if (options.background && options.background !== "transparent") {
    ctx.resetTransform();
    ctx.globalCompositeOperation = "destination-over";
    ctx.fillStyle = options.background === "white" ? "#ffffff" : "#171b18";
    ctx.fillRect(0, 0, width, height);
  }
  return new Promise<Blob>((resolve, reject) =>
    c.toBlob(
      (blob) => (blob ? resolve(blob) : reject(Error("Could not export PNG."))),
      "image/png",
    ),
  );
}
function drawCard(
  ctx: CanvasRenderingContext2D,
  l: Layer,
  x: number,
  y: number,
) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, l.width, l.height);
  ctx.clip();
  const palette = notePalette[l.noteColor || "sage"];
  ctx.fillStyle = l.kind === "note" ? palette[0] : "#28362a";
  ctx.fillRect(x, y, l.width, l.height);
  ctx.fillStyle = l.kind === "note" ? palette[1] : "#d5e3bb";
  ctx.font = "10px sans-serif";
  ctx.fillText(
    l.kind === "note" ? "FIELD NOTE" : "GENERATION IDEA",
    x + 20,
    y + 28,
  );
  ctx.font = "16px sans-serif";
  let line = "",
    yy = y + 59;
  for (const paragraph of (l.text || "").split("\n")) {
    for (const word of paragraph.split(" ")) {
      if (ctx.measureText(line + word).width > l.width - 40 && line) {
        ctx.fillText(line, x + 20, yy);
        yy += 23;
        line = "";
      }
      for (const char of word + " ") {
        if (ctx.measureText(line + char).width > l.width - 40) {
          ctx.fillText(line, x + 20, yy);
          yy += 23;
          line = "";
        }
        line += char;
      }
    }
    ctx.fillText(line, x + 20, yy);
    yy += 23;
    line = "";
  }
  ctx.restore();
}
