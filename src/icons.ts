const paths: Record<string, string> = {
  select: "M5 3l13 9-7 1-3 7z",
  hand: "M8 12V7a2 2 0 0 1 4 0v5-7a2 2 0 0 1 4 0v8-5a2 2 0 0 1 4 0v8c0 5-3 7-7 7-3 0-5-2-7-5l-3-4a2 2 0 0 1 3-2l2 2",
  note: "M4 3h16v18H4zM8 8h8M8 12h8M8 16h5",
  text: "M5 4h14M12 4v16M8 20h8",
  image: "M3 4h18v16H3zM3 16l5-5 4 4 4-6 5 7M8 8h.01",
  idea: "M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z",
  mask: "M12 3a9 9 0 1 0 0 18zM12 3a9 9 0 0 1 0 18M15 5v14M18 7v10",
  paint: "M4 3h16v18H4zM8 12h8M12 8v8",
  eyedropper: "M14 4l6 6M16 2l6 6-4 4-6-6zM13 7L3 17v4h4L17 11",
  bucket:
    "M9 3l9 9-8 8-8-8 8-8M2 12h16M20 16c0 0-3 3-3 5a3 3 0 0 0 6 0c0-2-3-5-3-5",
  gradient: "M3 4h18v16H3zM6 4v16M9 4v16M12 4v16M15 4v16",
  shape: "M3 3h13v13H3zM16 9a6 6 0 1 1-7 7",
  brush: "M18 3l3 3-9 9-3-3zM9 12c-3 0-5 2-5 5 0 2-1 3-2 4 4 0 9-1 9-6",
  eraser: "M8 20h12M5 15l9-9 5 5-9 9H8z M10 10l5 5",
};
export function installToolIcons() {
  for (const [selector, name] of [
    ["[data-tool=select]", "select"],
    ["[data-tool=hand]", "hand"],
    ["[data-tool=note]", "note"],
    [".toolbar [data-tool=text]", "text"],
    ["#add-image", "image"],
    ["#add-prompt", "idea"],
    ["#new-paint-layer", "paint"],
    ["#eyedropper-image", "eyedropper"],
    ["#bucket-image", "bucket"],
    ["#gradient-image", "gradient"],
    ["#shape-image", "shape"],
    ["#brush-image", "brush"],
    ["#erase-image", "eraser"],
    ['[aria-label="Mask (planned)"]', "mask"],
  ]) {
    const button = document.querySelector(selector);
    if (!button) continue;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", paths[name]);
    svg.append(path);
    button.replaceChildren(svg);
  }
}
