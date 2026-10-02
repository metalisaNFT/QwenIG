import type { Layer } from "./model.ts";
export function normalizeAngle(value: number) {
  return ((((value + 180) % 360) + 360) % 360) - 180;
}
function rotation(angle = 0) {
  const radians = (angle * Math.PI) / 180;
  const clean = (v: number) => (Math.abs(v) < 1e-12 ? 0 : v);
  return { c: clean(Math.cos(radians)), s: clean(Math.sin(radians)) };
}
export function layerBounds(layer: Layer) {
  const { c, s } = rotation(layer.rotation);
  const width = Math.abs(c) * layer.width + Math.abs(s) * layer.height;
  const height = Math.abs(s) * layer.width + Math.abs(c) * layer.height;
  return {
    x: layer.x + (layer.width - width) / 2,
    y: layer.y + (layer.height - height) / 2,
    width,
    height,
  };
}
/** Resize along local axes while the rotated top-left corner stays fixed. */
export function resizeFromCorner(layer: Layer, dx: number, dy: number) {
  const { c, s } = rotation(layer.rotation);
  const localX = c * dx + s * dy,
    localY = -s * dx + c * dy;
  const factor = Math.max(
    16 / Math.min(layer.width, layer.height),
    Math.min(
      32768 / Math.max(layer.width, layer.height),
      1 + Math.max(localX / layer.width, localY / layer.height),
    ),
  );
  const width = layer.width * factor,
    height = layer.height * factor;
  const dw = (width - layer.width) / 2,
    dh = (height - layer.height) / 2;
  return {
    width,
    height,
    x: layer.x + (c - 1) * dw - s * dh,
    y: layer.y + s * dw + (c - 1) * dh,
  };
}
