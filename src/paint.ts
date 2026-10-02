/** Connected colour matching for bucket fills. No canvas dependency. */
export function floodRegion(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  tolerance: number,
  contiguous = true,
  selection?: Uint8ClampedArray,
): Uint8ClampedArray {
  const count = width * height;
  const mask = new Uint8ClampedArray(count);
  x = Math.floor(x);
  y = Math.floor(y);
  if (x < 0 || y < 0 || x >= width || y >= height) return mask;
  const seed = y * width + x,
    start = seed * 4;
  const limit = Math.max(0, Math.min(255, tolerance));
  const matches = (i: number) => {
    if (selection && selection[i * 4 + 3] === 0) return false;
    const p = i * 4;
    // Transparent pixels compare by their visible colour, ignoring hidden RGB.
    const alpha = rgba[p + 3] / 255,
      baseAlpha = rgba[start + 3] / 255;
    return (
      Math.max(
        Math.abs(rgba[p] * alpha - rgba[start] * baseAlpha),
        Math.abs(rgba[p + 1] * alpha - rgba[start + 1] * baseAlpha),
        Math.abs(rgba[p + 2] * alpha - rgba[start + 2] * baseAlpha),
        Math.abs(rgba[p + 3] - rgba[start + 3]),
      ) <= limit
    );
  };
  if (!matches(seed)) return mask;
  if (!contiguous) {
    for (let i = 0; i < count; i++) if (matches(i)) mask[i] = 255;
    return mask;
  }
  const visited = new Uint8Array(count),
    queue = new Int32Array(count);
  let head = 0,
    tail = 0;
  const visit = (i: number) => {
    if (visited[i]) return;
    visited[i] = 1;
    if (matches(i)) {
      mask[i] = 255;
      queue[tail++] = i;
    }
  };
  visit(seed);
  while (head < tail) {
    const i = queue[head++],
      col = i % width;
    if (col > 0) visit(i - 1);
    if (col + 1 < width) visit(i + 1);
    if (i >= width) visit(i - width);
    if (i + width < count) visit(i + width);
  }
  return mask;
}
