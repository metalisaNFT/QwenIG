export function generationDimensions(
  longEdge: number,
  width: number,
  height: number,
) {
  const factor = longEdge / Math.max(width, height);
  return {
    width: Math.max(
      256,
      Math.min(2048, Math.round((width * factor) / 32) * 32),
    ),
    height: Math.max(
      256,
      Math.min(2048, Math.round((height * factor) / 32) * 32),
    ),
  };
}
