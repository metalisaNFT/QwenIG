import { defaultTextStyle, type Layer } from "./model.ts";
export function wrapText(
  text: string,
  width: number,
  measure: (text: string) => number,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.match(/\S+\s*|\s+/g) || []) {
      if (line && measure(line + word.trimEnd()) > width) {
        lines.push(line.trimEnd());
        line = "";
      }
      for (const char of word) {
        if (line && measure(line + char) > width) {
          lines.push(line.trimEnd());
          line = "";
        }
        if (line || char.trim()) line += char;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}
/** Canvas and PNG export use the same typesetting, including wrapping and clipping. */
export function renderTextLayer(layer: Layer, density = 2) {
  const style = { ...defaultTextStyle, ...layer.textStyle };
  const scale = Math.min(
    density,
    8192 / Math.max(layer.width, layer.height),
    Math.sqrt(16e6 / (layer.width * layer.height)),
  );
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(layer.width * scale));
  canvas.height = Math.max(1, Math.ceil(layer.height * scale));
  const ctx = canvas.getContext("2d")!;
  ctx.scale(scale, scale);
  ctx.font = `${style.italic ? "italic " : ""}${style.bold ? "700" : "400"} ${style.fontSize}px "${style.fontFamily}"`;
  ctx.fillStyle = style.color;
  ctx.textAlign = style.align;
  ctx.textBaseline = "top";
  const x =
    style.align === "center"
      ? layer.width / 2
      : style.align === "right"
        ? layer.width
        : 0;
  const lines = wrapText(
    layer.text || "",
    layer.width,
    (text) => ctx.measureText(text).width,
  );
  for (const [i, line] of lines.entries()) {
    const y = i * style.fontSize * style.lineHeight;
    if (y >= layer.height) break;
    ctx.fillText(line, x, y);
  }
  return canvas;
}
