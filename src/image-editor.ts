import {
  applyOperation,
  brushProfile,
  clampRect,
  isSoft,
  polygonSelection,
  selectionAlpha,
  selectionPath,
  renderEdits,
  validatePixelSize,
  type EditOperation,
  type Rect,
} from "./image-editing.ts";
import { loadAssetImage, maskSurface } from "./masking.ts";
import { adjustmentFilter, isActive, type Adjustments } from "./adjustments.ts";
import type { Asset } from "./model.ts";

const dialog = document.createElement("dialog");
dialog.className = "image-editor";
dialog.setAttribute("aria-label", "Image editor");
dialog.innerHTML = `
<div class="dialog-heading"><div><span class="eyebrow" data-eyebrow>IMAGE WORKSHOP</span><h2>Edit every detail.</h2><p class="mode-badge" data-mode-badge></p></div><button class="quiet" data-close aria-label="Cancel image editing">✕</button></div>
<div class="editor-layout"><aside class="editor-controls">
  <div class="editor-tools" role="group" aria-label="Editing tools">
    <button data-tool="select" class="active" title="Select (M)">Select / crop</button><button data-tool="brush" title="Brush (B)">Brush</button><button data-tool="erase" title="Eraser (E)">Eraser</button><button data-tool="text" title="Text (T)">Text</button>
    <button data-tool="eyedropper" data-pixel-only title="Eyedropper (I)">Eyedropper</button><button data-tool="bucket" data-pixel-only title="Paint bucket (K)">Paint bucket</button><button data-tool="gradient" data-pixel-only title="Gradient (G)">Gradient</button><button data-tool="shape" data-pixel-only title="Shapes (U)">Shapes</button>
  </div>
  <p class="subtle" data-hint>Drag a selection to crop, fill or clear it. Selections also limit adjustments and strokes.</p>
  <div data-mask-view-options hidden>
    <span class="field-caption">View</span>
    <div class="segmented" role="radiogroup" aria-label="Mask view">
      <button data-mask-view="result" class="active" role="radio" aria-checked="true" title="The layer as it will look">Result</button><button data-mask-view="mask" role="radio" aria-checked="false" title="White is visible, black is hidden">Mask</button><button data-mask-view="overlay" role="radio" aria-checked="false" title="Hidden areas tinted red over the full image">Overlay</button>
    </div>
    <p class="subtle" data-view-hint></p>
  </div>
  <div data-paint-options hidden>
  <div data-pixel-only class="paint-colors"><label>Foreground<input data-color type="color" value="#c9ee91"></label><label>Background<input data-background-color type="color" value="#181b19"></label><button data-swap title="Swap colors (X)" aria-label="Swap foreground and background">⇄</button></div>
  <label data-tool-opacity>Tool opacity <output data-opacity-value>100%</output><input data-opacity type="range" min="1" max="100" value="100" aria-label="Tool opacity"></label>
  <div data-brush-options>
    <label>Brush size<input data-size type="number" min="1" max="512" value="32" aria-label="Brush size"></label>
    <label>Hardness <output data-hardness-value>100%</output><input data-hardness type="range" min="0" max="100" value="100" aria-label="Brush hardness"></label>
    <p class="subtle">Lower hardness for soft edges. <kbd>[</kbd> <kbd>]</kbd> size · Shift + brackets changes hardness. Alt-click samples color.</p>
  </div>
  <div data-text-options hidden>
  <label>Text<textarea data-text rows="2" maxlength="1000" placeholder="Type here, then click the image"></textarea></label>
  <label>Text size<input data-text-size type="number" min="8" max="512" value="64"></label>
  </div>
  <div data-bucket-options hidden><label>Color tolerance<input data-tolerance type="number" min="0" max="255" value="24"></label><label class="check-label"><input data-contiguous type="checkbox" checked> Contiguous pixels only</label></div>
  <div data-gradient-options hidden><label>Gradient style<select data-gradient-style><option value="linear">Linear</option><option value="radial">Radial</option></select></label><label class="check-label"><input data-transparent type="checkbox"> Fade to transparent</label></div>
  <div data-shape-options hidden><label>Shape<select data-draw-shape><option value="rectangle">Rectangle</option><option value="ellipse">Ellipse</option><option value="line">Line</option></select></label><label>Style<select data-shape-style><option value="fill">Filled</option><option value="outline">Outline</option></select></label><label>Stroke width<input data-stroke-width type="number" min="1" max="512" value="8"></label></div>
  </div>
  <div class="editor-divider"></div><span class="eyebrow">SELECTION</span>
  <label>Selection shape<select data-shape aria-label="Selection shape"><option value="rectangle">Rectangle</option><option value="ellipse">Ellipse</option><option value="lasso">Freehand lasso</option></select></label>
  <label>Feather <output data-feather-value>0 px · hard edge</output><input data-feather type="range" min="0" max="150" value="0" aria-label="Selection feather"></label>
  <div class="selection-actions"><button data-select-all title="Ctrl+A">Select all</button><button data-clear disabled title="Ctrl+D">Deselect</button><button data-invert disabled title="Ctrl+Shift+I">Invert selection</button><button data-crop disabled title="Crop uses the selection's hard outline">Crop selection</button><button data-delete-selection disabled>Clear pixels</button><button data-fill disabled>Fill selection</button></div>
  <label data-pixel-only>Fill color<input data-fill-color type="color" value="#c9ee91"></label>
  <div data-pixel-only><div class="editor-divider"></div><span class="eyebrow">TRANSFORM</span>
  <div class="selection-actions"><button data-left>Rotate left</button><button data-right>Rotate right</button><button data-flip-x>Flip horizontal</button><button data-flip-y>Flip vertical</button></div>
  <div class="input-grid"><label>Pixel width<input data-width type="number" min="16" max="16384"></label><label>Pixel height<input data-height type="number" min="16" max="16384"></label></div>
  <label class="check-label"><input data-ratio type="checkbox" checked> Keep proportions</label><button data-resize class="quiet full">Resize pixels</button>
  <p class="subtle">Enlarging resamples existing pixels; it does not add AI detail.</p>
  <div class="editor-divider"></div><span class="eyebrow">ADJUST PIXELS</span>
  <p class="subtle">Baked into this edit and limited by the selection. For changes you can revisit later, use <b>Layers → Adjustments</b>.</p>
  <label>Brightness <output data-brightness-value>100%</output><input data-brightness aria-label="Brightness" type="range" min="0" max="200" value="100"></label>
  <label>Contrast <output data-contrast-value>100%</output><input data-contrast aria-label="Contrast" type="range" min="0" max="200" value="100"></label>
  <label>Saturation <output data-saturation-value>100%</output><input data-saturation aria-label="Saturation" type="range" min="0" max="200" value="100"></label>
  <button data-adjust class="quiet full">Apply adjustments</button></div>
</aside><div class="editor-stage"><p class="editor-note" data-context-note hidden></p><div class="editor-surface"><canvas aria-label="Image editing canvas"></canvas><div class="editor-selection" hidden></div><div class="brush-cursor" hidden><span></span></div></div></div></div>
<div class="editor-footer"><span data-status role="status"></span><div class="editor-actions"><select data-zoom aria-label="Editor zoom"><option value="fit">Fit image</option><option value="1">100%</option><option value="2">200%</option></select><button class="quiet" data-undo>Undo edit</button><button class="quiet" data-redo>Redo edit</button><button class="quiet" data-reset>Reset session</button><button class="quiet" data-save-copy data-pixel-only title="Keep the source layer and add this edit as a separate layer">Keep as new layer</button><button class="primary" data-save>Apply to layer</button></div></div>`;
document.body.append(dialog);
const el = <T extends HTMLElement = HTMLElement>(name: string) =>
  dialog.querySelector<T>(`[data-${name}]`)!;
const input = (name: string) => el<HTMLInputElement>(name);
const preview = dialog.querySelector("canvas")!;
const selectionBox = dialog.querySelector<HTMLElement>(".editor-selection")!;
const cursor = dialog.querySelector<HTMLElement>(".brush-cursor")!;
const lassoOverlay = document.createElement("canvas");
lassoOverlay.className = "lasso-overlay";
lassoOverlay.setAttribute("aria-hidden", "true");
preview.parentElement!.insertBefore(lassoOverlay, selectionBox);
let image: HTMLImageElement;
let maskSource: HTMLImageElement | undefined;
let layerFilter = "none";
let operations: EditOperation[] = [],
  future: EditOperation[] = [];
let pixels: HTMLCanvasElement;
let selection: Rect | undefined;
let activeTool = "select";
let maskView: "result" | "mask" | "overlay" = "result";
/** Marking an area for an AI edit: hidden (black) = marked. Same surface as a layer mask. */
let regionMode = false;
// While the feather slider moves, show the outline only; the soft preview follows on release.
let featherSliding = false;
// Soft edges suit masks; pixel painting starts hard, as before. Each is remembered.
const hardness = { pixels: 100, mask: 60 };
let pointer: {
  id: number;
  start: { x: number; y: number };
  lasso?: [number, number][];
  stroke?: Extract<EditOperation, { type: "stroke" }>;
  draft?: Extract<EditOperation, { type: "gradient" | "shape" }>;
} | null = null;
let save: (
  asset: Omit<Asset, "id">,
  operations: EditOperation[],
  asNewLayer?: boolean,
) => void;
let session = 0;
const mode = () => (maskSource ? "mask" : "pixels");
function surface(width: number, height: number) {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
}
function adjustment(): Extract<EditOperation, { type: "adjust" }> {
  return {
    type: "adjust",
    brightness: +input("brightness").value,
    contrast: +input("contrast").value,
    saturation: +input("saturation").value,
    selection: selection ? { ...selection } : undefined,
  };
}
function hasAdjustment() {
  const a = adjustment();
  return a.brightness !== 100 || a.contrast !== 100 || a.saturation !== 100;
}
function resetAdjustments() {
  for (const k of ["brightness", "contrast", "saturation"]) {
    input(k).value = "100";
    el(`${k}-value`).textContent = "100%";
  }
}
const feather = () => Math.max(0, Math.min(150, +input("feather").value || 0));
function syncFeather() {
  if (!selection) return;
  // The feather control always describes the current selection (live, like Select & Mask).
  const f = feather();
  if (f) selection.feather = f;
  else delete selection.feather;
}
/** Composites the mask surface (white = visible) into the chosen mask view. */
function composeMaskView(ctx: CanvasRenderingContext2D) {
  if (!maskSource) return;
  const { width, height } = preview;
  // Layer adjustments preview on the image only, never on the grey mask or the red tint.
  if (maskView === "result") {
    ctx.globalCompositeOperation = "source-in";
    ctx.filter = layerFilter;
    ctx.drawImage(maskSource, 0, 0, width, height);
    ctx.filter = "none";
  } else if (maskView === "mask") {
    ctx.globalCompositeOperation = "destination-over";
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, width, height);
  } else {
    const hidden = surface(width, height),
      hctx = hidden.getContext("2d")!;
    hctx.fillStyle = "#ff3b30";
    hctx.fillRect(0, 0, width, height);
    hctx.globalCompositeOperation = "destination-out";
    hctx.drawImage(preview, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.filter = layerFilter;
    ctx.drawImage(maskSource, 0, 0, width, height);
    ctx.filter = "none";
    ctx.globalAlpha = 0.55;
    ctx.drawImage(hidden, 0, 0);
    ctx.globalAlpha = 1;
  }
  ctx.globalCompositeOperation = "source-over";
}
function drawSelectionOverlay() {
  const soft = isSoft(selection);
  const useCanvas = !!selection && (!!selection.points || soft);
  lassoOverlay.width = useCanvas ? preview.width : 1;
  lassoOverlay.height = useCanvas ? preview.height : 1;
  lassoOverlay.hidden = !useCanvas;
  selectionBox.hidden = !selection || useCanvas;
  if (!selection || !useCanvas) return;
  const overlay = lassoOverlay.getContext("2d")!;
  const dragging = (!!pointer && !pointer.stroke) || featherSliding;
  if (soft && !dragging) {
    // Show the real soft coverage: unselected areas dim in proportion to the feather.
    overlay.fillStyle = "#0b0f09";
    overlay.globalAlpha = 0.5;
    overlay.fillRect(0, 0, preview.width, preview.height);
    overlay.globalAlpha = 1;
    overlay.globalCompositeOperation = "destination-out";
    overlay.drawImage(
      selectionAlpha(selection, preview.width, preview.height),
      0,
      0,
    );
    overlay.globalCompositeOperation = "source-over";
  } else {
    overlay.beginPath();
    if (selection.inverted) overlay.rect(0, 0, preview.width, preview.height);
    selectionPath(overlay, selection);
    overlay.fillStyle = "#c9ee9133";
    overlay.fill("evenodd");
  }
  overlay.beginPath();
  selectionPath(overlay, selection);
  overlay.strokeStyle = "white";
  overlay.lineWidth = Math.max(
    1,
    preview.width / (preview.clientWidth || preview.width),
  );
  overlay.setLineDash([5 * overlay.lineWidth, 4 * overlay.lineWidth]);
  overlay.stroke();
}
function fitPreview() {
  if (!pixels || !dialog.open) return;
  const stage = dialog.querySelector<HTMLElement>(".editor-stage")!;
  const zoom = input("zoom").value;
  stage.classList.toggle("zoomed", zoom !== "fit");
  const css = getComputedStyle(stage);
  const availableWidth =
    stage.clientWidth -
    parseFloat(css.paddingLeft) -
    parseFloat(css.paddingRight);
  const availableHeight =
    stage.clientHeight -
    parseFloat(css.paddingTop) -
    parseFloat(css.paddingBottom);
  const scale =
    zoom === "fit"
      ? Math.min(
          1,
          availableWidth / pixels.width,
          availableHeight / pixels.height,
        )
      : +zoom;
  // Both dimensions use one scale: object-fit letterboxing would displace painting coordinates.
  preview.style.width = `${Math.max(1, pixels.width * scale)}px`;
  preview.style.height = `${Math.max(1, pixels.height * scale)}px`;
}
new ResizeObserver(fitPreview).observe(dialog.querySelector(".editor-stage")!);
function paint() {
  syncFeather();
  preview.width = pixels.width;
  preview.height = pixels.height;
  const ctx = preview.getContext("2d")!,
    a = adjustment();
  ctx.drawImage(hasAdjustment() ? applyOperation(pixels, a) : pixels, 0, 0);
  fitPreview();
  if (pointer?.stroke) applyOperation(preview, pointer.stroke);
  if (pointer?.draft) applyOperation(preview, pointer.draft);
  composeMaskView(ctx);
  // Pixel sessions preview live layer adjustments over the whole surface.
  preview.style.filter = maskSource ? "none" : layerFilter;
  drawSelectionOverlay();
  input("width").value = String(pixels.width);
  input("height").value = String(pixels.height);
  selectionBox.style.borderRadius = selection?.ellipse ? "50%" : "0";
  selectionBox.classList.toggle("inverted", !!selection?.inverted);
  if (selection)
    Object.assign(selectionBox.style, {
      left: `${(selection.x / pixels.width) * 100}%`,
      top: `${(selection.y / pixels.height) * 100}%`,
      width: `${(selection.width / pixels.width) * 100}%`,
      height: `${(selection.height / pixels.height) * 100}%`,
    });
  el<HTMLButtonElement>("crop").disabled =
    !!maskSource ||
    !selection ||
    selection.inverted === true ||
    selection.width < 16 ||
    selection.height < 16;
  for (const name of ["invert", "delete-selection", "fill"])
    el<HTMLButtonElement>(name).disabled =
      !selection || !selection.width || !selection.height;
  el<HTMLButtonElement>("clear").disabled = !selection;
  el<HTMLButtonElement>("undo").disabled = !operations.length;
  el<HTMLButtonElement>("redo").disabled = !future.length;
  const soft = selection?.feather ? ` · feathered ${selection.feather} px` : "";
  el("status").textContent = maskSource
    ? `Mask ${pixels.width} × ${pixels.height} px · ${operations.length} edits${soft} · Image pixels untouched`
    : `${pixels.width} × ${pixels.height} px · ${operations.length} edits${soft} · Original preserved`;
}
function rebuild() {
  pixels = renderEdits(image, operations);
  paint();
}
function push(op: EditOperation) {
  if (operations.length >= 200)
    throw Error("Apply these edits to the layer before adding more.");
  // Render first so a rejected edit never enters the undo history.
  const next = applyOperation(pixels, op);
  operations.push(op);
  future = [];
  pixels = next;
  if (["crop", "resize", "rotate", "flip"].includes(op.type))
    selection = undefined;
  paint();
}
function act(action: () => void) {
  try {
    action();
  } catch (e) {
    el("status").textContent = (e as Error).message;
  }
}
function bakeAdjustments() {
  if (!hasAdjustment()) return;
  const op = adjustment();
  resetAdjustments();
  push(op);
}
function point(e: PointerEvent | MouseEvent) {
  const r = preview.getBoundingClientRect();
  return {
    x: Math.max(
      0,
      Math.min(pixels.width, ((e.clientX - r.left) / r.width) * pixels.width),
    ),
    y: Math.max(
      0,
      Math.min(pixels.height, ((e.clientY - r.top) / r.height) * pixels.height),
    ),
  };
}
const brushSize = () => Math.max(1, Math.min(512, +input("size").value || 32));
const brushHardness = () =>
  Math.max(0, Math.min(100, +input("hardness").value)) / 100;
function syncBrushLabels() {
  el("hardness-value").textContent = `${Math.round(brushHardness() * 100)}%`;
  el("opacity-value").textContent = `${input("opacity").value}%`;
  const f = feather();
  el("feather-value").textContent = f ? `${f} px` : "0 px · hard edge";
}
/** Circle outline at the true brush size; the inner ring marks the solid core. */
function moveCursor(e: PointerEvent | MouseEvent) {
  const painting = activeTool === "brush" || activeTool === "erase";
  const r = preview.getBoundingClientRect(),
    host = preview.parentElement!.getBoundingClientRect();
  if (
    !painting ||
    e.clientX < r.left ||
    e.clientX > r.right ||
    e.clientY < r.top ||
    e.clientY > r.bottom
  ) {
    cursor.hidden = true;
    return;
  }
  const scale = r.width / pixels.width,
    d = Math.max(4, brushSize() * scale);
  cursor.hidden = false;
  cursor.classList.toggle("erasing", activeTool === "erase");
  Object.assign(cursor.style, {
    width: `${d}px`,
    height: `${d}px`,
    left: `${e.clientX - host.left}px`,
    top: `${e.clientY - host.top}px`,
  });
  const core = brushProfile(brushSize(), brushHardness()).core / brushSize();
  const inner = cursor.firstElementChild as HTMLElement;
  inner.hidden = core >= 0.99;
  inner.style.width = inner.style.height = `${core * 100}%`;
}
const regionHints: Record<string, string> = {
  select:
    "Select an area, then Mark selection. Marked areas are tinted red and will be regenerated.",
  brush: "Unmark: paint to keep areas unchanged. X swaps to Mark.",
  erase:
    "Mark: paint over everything the AI should change. Paint a little beyond the edges. X swaps to Unmark.",
  text: "",
};
const hints: Record<"pixels" | "mask", Record<string, string>> = {
  pixels: {
    select:
      "Drag a selection to crop, fill or clear it. Selections also limit adjustments and strokes. Feather softens their edge.",
    brush:
      "Paint on the image. A selection limits where paint lands; its feather fades the edge.",
    erase: "Erase pixels to transparency. Lower hardness for a soft edge.",
    text: "Enter text and click the image to place it.",
    eyedropper:
      "Click to sample the current image pixels. Alt-click also samples while using a painting tool. X swaps colors; D resets to black and white.",
    bucket:
      "Click to fill a matching color region. Tolerance controls how similar colors must be. Selections limit the fill.",
    gradient:
      "Drag from foreground to background color, or fade to transparency. Shift constrains direction to 45° steps. Selections limit the gradient.",
    shape:
      "Drag a rectangle, ellipse or line. Hold Shift for a square, circle or 45° line. Shapes become pixels; Undo lets you try again.",
  },
  mask: {
    select:
      "Select an area, then Hide or Reveal it. Add feather for a soft transition.",
    brush:
      "Reveal paints the image back in. White in Mask view is visible. X swaps to Hide.",
    erase:
      "Hide paints parts of the image away without erasing pixels. Soft brushes blend edges. X swaps to Reveal.",
    text: "",
  },
};
function setTool(tool: string) {
  const b = dialog.querySelector<HTMLButtonElement>(`[data-tool="${tool}"]`);
  if (!b || b.hidden) return;
  activeTool = tool;
  el("paint-options").hidden = activeTool === "select";
  el("brush-options").hidden = !["brush", "erase"].includes(activeTool);
  el("text-options").hidden = activeTool !== "text";
  el("tool-opacity").hidden = ["text", "eyedropper"].includes(activeTool);
  for (const name of ["bucket", "gradient", "shape"])
    el(`${name}-options`).hidden = activeTool !== name;
  dialog.querySelectorAll("[data-tool]").forEach((x) => {
    x.classList.toggle("active", x === b);
    x.setAttribute("aria-pressed", String(x === b));
  });
  el("hint").textContent =
    (regionMode ? regionHints : hints[mode()])[
      activeTool as keyof (typeof hints)["mask"]
    ];
  preview.style.cursor = ["brush", "erase"].includes(activeTool)
    ? "none"
    : "crosshair";
  cursor.hidden = true;
}
function swapColors() {
  const color = input("color").value;
  input("color").value = input("background-color").value;
  input("background-color").value = color;
  input("fill-color").value = input("color").value;
}
el("swap").onclick = swapColors;
input("color").oninput = () => {
  input("fill-color").value = input("color").value;
};
function sampleColor(p: { x: number; y: number }) {
  const rgba = pixels
    .getContext("2d")!
    .getImageData(
      Math.min(pixels.width - 1, Math.floor(p.x)),
      Math.min(pixels.height - 1, Math.floor(p.y)),
      1,
      1,
    ).data;
  if (!rgba[3]) {
    el("status").textContent =
      "That pixel is transparent. Sample a visible color.";
    return;
  }
  const hex = `#${Array.from(rgba.slice(0, 3))
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")}`;
  input("color").value = input("fill-color").value = hex;
  el("status").textContent = `Sampled ${hex.toUpperCase()} · Foreground color`;
}
for (const b of dialog.querySelectorAll<HTMLButtonElement>("[data-tool]"))
  b.onclick = () => setTool(b.dataset.tool!);
const viewHints = {
  result: "The layer as it will look on the canvas.",
  mask: "White is visible, black is hidden, grey is partly visible.",
  overlay: "Hidden areas are tinted red over the full image.",
};
function setMaskView(view: typeof maskView, repaint = true) {
  maskView = view;
  dialog.querySelectorAll<HTMLElement>("[data-mask-view]").forEach((b) => {
    const on = b.dataset.maskView === view;
    b.classList.toggle("active", on);
    b.setAttribute("aria-checked", String(on));
  });
  el("view-hint").textContent = viewHints[view];
  if (repaint) paint();
}
dialog
  .querySelectorAll<HTMLButtonElement>("[data-mask-view]")
  .forEach(
    (b) =>
      (b.onclick = () => setMaskView(b.dataset.maskView as typeof maskView)),
  );
preview.onpointerdown = (e) => {
  if (e.button !== 0 || pointer) return;
  e.preventDefault();
  act(() => {
    bakeAdjustments();
    const p = point(e);
    if (!maskSource && (activeTool === "eyedropper" || e.altKey)) {
      sampleColor(p);
      return;
    }
    if (activeTool === "bucket") {
      push({
        type: "bucket",
        x: Math.min(pixels.width - 1, p.x),
        y: Math.min(pixels.height - 1, p.y),
        color: input("color").value,
        tolerance: Math.max(0, Math.min(255, +input("tolerance").value || 0)),
        contiguous: input("contiguous").checked,
        opacity: +input("opacity").value / 100,
        selection: selection ? { ...selection } : undefined,
      });
      return;
    }
    if (activeTool === "text") {
      const text = input("text").value.trim();
      if (!text) throw Error("Enter text first.");
      push({
        type: "text",
        ...p,
        text,
        size: Math.max(8, Math.min(512, +input("text-size").value || 64)),
        color: input("color").value,
      });
      return;
    }
    pointer = { id: e.pointerId, start: p };
    preview.setPointerCapture(e.pointerId);
    if (activeTool === "gradient" || activeTool === "shape") {
      const shared = {
        from: [p.x, p.y] as [number, number],
        to: [p.x, p.y] as [number, number],
        color: input("color").value,
        opacity: +input("opacity").value / 100,
        selection: selection ? { ...selection } : undefined,
      };
      pointer.draft =
        activeTool === "gradient"
          ? {
              ...shared,
              type: "gradient",
              endColor: input("background-color").value,
              transparent: input("transparent").checked,
              radial: input("gradient-style").value === "radial",
            }
          : {
              ...shared,
              type: "shape",
              shape: input("draw-shape").value as
                "rectangle" | "ellipse" | "line",
              filled: input("shape-style").value === "fill",
              size: Math.max(
                1,
                Math.min(512, +input("stroke-width").value || 1),
              ),
            };
    } else if (activeTool === "select") {
      selection = undefined;
      if (input("shape").value === "lasso") pointer.lasso = [[p.x, p.y]];
    } else {
      pointer.stroke = {
        type: "stroke",
        points: [[p.x, p.y]],
        size: brushSize(),
        color: maskSource ? "#ffffff" : input("color").value,
        opacity: +input("opacity").value / 100,
        erase: activeTool === "erase",
        selection: selection ? { ...selection } : undefined,
      };
      if (brushHardness() < 1) pointer.stroke.hardness = brushHardness();
    }
    paint();
  });
};
function updateGesture(e: PointerEvent) {
  moveCursor(e);
  if (!pointer || pointer.id !== e.pointerId) return;
  const p = point(e);
  if (pointer.draft) {
    const start = pointer.start;
    if (e.shiftKey) {
      const dx = p.x - start.x,
        dy = p.y - start.y;
      if (pointer.draft.type === "shape" && pointer.draft.shape !== "line") {
        const side = Math.min(
          Math.max(Math.abs(dx), Math.abs(dy)),
          dx < 0 ? start.x : pixels.width - start.x,
          dy < 0 ? start.y : pixels.height - start.y,
        );
        p.x = start.x + (dx < 0 ? -side : side);
        p.y = start.y + (dy < 0 ? -side : side);
      } else {
        const angle =
          (Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI) / 4;
        const distance = Math.hypot(dx, dy);
        p.x = start.x + Math.cos(angle) * distance;
        p.y = start.y + Math.sin(angle) * distance;
      }
    }
    pointer.draft.to = [p.x, p.y];
  } else if (pointer.stroke) pointer.stroke.points.push([p.x, p.y]);
  else if (pointer.lasso) {
    const last = pointer.lasso.at(-1)!;
    if (
      Math.hypot(p.x - last[0], p.y - last[1]) >= 1 &&
      pointer.lasso.length < 10000
    )
      pointer.lasso.push([p.x, p.y]);
    selection = polygonSelection(pointer.lasso);
  } else
    selection = {
      ...clampRect(pointer.start, p, pixels.width, pixels.height),
      ellipse: input("shape").value === "ellipse",
    };
  paint();
}
preview.onpointermove = updateGesture;
preview.onpointerleave = () => (cursor.hidden = true);
preview.onpointerup = (e) => {
  if (!pointer || pointer.id !== e.pointerId) return;
  updateGesture(e);
  const stroke = pointer.stroke || pointer.draft;
  if (pointer.lasso) {
    const p = point(e);
    pointer.lasso.push([p.x, p.y]);
    selection =
      pointer.lasso.length >= 3 ? polygonSelection(pointer.lasso) : undefined;
    if (selection && (!selection.width || !selection.height))
      selection = undefined;
  }
  pointer = null;
  if (preview.hasPointerCapture(e.pointerId))
    preview.releasePointerCapture(e.pointerId);
  if (stroke) act(() => push(stroke));
  else paint();
};
preview.onpointercancel = () => {
  pointer = null;
  paint();
};
el("crop").onclick = () =>
  act(() => {
    if (selection) {
      bakeAdjustments();
      push({ type: "crop", rect: { ...selection } });
    }
  });
function deselect() {
  selection = undefined;
  paint();
}
el("clear").onclick = deselect;
el("zoom").onchange = paint;
el("shape").onchange = () => {
  if (input("shape").value === "lasso") selection = undefined;
  else if (selection) {
    delete selection.points;
    selection.ellipse = input("shape").value === "ellipse";
  }
  paint();
};
function selectAll() {
  selection = { x: 0, y: 0, width: pixels.width, height: pixels.height };
  input("shape").value = "rectangle";
  paint();
}
el("select-all").onclick = selectAll;
function invert() {
  if (selection) selection.inverted = !selection.inverted;
  paint();
}
el("invert").onclick = invert;
for (const [name, erase] of [
  ["fill", false],
  ["delete-selection", true],
] as const)
  el(name).onclick = () =>
    act(() => {
      if (!selection?.width || !selection.height) return;
      bakeAdjustments();
      push({
        type: "fill",
        selection: { ...selection },
        color: maskSource ? "#ffffff" : input("fill-color").value,
        erase,
      });
    });
el("left").onclick = () =>
  act(() => {
    bakeAdjustments();
    push({ type: "rotate", clockwise: false });
  });
el("right").onclick = () =>
  act(() => {
    bakeAdjustments();
    push({ type: "rotate", clockwise: true });
  });
el("flip-x").onclick = () =>
  act(() => {
    bakeAdjustments();
    push({ type: "flip", horizontal: true });
  });
el("flip-y").onclick = () =>
  act(() => {
    bakeAdjustments();
    push({ type: "flip", horizontal: false });
  });
for (const dimension of ["width", "height"] as const)
  input(dimension).oninput = () => {
    if (input("ratio").checked) {
      const other = dimension === "width" ? "height" : "width";
      input(other).value = String(
        Math.round(
          (+input(dimension).value * pixels[other]) / pixels[dimension],
        ),
      );
    }
  };
el("resize").onclick = () =>
  act(() => {
    const width = +input("width").value,
      height = +input("height").value;
    validatePixelSize(width, height);
    bakeAdjustments();
    push({ type: "resize", width, height });
  });
for (const k of ["brightness", "contrast", "saturation"])
  input(k).oninput = () => {
    el(`${k}-value`).textContent = `${input(k).value}%`;
    paint();
  };
for (const k of ["size", "opacity"]) input(k).oninput = syncBrushLabels;
input("hardness").oninput = () => {
  hardness[mode()] = +input("hardness").value;
  syncBrushLabels();
};
input("feather").oninput = () => {
  featherSliding = true;
  syncBrushLabels();
  paint();
};
input("feather").onchange = () => {
  featherSliding = false;
  paint();
};
el("adjust").onclick = () => act(bakeAdjustments);
el("undo").onclick = () => {
  const op = operations.pop();
  if (op) future.push(op);
  selection = undefined;
  resetAdjustments();
  rebuild();
};
el("redo").onclick = () => {
  const op = future.pop();
  if (op) operations.push(op);
  selection = undefined;
  resetAdjustments();
  rebuild();
};
el("reset").onclick = () => {
  operations = [];
  future = [];
  selection = undefined;
  resetAdjustments();
  rebuild();
};
el("close").onclick = () => dialog.close();
dialog.onclose = () => {
  // The close event is queued; never wipe a session that has already reopened.
  if (dialog.open) return;
  pointer = null;
  operations = [];
  future = [];
  cursor.hidden = true;
  preview.width = preview.height = 1;
};
function nudge(name: "size" | "hardness", grow: boolean) {
  const v = +input(name).value;
  if (name === "size")
    input(name).value = String(
      Math.max(
        1,
        Math.min(512, grow ? Math.ceil(v * 1.2) : Math.floor(v / 1.2)),
      ),
    );
  else
    input(name).value = String(
      Math.max(0, Math.min(100, v + (grow ? 10 : -10))),
    );
  input(name).dispatchEvent(new Event("input"));
}
dialog.onkeydown = (e) => {
  const typing =
    e.target instanceof HTMLInputElement ||
    e.target instanceof HTMLTextAreaElement ||
    e.target instanceof HTMLSelectElement;
  const key = e.key.toLowerCase(),
    command = e.ctrlKey || e.metaKey;
  if (
    command &&
    key === "z" &&
    (!typing ||
      (e.target instanceof HTMLInputElement && e.target.type === "range"))
  ) {
    e.preventDefault();
    el(e.shiftKey ? "redo" : "undo").click();
    return;
  }
  // Range inputs don't take text, so shortcuts still work after moving a slider.
  if (
    typing &&
    !(e.target instanceof HTMLInputElement && e.target.type === "range")
  )
    return;
  let handled = true;
  if (command && key === "a") selectAll();
  else if (command && key === "d") deselect();
  else if (command && e.shiftKey && key === "i") invert();
  else if (command || e.altKey) handled = false;
  else if (e.code === "BracketLeft" || e.code === "BracketRight")
    nudge(e.shiftKey ? "hardness" : "size", e.code === "BracketRight");
  else if (key === "b") setTool("brush");
  else if (key === "e") setTool("erase");
  else if (key === "m") setTool("select");
  else if (key === "l") {
    input("shape").value = "lasso";
    setTool("select");
  } else if (key === "c") {
    input("shape").value = "rectangle";
    setTool("select");
  } else if (key === "i" && !maskSource) setTool("eyedropper");
  else if (key === "k" && !maskSource) setTool("bucket");
  else if (key === "g" && !maskSource) setTool("gradient");
  else if (key === "u" && !maskSource) setTool("shape");
  else if (key === "t" && !maskSource) setTool("text");
  else if (key === "x" && !maskSource) swapColors();
  else if (key === "d" && !maskSource) {
    input("color").value = input("fill-color").value = "#000000";
    input("background-color").value = "#ffffff";
  } else if ((key === "delete" || key === "backspace") && selection)
    el("delete-selection").click();
  else if (
    key === "x" &&
    maskSource &&
    (activeTool === "brush" || activeTool === "erase")
  )
    setTool(activeTool === "brush" ? "erase" : "brush");
  else handled = false;
  if (handled) e.preventDefault();
};
function saveEdits(asNewLayer = false) {
  act(() => {
    bakeAdjustments();
    if (operations.length || asNewLayer)
      save(
        {
          data: pixels.toDataURL("image/png"),
          width: pixels.width,
          height: pixels.height,
        },
        operations,
        asNewLayer,
      );
    dialog.close();
  });
}
el("save").onclick = () => saveEdits();
el("save-copy").onclick = () => saveEdits(true);
export interface EditorContext {
  /** Live layer adjustments, previewed but never baked into pixels here. */
  adjustments?: Adjustments;
  /** The layer has a mask that pixel edits will keep aligned. */
  masked?: boolean;
  /** Mask refinements applied on the canvas but not while painting. */
  maskFeather?: number;
  maskDensity?: number;
}
export async function openImageEditor(
  asset: Asset,
  onSave: typeof save,
  initialTool = "select",
  maskOptions?: { mask?: Asset; region?: boolean },
  context: EditorContext = {},
) {
  if (dialog.open) return;
  validatePixelSize(asset.width, asset.height);
  const revision = ++session,
    loaded = new Image();
  loaded.src = asset.data;
  await loaded.decode();
  validatePixelSize(loaded.naturalWidth, loaded.naturalHeight);
  const existingMask = maskOptions?.mask
    ? await loadAssetImage(maskOptions.mask)
    : undefined;
  const startingMask = maskOptions ? new Image() : undefined;
  if (startingMask) {
    startingMask.src = maskSurface(loaded, existingMask).toDataURL("image/png");
    await startingMask.decode();
  }
  if (revision !== session) return;
  maskSource = maskOptions ? loaded : undefined;
  image = startingMask || loaded;
  const masking = !!maskOptions;
  regionMode = !!maskOptions?.region;
  dialog.classList.toggle("mask-mode", masking);
  dialog.classList.toggle("region-mode", regionMode);
  dialog.setAttribute(
    "aria-label",
    masking ? "Layer mask editor" : "Image editor",
  );
  dialog.querySelector("h2")!.textContent = regionMode
    ? "Mark what should change."
    : masking
      ? "Hide. Reveal. Refine."
      : "Edit every detail.";
  el("eyebrow").textContent = regionMode
    ? "AI EDIT AREA"
    : masking
      ? "LAYER MASK"
      : "IMAGE WORKSHOP";
  el("mode-badge").textContent = regionMode
    ? "Red = will be regenerated · everything else stays exactly as it is"
    : masking
      ? "Editing the mask · image pixels are never changed"
      : "Editing image pixels · applied as a new version, original kept";
  dialog
    .querySelectorAll<HTMLElement>("[data-pixel-only]")
    .forEach((x) => (x.hidden = masking));
  el("mask-view-options").hidden = !masking;
  const toolButton = (tool: string) =>
    dialog.querySelector<HTMLButtonElement>(`[data-tool="${tool}"]`)!;
  toolButton("text").hidden = masking;
  toolButton("select").textContent = masking ? "Select" : "Select / crop";
  const [reveal, hide] = regionMode ? ["Unmark", "Mark"] : ["Reveal", "Hide"];
  toolButton("brush").textContent = masking ? reveal : "Brush";
  toolButton("erase").textContent = masking ? hide : "Eraser";
  toolButton("brush").title = masking ? `${reveal} (B)` : "Brush (B)";
  toolButton("erase").title = masking ? `${hide} (E)` : "Eraser (E)";
  el("crop").hidden = masking;
  el("fill").textContent = masking ? `${reveal} selection` : "Fill selection";
  el("delete-selection").textContent = masking
    ? `${hide} selection`
    : "Clear pixels";
  el("save").textContent = regionMode
    ? "Use this area"
    : masking
      ? "Apply mask"
      : "Apply to layer";
  layerFilter = adjustmentFilter(context.adjustments);
  const notes: string[] = [];
  if (isActive(context.adjustments))
    notes.push(
      masking
        ? "Layer adjustments are previewed here."
        : "Layer adjustments are previewed; you are painting the unadjusted pixels.",
    );
  if (!masking && context.masked)
    notes.push(
      "This layer's mask is not shown here. It is kept and follows crops, rotations and resizing.",
    );
  if (
    masking &&
    ((context.maskFeather ?? 0) > 0 || (context.maskDensity ?? 1) < 1)
  )
    notes.push(
      "Live mask feather/density are applied on the canvas, not while painting.",
    );
  el("context-note").textContent = notes.join(" ");
  el("context-note").hidden = !notes.length;
  input("shape").value = initialTool === "lasso" ? "lasso" : "rectangle";
  input("zoom").value = "fit";
  input("hardness").value = String(hardness[mode()]);
  syncBrushLabels();
  save = onSave;
  operations = [];
  future = [];
  selection = undefined;
  pointer = null;
  resetAdjustments();
  setMaskView(regionMode ? "overlay" : "result", false);
  rebuild();
  setTool(["crop", "lasso"].includes(initialTool) ? "select" : initialTool);
  dialog.showModal();
  fitPreview();
}
