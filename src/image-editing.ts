import { floodRegion } from "./paint.ts";
/** Pixel-space operations shared by the editor and its browser checks. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  ellipse?: boolean;
  inverted?: boolean;
  points?: [number, number][];
  /** Soft edge width in image pixels; 0 or absent keeps a hard outline. */
  feather?: number;
}
export type EditOperation =
  | {
      type: "bucket";
      x: number;
      y: number;
      color: string;
      tolerance: number;
      contiguous: boolean;
      opacity: number;
      selection?: Rect;
    }
  | {
      type: "gradient";
      from: [number, number];
      to: [number, number];
      color: string;
      endColor: string;
      transparent: boolean;
      radial: boolean;
      opacity: number;
      selection?: Rect;
    }
  | {
      type: "shape";
      from: [number, number];
      to: [number, number];
      shape: "rectangle" | "ellipse" | "line";
      color: string;
      filled: boolean;
      size: number;
      opacity: number;
      selection?: Rect;
    }
  | { type: "crop"; rect: Rect }
  | { type: "rotate"; clockwise: boolean }
  | { type: "flip"; horizontal: boolean }
  | { type: "resize"; width: number; height: number }
  | {
      type: "adjust";
      brightness: number;
      contrast: number;
      saturation: number;
      selection?: Rect;
    }
  | { type: "fill"; selection: Rect; color: string; erase: boolean }
  | {
      type: "stroke";
      points: [number, number][];
      size: number;
      color: string;
      opacity: number;
      erase: boolean;
      /** 1 = hard edge, 0 = softest falloff. Absent means hard (older sessions). */
      hardness?: number;
      selection?: Rect;
    }
  | {
      type: "text";
      x: number;
      y: number;
      text: string;
      size: number;
      color: string;
    };

export function clampRect(
  a: { x: number; y: number },
  b: { x: number; y: number },
  width: number,
  height: number,
): Rect {
  const x = Math.max(0, Math.min(width, Math.round(Math.min(a.x, b.x))));
  const y = Math.max(0, Math.min(height, Math.round(Math.min(a.y, b.y))));
  return {
    x,
    y,
    width: Math.max(0, Math.min(width, Math.round(Math.max(a.x, b.x))) - x),
    height: Math.max(0, Math.min(height, Math.round(Math.max(a.y, b.y))) - y),
  };
}
export function validatePixelSize(width: number, height: number) {
  if (
    ![width, height].every(
      (v) => Number.isInteger(v) && v >= 16 && v <= 16384,
    ) ||
    width * height > 16_000_000
  )
    throw Error(
      "Use whole-pixel dimensions of at least 16 px, up to 16 megapixels and 16,384 px per side.",
    );
}
function surface(width: number, height: number) {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
}
export function selectionPath(ctx: CanvasRenderingContext2D, rect: Rect) {
  if (rect.points?.length) {
    ctx.moveTo(...rect.points[0]);
    rect.points.slice(1).forEach((p) => ctx.lineTo(...p));
    ctx.closePath();
  } else if (rect.ellipse) {
    // Start a separate subpath so inverted ellipses don't connect to the outer box.
    ctx.moveTo(rect.x + rect.width, rect.y + rect.height / 2);
    ctx.ellipse(
      rect.x + rect.width / 2,
      rect.y + rect.height / 2,
      rect.width / 2,
      rect.height / 2,
      0,
      0,
      Math.PI * 2,
    );
  } else ctx.rect(rect.x, rect.y, rect.width, rect.height);
}
export function polygonSelection(points: [number, number][]): Rect {
  const xs = points.map((p) => p[0]),
    ys = points.map((p) => p[1]);
  const x = Math.floor(Math.min(...xs)),
    y = Math.floor(Math.min(...ys));
  return {
    x,
    y,
    width: Math.ceil(Math.max(...xs)) - x,
    height: Math.ceil(Math.max(...ys)) - y,
    points: points.map((p) => [...p]),
  };
}
function clipSelection(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  width: number,
  height: number,
) {
  ctx.beginPath();
  if (rect.inverted) ctx.rect(0, 0, width, height);
  selectionPath(ctx, rect);
  ctx.clip("evenodd");
}
export const MAX_FEATHER = 250;
export function isSoft(rect?: Rect): rect is Rect {
  return !!rect && (rect.feather ?? 0) > 0;
}
/**
 * Gaussian-softens an alpha surface. Edge pixels are replicated before blurring so a
 * shape touching the image border stays solid there instead of fading to transparency.
 * `radius` is the half-width of the soft transition in pixels (sigma = radius / 2).
 */
export function featherAlpha(source: HTMLCanvasElement, radius: number) {
  const { width, height } = source;
  if (!(radius > 0)) return source;
  const sigma = Math.min(MAX_FEATHER, radius) / 2,
    pad = Math.ceil(sigma * 3) + 2;
  const padded = surface(width + pad * 2, height + pad * 2),
    p = padded.getContext("2d")!;
  p.imageSmoothingEnabled = false;
  p.drawImage(source, pad, pad);
  const edge = (
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
  ) => p.drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh);
  const r = width - 1,
    b = height - 1;
  edge(0, 0, 1, height, 0, pad, pad, height);
  edge(r, 0, 1, height, pad + width, pad, pad, height);
  edge(0, 0, width, 1, pad, 0, width, pad);
  edge(0, b, width, 1, pad, pad + height, width, pad);
  edge(0, 0, 1, 1, 0, 0, pad, pad);
  edge(r, 0, 1, 1, pad + width, 0, pad, pad);
  edge(0, b, 1, 1, 0, pad + height, pad, pad);
  edge(r, b, 1, 1, pad + width, pad + height, pad, pad);
  const blurred = surface(padded.width, padded.height),
    bctx = blurred.getContext("2d")!;
  bctx.filter = `blur(${sigma}px)`;
  bctx.drawImage(padded, 0, 0);
  const out = surface(width, height);
  out
    .getContext("2d")!
    .drawImage(blurred, pad, pad, width, height, 0, 0, width, height);
  return out;
}
const alphaCache = new Map<string, HTMLCanvasElement>();
/** White-on-transparent coverage of a (possibly feathered or inverted) selection. Read-only. */
export function selectionAlpha(rect: Rect, width: number, height: number) {
  const key = `${width}x${height}|${JSON.stringify(rect)}`;
  const cached = alphaCache.get(key);
  if (cached) return cached;
  let shape = surface(width, height);
  const ctx = shape.getContext("2d")!;
  ctx.fillStyle = "white";
  ctx.beginPath();
  selectionPath(ctx, rect);
  ctx.fill();
  shape = featherAlpha(shape, rect.feather ?? 0);
  if (rect.inverted) {
    const inverse = surface(width, height),
      ictx = inverse.getContext("2d")!;
    ictx.fillStyle = "white";
    ictx.fillRect(0, 0, width, height);
    ictx.globalCompositeOperation = "destination-out";
    ictx.drawImage(shape, 0, 0);
    shape = inverse;
  }
  alphaCache.set(key, shape);
  while (alphaCache.size > 3)
    alphaCache.delete(alphaCache.keys().next().value!);
  return shape;
}
/** Soft brush geometry: a hard core plus a Gaussian falloff reaching the full size. */
export function brushProfile(size: number, hardness = 1) {
  const h = Math.max(0, Math.min(1, hardness)),
    radius = size / 2;
  return { core: size * ((1 + h) / 2), sigma: (radius * (1 - h)) / 4 };
}
function drawStrokePath(
  ctx: CanvasRenderingContext2D,
  points: [number, number][],
  width: number,
) {
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  if (points.length === 1) {
    ctx.arc(points[0][0], points[0][1], width / 2, 0, Math.PI * 2);
    ctx.fill();
  } else if (points.length) {
    ctx.moveTo(...points[0]);
    points.slice(1).forEach((p) => ctx.lineTo(...p));
    ctx.stroke();
  }
}
/** Composites a full-strength effect surface through a soft selection. */
function throughSelection(
  target: HTMLCanvasElement,
  effect: HTMLCanvasElement,
  offsetX: number,
  offsetY: number,
  selection: Rect | undefined,
  erase: boolean,
  opacity: number,
) {
  const ctx = target.getContext("2d")!;
  if (isSoft(selection)) {
    const ectx = effect.getContext("2d")!;
    ectx.globalCompositeOperation = "destination-in";
    ectx.drawImage(
      selectionAlpha(selection, target.width, target.height),
      -offsetX,
      -offsetY,
    );
  }
  ctx.save();
  if (selection && !isSoft(selection))
    clipSelection(ctx, selection, target.width, target.height);
  ctx.globalAlpha = opacity;
  ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
  ctx.drawImage(effect, offsetX, offsetY);
  ctx.restore();
}
function softStroke(
  source: HTMLCanvasElement,
  op: Extract<EditOperation, { type: "stroke" }>,
) {
  if (!op.points.length) return;
  const { core, sigma } = brushProfile(op.size, op.hardness);
  const reach = op.size / 2 + sigma * 2 + 2;
  const xs = op.points.map((p) => p[0]),
    ys = op.points.map((p) => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs) - reach)),
    y0 = Math.max(0, Math.floor(Math.min(...ys) - reach)),
    x1 = Math.min(source.width, Math.ceil(Math.max(...xs) + reach)),
    y1 = Math.min(source.height, Math.ceil(Math.max(...ys) + reach));
  if (x1 <= x0 || y1 <= y0) return;
  const effect = surface(x1 - x0, y1 - y0),
    ctx = effect.getContext("2d")!;
  ctx.translate(-x0, -y0);
  ctx.strokeStyle = ctx.fillStyle = op.color;
  if (sigma > 0.05) ctx.filter = `blur(${sigma}px)`;
  drawStrokePath(ctx, op.points, core);
  throughSelection(source, effect, x0, y0, op.selection, op.erase, op.opacity);
}
export function applyOperation(
  source: HTMLCanvasElement,
  op: EditOperation,
): HTMLCanvasElement {
  if (op.type === "bucket" || op.type === "gradient" || op.type === "shape") {
    const effect = surface(source.width, source.height),
      ctx = effect.getContext("2d")!;
    ctx.fillStyle = ctx.strokeStyle = op.color;
    if (op.type === "bucket") {
      const data = source
        .getContext("2d")!
        .getImageData(0, 0, source.width, source.height);
      const selectionData = op.selection
        ? selectionAlpha(op.selection, source.width, source.height)
            .getContext("2d")!
            .getImageData(0, 0, source.width, source.height).data
        : undefined;
      const region = floodRegion(
        data.data,
        source.width,
        source.height,
        op.x,
        op.y,
        op.tolerance,
        op.contiguous,
        selectionData,
      );
      const alpha = ctx.createImageData(source.width, source.height);
      for (let i = 0; i < region.length; i++) alpha.data[i * 4 + 3] = region[i];
      ctx.putImageData(alpha, 0, 0);
      ctx.globalCompositeOperation = "source-in";
      ctx.fillRect(0, 0, source.width, source.height);
      ctx.globalCompositeOperation = "source-over";
    } else if (op.type === "gradient") {
      const distance = Math.hypot(op.to[0] - op.from[0], op.to[1] - op.from[1]);
      if (distance < 0.5) return source;
      const gradient = op.radial
        ? ctx.createRadialGradient(...op.from, 0, ...op.from, distance)
        : ctx.createLinearGradient(...op.from, ...op.to);
      gradient.addColorStop(0, op.color);
      gradient.addColorStop(1, op.transparent ? `${op.color}00` : op.endColor);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, source.width, source.height);
    } else {
      ctx.lineWidth = op.size;
      ctx.lineCap = "round";
      ctx.beginPath();
      const x = Math.min(op.from[0], op.to[0]),
        y = Math.min(op.from[1], op.to[1]);
      const w = Math.abs(op.to[0] - op.from[0]),
        h = Math.abs(op.to[1] - op.from[1]);
      if (op.shape === "line") {
        ctx.moveTo(...op.from);
        ctx.lineTo(...op.to);
      } else if (op.shape === "ellipse")
        ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      else ctx.rect(x, y, w, h);
      if (op.filled && op.shape !== "line") ctx.fill();
      else ctx.stroke();
    }
    throughSelection(source, effect, 0, 0, op.selection, false, op.opacity);
    return source;
  }
  if (op.type === "fill" && isSoft(op.selection)) {
    const effect = surface(source.width, source.height),
      ectx = effect.getContext("2d")!;
    ectx.fillStyle = op.color;
    ectx.fillRect(0, 0, source.width, source.height);
    throughSelection(source, effect, 0, 0, op.selection, op.erase, 1);
    return source;
  }
  if (
    op.type === "stroke" &&
    ((op.hardness ?? 1) < 1 || isSoft(op.selection))
  ) {
    softStroke(source, op);
    return source;
  }
  if (op.type === "adjust" && isSoft(op.selection)) {
    const { width, height } = source;
    const mask = selectionAlpha(op.selection, width, height);
    const adjusted = surface(width, height),
      actx = adjusted.getContext("2d")!;
    actx.filter = `brightness(${op.brightness}%) contrast(${op.contrast}%) saturate(${op.saturation}%)`;
    actx.drawImage(source, 0, 0);
    actx.filter = "none";
    actx.globalCompositeOperation = "destination-in";
    actx.drawImage(mask, 0, 0);
    // Premultiplied lerp: source × (1 − coverage) + adjusted × coverage.
    const c = surface(width, height),
      ctx = c.getContext("2d")!;
    ctx.drawImage(source, 0, 0);
    ctx.globalCompositeOperation = "destination-out";
    ctx.drawImage(mask, 0, 0);
    ctx.globalCompositeOperation = "lighter";
    ctx.drawImage(adjusted, 0, 0);
    return c;
  }
  if (op.type === "stroke" || op.type === "text" || op.type === "fill") {
    const ctx = source.getContext("2d")!;
    ctx.save();
    if (op.type === "fill") {
      clipSelection(ctx, op.selection, source.width, source.height);
      ctx.globalCompositeOperation = op.erase
        ? "destination-out"
        : "source-over";
      ctx.fillStyle = op.color;
      ctx.fillRect(0, 0, source.width, source.height);
    } else if (op.type === "text") {
      ctx.fillStyle = op.color;
      ctx.font = `${op.size}px sans-serif`;
      ctx.textBaseline = "top";
      op.text
        .split("\n")
        .forEach((line, i) =>
          ctx.fillText(line, op.x, op.y + i * op.size * 1.2),
        );
    } else {
      if (op.selection) {
        clipSelection(ctx, op.selection, source.width, source.height);
      }
      ctx.globalCompositeOperation = op.erase
        ? "destination-out"
        : "source-over";
      ctx.globalAlpha = op.opacity;
      ctx.strokeStyle = op.color;
      ctx.fillStyle = op.color;
      ctx.lineWidth = op.size;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      if (op.points.length === 1) {
        ctx.beginPath();
        ctx.arc(op.points[0][0], op.points[0][1], op.size / 2, 0, Math.PI * 2);
        ctx.fill();
      } else if (op.points.length) {
        ctx.beginPath();
        ctx.moveTo(...op.points[0]);
        op.points.slice(1).forEach((p) => ctx.lineTo(...p));
        ctx.stroke();
      }
    }
    ctx.restore();
    return source;
  }
  let width = source.width,
    height = source.height;
  if (op.type === "rotate") [width, height] = [height, width];
  if (op.type === "crop") {
    width = op.rect.width;
    height = op.rect.height;
  }
  if (op.type === "resize") {
    validatePixelSize(op.width, op.height);
    width = op.width;
    height = op.height;
  }
  if (width < 1 || height < 1) throw Error("Select an area to crop first.");
  const c = surface(width, height),
    ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  if (op.type === "crop") {
    const r = op.rect;
    ctx.translate(-r.x, -r.y);
    clipSelection(ctx, { ...r, inverted: false }, source.width, source.height);
    ctx.drawImage(source, 0, 0);
  } else if (op.type === "rotate") {
    ctx.translate(width / 2, height / 2);
    ctx.rotate(((op.clockwise ? 1 : -1) * Math.PI) / 2);
    ctx.drawImage(source, -source.width / 2, -source.height / 2);
  } else if (op.type === "flip") {
    ctx.translate(op.horizontal ? width : 0, op.horizontal ? 0 : height);
    ctx.scale(op.horizontal ? -1 : 1, op.horizontal ? 1 : -1);
    ctx.drawImage(source, 0, 0);
  } else if (op.type === "adjust") {
    if (op.selection) {
      ctx.drawImage(source, 0, 0);
      clipSelection(ctx, op.selection, width, height);
      ctx.clearRect(0, 0, width, height);
    }
    ctx.filter = `brightness(${op.brightness}%) contrast(${op.contrast}%) saturate(${op.saturation}%)`;
    ctx.drawImage(source, 0, 0);
  } else ctx.drawImage(source, 0, 0, width, height);
  return c;
}
export function renderEdits(
  image: HTMLImageElement,
  operations: EditOperation[],
) {
  let c = surface(image.naturalWidth, image.naturalHeight);
  c.getContext("2d")!.drawImage(image, 0, 0);
  for (const op of operations) c = applyOperation(c, op);
  return c;
}
