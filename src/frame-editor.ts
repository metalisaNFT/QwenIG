/**
 * Frame editor: a full-screen workspace for one animation (a project sprite).
 *
 *   stage      play / step, onion skin, checkerboard, live effect preview
 *   timeline   thumbnails; click, shift-click and ctrl-click to select, drag to reorder
 *   Frame      hold times, duplicate, delete, reverse, ping-pong, edit pixels, add frames
 *   Effects    glitch stacks on selected or all frames, or one frame → a glitch loop
 *   Clean up   remove backgrounds (engine), align & trim, shared-palette pixel art
 *   Export     animated GIF, sprite sheet + JSON
 *
 * Every change is one project commit, so Undo works (↶ / Ctrl+Z here as well).
 */
import type { Asset, Layer, Sprite } from "./model.ts";
import { newLayer } from "./model.ts";
import type { StudioContext } from "./studio-context.ts";
import { h, jobView } from "./studio-context.ts";
import { assetCanvas, assetImage, canvasAsset, cutOut, normalize } from "./frames.ts";
import { alphaBounds, canvasPixels, composeSheet, crop, fileStem, frameDurations, pixelsCanvas, sheetJSON, sheetLayout, unionBox } from "./sprites.ts";
import { applyPalette, buildPalette, hardAlpha, outline, pixelate, targetSize } from "./pixel-art.ts";
import { applyStack, glitchFrames, type Rhythm } from "./glitch.ts";
import { stackEditor } from "./glitch-ui.ts";
import { encodeGIFAsync } from "./gif.ts";
import { openImageEditor } from "./image-editor.ts";
import { download } from "./storage.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));
let open: HTMLDialogElement | null = null;

/** GIF sizes on offer: integer zoom for pixel art, a long-edge limit for everything else. */
export function gifSizes(sprite: Sprite, width: number, height: number) {
  const edge = Math.max(width, height);
  if (sprite.pixelated)
    return [1, 2, 4, 8].filter((k) => edge * k <= 2048).map((k) => ({ value: `x${k}`, text: `×${k} · ${width * k} × ${height * k}`, selected: k === (edge <= 64 ? 8 : edge <= 128 ? 4 : edge <= 256 ? 2 : 1) }));
  const options = [edge, 1024, 768, 512, 384, 256, 128].filter((e, i, all) => e <= edge && all.indexOf(e) === i);
  const preferred = options.find((e) => e <= 512) ?? options[0];
  return options.map((e) => {
    const k = e / edge;
    return { value: `e${e}`, text: `${e === edge ? "Original" : `${e} px`} · ${Math.round(width * k)} × ${Math.round(height * k)}`, selected: e === preferred };
  });
}

/** Render an animation to a GIF file. */
export async function spriteGIF(
  ctx: StudioContext,
  sprite: Sprite,
  options: { size?: string; colors?: number; dither?: number; transparent?: boolean },
  progress?: (text: string, fraction: number) => void,
) {
  const project = ctx.project();
  const canvases = normalize(await Promise.all(sprite.frames.map((f) => assetCanvas(project.assets[f.assetId]))));
  const w = canvases[0].width,
    hgt = canvases[0].height;
  const size = options.size ?? gifSizes(sprite, w, hgt).find((s) => s.selected)!.value;
  const k = size.startsWith("x") ? +size.slice(1) : +size.slice(1) / Math.max(w, hgt);
  const tw = Math.max(1, Math.round(w * k)),
    th = Math.max(1, Math.round(hgt * k));
  const durations = frameDurations(sprite.frames, sprite.fps);
  const frames = canvases.map((c, i) => {
    const out = document.createElement("canvas");
    out.width = tw;
    out.height = th;
    const g = out.getContext("2d", { willReadFrequently: true })!;
    g.imageSmoothingEnabled = !sprite.pixelated;
    g.imageSmoothingQuality = "high";
    g.drawImage(c, 0, 0, tw, th);
    return { pixels: canvasPixels(out), delay: durations[i] };
  });
  progress?.("Encoding GIF…", 0);
  const bytes = await encodeGIFAsync(
    frames,
    { loop: sprite.loop, colors: options.colors ?? 256, dither: options.dither ?? 0, transparent: options.transparent ?? true },
    (done, total) => progress?.(`Encoding GIF · frame ${done} of ${total}`, done / total),
  );
  return { blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "image/gif" }), width: tw, height: th };
}

export function openFrameEditor(ctx: StudioContext, spriteId: string, onClosed: () => void) {
  open?.close();
  const live = () => ctx.project().sprites.find((s) => s.id === spriteId);
  if (!live()) return;
  let cur = 0,
    selection = new Set<number>([0]),
    playing = false,
    anchor = 0;

  // ── Header ──────────────────────────────────────────────────────────────────────────────
  const name = h("input", { id: "fe-name", maxlength: 200, "aria-label": "Animation name" }) as HTMLInputElement;
  const fps = h("input", { id: "fe-fps", type: "number", min: 1, max: 60, "aria-label": "Frames per second" }) as HTMLInputElement;
  const loop = h("input", { id: "fe-loop", type: "checkbox" }) as HTMLInputElement;
  const undo = h("button", { type: "button", class: "quiet tiny", id: "fe-undo", title: "Undo (Ctrl+Z)", text: "↶" });
  const redo = h("button", { type: "button", class: "quiet tiny", id: "fe-redo", title: "Redo (Ctrl+Shift+Z)", text: "↷" });
  const gifQuick = h("button", { type: "button", class: "primary", id: "fe-gif-quick", text: "GIF ↓" });
  const close = h("button", { type: "button", class: "quiet", id: "fe-close", "aria-label": "Close frame editor", text: "✕" });
  const edit = (change: (s: Sprite) => void) => {
    const s = live();
    if (!s) return ctx.toast("This animation no longer exists.");
    ctx.commit(() => change(s));
    refresh();
  };
  name.onchange = () => edit((s) => (s.name = name.value.trim().slice(0, 200) || s.name));
  fps.onchange = () => edit((s) => (s.fps = Math.max(1, Math.min(60, Math.round(+fps.value) || s.fps))));
  loop.onchange = () => edit((s) => (s.loop = loop.checked));
  undo.onclick = () => (ctx.undo(false), refresh());
  redo.onclick = () => (ctx.undo(true), refresh());

  // ── Stage ───────────────────────────────────────────────────────────────────────────────
  const stage = h("canvas", { class: "fe-stage-canvas", id: "fe-stage", "aria-label": "Current frame" }) as HTMLCanvasElement;
  const play = h("button", { type: "button", class: "quiet", id: "fe-play", text: "▶ Play" });
  const prev = h("button", { type: "button", class: "quiet tiny", title: "Previous frame (←)", text: "◀" });
  const next = h("button", { type: "button", class: "quiet tiny", title: "Next frame (→)", text: "▶" });
  const counter = h("span", { class: "fe-counter", id: "fe-counter" });
  const onion = h("input", { type: "checkbox", id: "fe-onion" }) as HTMLInputElement;
  const showFx = h("input", { type: "checkbox", id: "fe-preview", checked: true }) as HTMLInputElement;
  const fxLabel = h("label", { class: "check", id: "fe-preview-label", hidden: true }, showFx, "Preview effects");
  const stageWrap = h(
    "div",
    { class: "fe-stage" },
    h("div", { class: "fe-stage-box" }, stage),
    h("div", { class: "fe-transport" }, prev, play, next, counter, h("label", { class: "check" }, onion, "Onion skin"), fxLabel),
  );
  play.onclick = () => setPlaying(!playing);
  prev.onclick = () => step(-1);
  next.onclick = () => step(1);
  onion.onchange = () => draw();
  showFx.onchange = () => draw();

  // ── Timeline ────────────────────────────────────────────────────────────────────────────
  const timeline = h("div", { class: "fe-timeline", id: "fe-timeline", role: "listbox", "aria-label": "Frames", "aria-multiselectable": "true" });
  let dragFrom: number[] | null = null;

  // ── Side tabs ───────────────────────────────────────────────────────────────────────────
  const tabNames = ["Frame", "Effects", "Clean up", "Export"] as const;
  const tabButtons = tabNames.map((t) => h("button", { type: "button", class: "fe-tab", "data-tab": t, text: t }));
  const panes = new Map<string, HTMLElement>();
  let tab: (typeof tabNames)[number] = "Frame";
  const { element: jobEl, view } = jobView("frames");
  const status = h("p", { class: "subtle", id: "fe-status", role: "status" });

  // Frame pane
  const duration = h("input", { type: "number", id: "fe-duration", min: 10, max: 10000, step: 10, "aria-label": "Hold time in milliseconds" }) as HTMLInputElement;
  const setDuration = h("button", { type: "button", class: "quiet", id: "fe-set-duration", text: "Set" });
  const fpsTiming = h("button", { type: "button", class: "quiet", id: "fe-use-fps", text: "Use FPS" });
  const button = (text: string, id: string, onclick: () => void, cls = "quiet") => Object.assign(h("button", { type: "button", class: cls, id, text }), { onclick });
  const picked = () => [...selection].filter((i) => i < (live()?.frames.length ?? 0)).sort((a, b) => a - b);
  setDuration.onclick = () => {
    const ms = Math.max(10, Math.min(10000, Math.round(+duration.value) || 0));
    edit((s) => picked().forEach((i) => (s.frames[i].duration = ms)));
  };
  fpsTiming.onclick = () => edit((s) => picked().forEach((i) => delete s.frames[i].duration));
  const framePane = h(
    "div",
    { class: "fe-pane" },
    h("p", { class: "subtle", id: "fe-selection-note" }),
    h("div", { class: "card-heading" }, h("span", { class: "eyebrow", text: "HOLD" })),
    h("div", { class: "ai-row" }, h("label", {}, "Milliseconds ", duration), setDuration, fpsTiming),
    h("div", { class: "card-heading" }, h("span", { class: "eyebrow", text: "ORDER" })),
    h(
      "div",
      { class: "selection-actions" },
      button("Duplicate", "fe-duplicate", () => duplicate()),
      button("Delete", "fe-delete", () => remove()),
      button("Reverse", "fe-reverse", () => reverse()),
      button("Ping-pong", "fe-pingpong", () => pingPong()),
    ),
    h("div", { class: "card-heading" }, h("span", { class: "eyebrow", text: "PIXELS" })),
    h(
      "div",
      { class: "selection-actions" },
      button("Edit pixels ↗", "fe-edit-pixels", () => void editPixels(), "primary"),
      button("Frame → canvas", "fe-to-canvas", () => frameToCanvas()),
    ),
    h("div", { class: "card-heading" }, h("span", { class: "eyebrow", text: "ADD FRAMES" })),
    h(
      "div",
      { class: "selection-actions" },
      button("Selected layers", "fe-add-layers", () => addLayers()),
      button("Blank frame", "fe-add-blank", () => void addBlank()),
    ),
    h("p", { class: "subtle", text: "Keys: ← → step · Space play · Delete removes · Ctrl+D duplicates · drag thumbnails to reorder." }),
  );
  panes.set("Frame", framePane);

  // Effects pane
  const effects = stackEditor(() => schedulePreview(), "fe-fx");
  const vary = h("input", { type: "checkbox", id: "fe-vary", checked: true }) as HTMLInputElement;
  vary.onchange = () => schedulePreview();
  const loopFrames = h("select", { id: "fe-loop-frames", "aria-label": "Frames in the loop" }, ...[6, 8, 12, 16, 24].map((n) => h("option", { value: n, text: `${n} frames`, selected: n === 12 }))) as HTMLSelectElement;
  const loopRhythm = h("select", { id: "fe-loop-rhythm", "aria-label": "Rhythm" },
    h("option", { value: "bursts", text: "Bursts", title: "Mostly calm, then a burst" }),
    h("option", { value: "steady", text: "Steady" }),
    h("option", { value: "pulse", text: "Pulse", title: "Builds up and fades" })) as HTMLSelectElement;
  const effectsPane = h(
    "div",
    { class: "fe-pane" },
    effects.element,
    h("label", { class: "check" }, vary, "Different glitch on every frame"),
    h(
      "div",
      { class: "selection-actions" },
      button("Apply to selected", "fe-fx-selected", () => void applyEffects(false), "primary"),
      button("Apply to all frames", "fe-fx-all", () => void applyEffects(true)),
    ),
    h("div", { class: "card-heading" }, h("span", { class: "eyebrow", text: "GLITCH LOOP" })),
    h("p", { class: "subtle", text: "Turn the current frame into a looping glitch: it is replaced by new frames." }),
    h("div", { class: "ai-row" }, loopFrames, loopRhythm),
    button("✦ Make glitch loop", "fe-fx-loop", () => void expandLoop()),
  );
  panes.set("Effects", effectsPane);

  // Clean up pane
  const pxWidth = h("select", { "aria-label": "Pixel width", id: "fe-px-width" }, ...[16, 24, 32, 48, 64, 96, 128].map((n) => h("option", { value: n, text: `${n} px wide`, selected: n === 48 }))) as HTMLSelectElement;
  const pxColors = h("select", { "aria-label": "Shared palette", id: "fe-px-colors" }, ...[4, 8, 12, 16, 24, 32].map((n) => h("option", { value: n, text: `${n} colours`, selected: n === 16 }))) as HTMLSelectElement;
  const pxOutline = h("select", { "aria-label": "Outline", id: "fe-px-outline" }, h("option", { value: "none", text: "No outline" }), h("option", { value: "auto", text: "Dark outline", selected: true }), h("option", { value: "black", text: "Black outline" })) as HTMLSelectElement;
  const cleanPane = h(
    "div",
    { class: "fe-pane" },
    h("p", { class: "subtle", text: "These change every frame. Undo brings the previous frames back." }),
    button("✦ Remove backgrounds", "fe-remove-bg", () => void removeBackgrounds()),
    h("p", { class: "subtle", text: "Uses your engine (BiRefNet), one frame at a time." }),
    button("Align & trim", "fe-align", () => void alignTrim()),
    h("p", { class: "subtle", text: "Stands every frame on a shared floor and crops to the character." }),
    h("div", { class: "card-heading" }, h("span", { class: "eyebrow", text: "PIXEL ART" })),
    h("div", { class: "ai-row" }, pxWidth, pxColors),
    pxOutline,
    button("▦ Pixel art (shared palette)", "fe-pixel", () => void pixelArtFrames()),
  );
  panes.set("Clean up", cleanPane);

  // Export pane
  const gifSize = h("select", { id: "fe-gif-size", "aria-label": "GIF size" }) as HTMLSelectElement;
  const gifColors = h("select", { id: "fe-gif-colors", "aria-label": "Colours" }, ...[256, 128, 64, 32, 16].map((n) => h("option", { value: n, text: `${n} colours`, selected: n === 256 }))) as HTMLSelectElement;
  const gifDither = h("input", { type: "range", id: "fe-gif-dither", min: 0, max: 100, value: 0, "aria-label": "Dithering" }) as HTMLInputElement;
  const gifTransparent = h("input", { type: "checkbox", id: "fe-gif-transparent", checked: true }) as HTMLInputElement;
  const columns = h("input", { type: "number", min: 0, max: 64, value: 0, title: "0 = automatic", id: "fe-columns", "aria-label": "Sheet columns" }) as HTMLInputElement;
  const padding = h("input", { type: "number", min: 0, max: 16, value: 0, id: "fe-padding", "aria-label": "Padding between cells" }) as HTMLInputElement;
  const exportPane = h(
    "div",
    { class: "fe-pane" },
    h("div", { class: "card-heading" }, h("span", { class: "eyebrow", text: "ANIMATED GIF" })),
    h("label", {}, "Size", gifSize),
    h("div", { class: "ai-row" }, h("label", {}, "Colours", gifColors), h("label", {}, "Dithering", gifDither)),
    h("label", { class: "check" }, gifTransparent, "Keep transparency"),
    button("Download GIF ↓", "fe-gif", () => void exportGIF(), "primary full"),
    h("p", { class: "subtle", id: "fe-gif-note" }),
    h("div", { class: "card-heading" }, h("span", { class: "eyebrow", text: "SPRITE SHEET" })),
    h("div", { class: "ai-row" }, h("label", {}, "Columns ", columns), h("label", {}, "Padding ", padding)),
    h(
      "div",
      { class: "selection-actions" },
      button("Sheet + JSON ↓", "fe-sheet", () => void exportSheet()),
      button("Sheet → canvas", "fe-sheet-canvas", () => void sheetToCanvas()),
    ),
    h("p", { class: "subtle", text: "The JSON uses Aseprite's array format (Godot, Phaser, Unity importers)." }),
  );
  panes.set("Export", exportPane);
  gifQuick.onclick = () => void exportGIF();

  const side = h("div", { class: "fe-side" }, h("div", { class: "fe-tabs", role: "tablist" }, ...tabButtons), ...panes.values(), jobEl, status);
  tabButtons.forEach((b) => (b.onclick = () => setTab(b.dataset.tab as typeof tab)));

  const dialog = h(
    "dialog",
    { class: "frame-editor", id: "frame-editor", "aria-label": "Frame editor" },
    h(
      "div",
      { class: "fe-header" },
      h("span", { class: "eyebrow", text: "FRAMES" }),
      name,
      h("label", { class: "fe-inline" }, "FPS", fps),
      h("label", { class: "check" }, loop, "Loop"),
      h("span", { class: "fe-spacer" }),
      undo,
      redo,
      gifQuick,
      close,
    ),
    h("div", { class: "fe-body" }, stageWrap, side),
    timeline,
  ) as HTMLDialogElement;
  open = dialog;
  document.body.append(dialog);
  close.onclick = () => dialog.close();
  dialog.addEventListener("close", () => {
    playing = false;
    cancelAnimationFrame(raf);
    dialog.remove();
    if (open === dialog) open = null;
    onClosed();
  });
  dialog.addEventListener("keydown", (e) => {
    if ((e.target as HTMLElement).closest("input, textarea, select")) return;
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && key === "z") (ctx.undo(e.shiftKey), refresh());
    else if ((e.ctrlKey || e.metaKey) && key === "d") duplicate();
    else if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "ArrowRight") step(1);
    else if (e.key === " ") setPlaying(!playing);
    else if (e.key === "Delete" || e.key === "Backspace") remove();
    else return;
    e.preventDefault();
  });

  // ── Behaviour ───────────────────────────────────────────────────────────────────────────
  function setTab(t: typeof tab) {
    tab = t;
    tabButtons.forEach((b) => b.classList.toggle("active", b.dataset.tab === t));
    for (const [n, p] of panes) p.hidden = n !== t;
    fxLabel.hidden = t !== "Effects";
    if (t === "Effects") schedulePreview();
    draw();
  }
  function setPlaying(on: boolean) {
    playing = on && (live()?.frames.length ?? 0) > 1;
    play.textContent = playing ? "⏸ Pause" : "▶ Play";
    clock = 0;
  }
  function step(delta: number) {
    const s = live();
    if (!s) return;
    setPlaying(false);
    cur = (cur + delta + s.frames.length) % s.frames.length;
    selection = new Set([cur]);
    anchor = cur;
    refresh();
  }
  function setSelection(i: number, e: MouseEvent | KeyboardEvent) {
    if (e.shiftKey) {
      selection = new Set();
      for (let k = Math.min(anchor, i); k <= Math.max(anchor, i); k++) selection.add(k);
    } else if (e.ctrlKey || e.metaKey) {
      if (selection.has(i) && selection.size > 1) selection.delete(i);
      else selection.add(i);
      anchor = i;
    } else {
      selection = new Set([i]);
      anchor = i;
    }
    cur = i;
    setPlaying(false);
    refresh();
  }

  function duplicate() {
    const p = picked();
    if (!p.length) return;
    edit((s) => s.frames.splice(p[p.length - 1] + 1, 0, ...p.map((i) => ({ ...s.frames[i] }))));
    selection = new Set(p.map((_, k) => p[p.length - 1] + 1 + k));
    cur = p[p.length - 1] + 1;
    refresh();
  }
  function remove() {
    const s = live();
    const p = picked();
    if (!s || !p.length) return;
    if (p.length >= s.frames.length) return ctx.toast("An animation needs at least one frame. Delete it from the Animate tab instead.");
    edit((x) => (x.frames = x.frames.filter((_, i) => !p.includes(i))));
    cur = Math.min(p[0], (live()?.frames.length ?? 1) - 1);
    selection = new Set([cur]);
    refresh();
  }
  function reverse() {
    const p = picked();
    edit((s) => {
      const idx = p.length > 1 ? p : s.frames.map((_, i) => i);
      const frames = idx.map((i) => s.frames[i]).reverse();
      idx.forEach((i, k) => (s.frames[i] = frames[k]));
    });
  }
  function pingPong() {
    const s = live();
    if (!s || s.frames.length < 3) return ctx.toast("Ping-pong needs at least three frames.");
    edit((x) => x.frames.push(...x.frames.slice(1, -1).reverse().map((f) => ({ ...f }))));
    ctx.toast("Frames added in reverse: the animation now plays forward and back.");
  }
  async function editPixels() {
    const s = live();
    if (!s) return;
    const asset = ctx.project().assets[s.frames[cur].assetId];
    const at = cur;
    await openImageEditor(asset, (next, _ops, asNew) => {
      const sprite = live();
      if (!sprite || sprite.frames[at]?.assetId !== asset.id) return ctx.toast("The frames changed meanwhile. Open the editor again.");
      const id = crypto.randomUUID();
      ctx.commit(() => {
        ctx.project().assets[id] = { id, ...next };
        if (asNew) sprite.frames.splice(at + 1, 0, { assetId: id, ...(sprite.frames[at].duration ? { duration: sprite.frames[at].duration } : {}) });
        else sprite.frames[at].assetId = id;
      });
      if (asNew) cur = at + 1;
      selection = new Set([cur]);
      refresh();
    });
  }
  function frameToCanvas() {
    const s = live();
    if (!s) return;
    const project = ctx.project();
    const asset = project.assets[s.frames[cur].assetId];
    const c = ctx.center();
    const layer: Layer = Object.assign(newLayer("image", c.x - asset.width / 2, c.y - asset.height / 2), {
      assetId: asset.id,
      width: asset.width,
      height: asset.height,
      name: `${s.name.slice(0, 160)} · frame ${cur + 1}`,
      ...(s.pixelated ? { pixelated: true } : {}),
    });
    ctx.commit(() => project.layers.push(layer));
    ctx.toast("Frame placed on the canvas as a layer.");
  }
  function addLayers() {
    const layers = ctx.selectedLayers().filter((l) => l.assetId);
    if (!layers.length) return ctx.toast("Select image layers on the canvas first (shift-click for several).");
    layers.sort((a, b) => a.x - b.x || a.y - b.y);
    edit((s) => s.frames.splice(cur + 1, 0, ...layers.map((l) => ({ assetId: l.assetId! }))));
    ctx.toast(`${layers.length} frame${layers.length > 1 ? "s" : ""} added after frame ${cur + 1}.`);
  }
  async function addBlank() {
    const s = live();
    if (!s) return;
    const box = await frameBox(s);
    const c = document.createElement("canvas");
    c.width = box.width;
    c.height = box.height;
    const a = canvasAsset(c);
    edit((x) => {
      ctx.project().assets[a.id] = a;
      x.frames.splice(cur + 1, 0, { assetId: a.id });
    });
    cur += 1;
    selection = new Set([cur]);
    refresh();
  }

  /** Replace frames (by index) with new canvases in one commit, if the animation did not change meanwhile. */
  function replaceAt(indices: number[], canvases: HTMLCanvasElement[], signatureBefore: string, message: string, pixelated?: boolean) {
    const s = live();
    if (!s || signature(s) !== signatureBefore) return ctx.toast("The frames changed meanwhile. Try again.");
    const assets = canvases.map(canvasAsset);
    ctx.commit(() => {
      assets.forEach((a, k) => {
        ctx.project().assets[a.id] = a;
        s.frames[indices[k]] = { ...s.frames[indices[k]], assetId: a.id };
      });
      if (pixelated !== undefined) {
        if (pixelated) s.pixelated = true;
        else delete s.pixelated;
      }
    });
    ctx.toast(message);
    refresh();
  }
  async function busy<T>(label: string, work: (progress: (text: string, fraction: number) => void) => Promise<T>) {
    view.panel.hidden = false;
    view.cancel.hidden = true;
    const progress = (text: string, fraction: number) => {
      view.label.textContent = text;
      view.progress.value = fraction * 100;
    };
    progress(label, 0);
    try {
      return await work(progress);
    } catch (e) {
      ctx.fail(e);
      return undefined;
    } finally {
      view.panel.hidden = true;
      view.cancel.hidden = false;
    }
  }

  async function applyEffects(all: boolean) {
    const s = live();
    if (!s) return;
    const stack = effects.stack();
    if (!stack.length) return ctx.toast("Add an effect first.");
    const before = signature(s);
    const indices = all ? s.frames.map((_, i) => i) : picked();
    const seed = effects.seed();
    await busy("Applying effects…", async (progress) => {
      const out: HTMLCanvasElement[] = [];
      for (const [k, i] of indices.entries()) {
        progress(`Applying effects · frame ${k + 1} of ${indices.length}`, k / indices.length);
        const c = await assetCanvas(ctx.project().assets[s.frames[i].assetId]);
        const n = s.frames.length;
        out.push(pixelsCanvas(applyStack(canvasPixels(c), stack, vary.checked ? seed + i * 7919 : seed, vary.checked ? i / n : 0)));
        await tick();
      }
      replaceAt(indices, out, before, `Effects applied to ${indices.length} frame${indices.length > 1 ? "s" : ""}. Undo removes them.`);
    });
  }
  async function expandLoop() {
    const s = live();
    if (!s) return;
    const stack = effects.stack();
    if (!stack.length) return ctx.toast("Add an effect first.");
    const before = signature(s);
    const at = cur;
    await busy("Making the glitch loop…", async () => {
      const c = await assetCanvas(ctx.project().assets[s.frames[at].assetId]);
      const frames = glitchFrames(canvasPixels(c), stack, { frames: +loopFrames.value, rhythm: loopRhythm.value as Rhythm, seed: effects.seed() });
      const assets = frames.map((p) => canvasAsset(pixelsCanvas(p)));
      const sprite = live();
      if (!sprite || signature(sprite) !== before) return ctx.toast("The frames changed meanwhile. Try again.");
      ctx.commit(() => {
        assets.forEach((a) => (ctx.project().assets[a.id] = a));
        sprite.frames.splice(at, 1, ...assets.map((a) => ({ assetId: a.id })));
      });
      selection = new Set(assets.map((_, k) => at + k));
      ctx.toast(`Frame ${at + 1} became a ${assets.length}-frame glitch loop.`);
      setPlaying(true);
      refresh();
    });
  }
  async function removeBackgrounds() {
    const engine = ctx.service();
    if (!engine || !ctx.capabilities().includes("remove-background")) return ctx.toast("Connect an engine with background removal.");
    const s = live();
    if (!s) return;
    const before = signature(s);
    const frames = s.frames.map((f) => ctx.project().assets[f.assetId]);
    let stop = false;
    await ctx.exclusive(async () => {
      view.panel.hidden = false;
      view.cancel.onclick = () => (stop = true);
      try {
        const out: HTMLCanvasElement[] = [];
        for (const [i, asset] of frames.entries()) {
          view.label.textContent = `Removing background · frame ${i + 1} of ${frames.length}`;
          view.progress.value = (i / frames.length) * 100;
          out.push(await cutOut(engine, asset, () => stop));
        }
        replaceAt(frames.map((_, i) => i), out, before, "Backgrounds removed from every frame. Undo restores them.");
      } catch (e) {
        if (!stop) ctx.fail(e);
      } finally {
        view.panel.hidden = true;
      }
    });
  }
  async function allCanvases(s: Sprite) {
    return normalize(await Promise.all(s.frames.map((f) => assetCanvas(ctx.project().assets[f.assetId]))));
  }
  async function alignTrim() {
    const s = live();
    if (!s) return;
    const before = signature(s);
    try {
      const canvases = await allCanvases(s);
      const box = unionBox(canvases.map((c) => alphaBounds(canvasPixels(c))), 1, canvases[0]);
      if (!box) return ctx.toast("All frames are fully transparent.");
      replaceAt(canvases.map((_, i) => i), canvases.map((c) => crop(c, box)), before, "Frames aligned on a shared floor and trimmed to the character.");
    } catch (e) {
      ctx.fail(e);
    }
  }
  async function pixelArtFrames() {
    const s = live();
    if (!s) return;
    const before = signature(s);
    try {
      const canvases = await allCanvases(s);
      const size = targetSize(canvases[0].width, canvases[0].height, +pxWidth.value);
      const small = canvases.map((c) => hardAlpha(pixelate(canvasPixels(c), size.width, size.height)));
      const palette = buildPalette(small, +pxColors.value);
      const done = small.map((p) => {
        let out = applyPalette(p, palette);
        if (pxOutline.value !== "none") out = outline(out, pxOutline.value === "black" ? [0, 0, 0] : "auto");
        return pixelsCanvas(out);
      });
      replaceAt(done.map((_, i) => i), done, before, `Pixel art: ${size.width} × ${size.height}, one ${palette.length}-colour palette for every frame.`, true);
    } catch (e) {
      ctx.fail(e);
    }
  }
  async function exportGIF() {
    const s = live();
    if (!s) return;
    const result = await busy("Preparing frames…", (progress) =>
      spriteGIF(ctx, s, { size: gifSize.value || undefined, colors: +gifColors.value, dither: +gifDither.value / 100, transparent: gifTransparent.checked }, progress),
    );
    if (!result) return;
    download(`${fileStem(s.name)}.gif`, result.blob);
    const kb = result.blob.size / 1024;
    ctx.toast(`Saved ${fileStem(s.name)}.gif · ${result.width} × ${result.height} · ${kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb)} KB`}.`);
  }
  async function sheet() {
    const s = live()!;
    const canvases = await Promise.all(s.frames.map((f) => assetCanvas(ctx.project().assets[f.assetId])));
    const layout = sheetLayout(canvases, +columns.value, +padding.value);
    return { canvas: composeSheet(canvases, layout), layout, sprite: s };
  }
  async function exportSheet() {
    try {
      const { canvas, layout, sprite } = await sheet();
      const stem = fileStem(sprite.name);
      const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(Error("Could not export."))), "image/png"));
      const json = sheetJSON(sprite.name, `${stem}.png`, layout, frameDurations(sprite.frames, sprite.fps), sprite.loop);
      download(`${stem}.png`, png);
      download(`${stem}.json`, new Blob([JSON.stringify(json, null, 2)], { type: "application/json" }));
      ctx.toast(`Exported ${stem}.png (${layout.columns} × ${layout.rows} cells of ${layout.cell.width} × ${layout.cell.height}) and ${stem}.json.`);
    } catch (e) {
      ctx.fail(e);
    }
  }
  async function sheetToCanvas() {
    let made;
    try {
      made = await sheet();
    } catch (e) {
      return ctx.fail(e);
    }
    const project = ctx.project();
    const a = canvasAsset(made.canvas);
    const c = ctx.center();
    const scale = Math.max(1, Math.floor(512 / Math.max(a.width, a.height)));
    const layer: Layer = Object.assign(newLayer("image", c.x - (a.width * scale) / 2, c.y - (a.height * scale) / 2), {
      assetId: a.id,
      width: a.width * scale,
      height: a.height * scale,
      name: `${made.sprite.name} · sheet`,
      ...(made.sprite.pixelated ? { pixelated: true } : {}),
    });
    ctx.commit(() => {
      project.assets[a.id] = a;
      project.layers.push(layer);
    });
    ctx.toast("Sprite sheet placed on the canvas.");
  }

  // ── Effect preview (current frame, at most 640 px) ──────────────────────────────────────
  let previewKey = "",
    previewCanvas: HTMLCanvasElement | null = null,
    previewTimer = 0;
  function wantedPreviewKey() {
    const s = live();
    if (!s || tab !== "Effects" || !showFx.checked) return "";
    return JSON.stringify([s.frames[cur]?.assetId, effects.stack(), effects.seed(), vary.checked, cur, s.frames.length]);
  }
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = window.setTimeout(async () => {
      const key = wantedPreviewKey();
      if (!key || key === previewKey) return draw();
      const s = live()!;
      const asset = ctx.project().assets[s.frames[cur].assetId];
      const src = await assetCanvas(asset);
      const k = Math.min(1, 640 / Math.max(src.width, src.height));
      const small = document.createElement("canvas");
      small.width = Math.max(1, Math.round(src.width * k));
      small.height = Math.max(1, Math.round(src.height * k));
      const g = small.getContext("2d", { willReadFrequently: true })!;
      g.imageSmoothingEnabled = !s.pixelated;
      g.drawImage(src, 0, 0, small.width, small.height);
      const seed = effects.seed();
      previewCanvas = pixelsCanvas(applyStack(canvasPixels(small), effects.stack(), vary.checked ? seed + cur * 7919 : seed, vary.checked ? cur / s.frames.length : 0));
      previewKey = key;
      draw();
    }, 90);
  }

  // ── Drawing ─────────────────────────────────────────────────────────────────────────────
  const signature = (s: Sprite) => s.frames.map((f) => `${f.assetId}:${f.duration ?? ""}`).join("|") + `#${s.fps}`;
  let shown = "";
  async function frameBox(s: Sprite) {
    const imgs = s.frames.map((f) => ctx.project().assets[f.assetId]);
    return { width: Math.max(...imgs.map((a) => a.width)), height: Math.max(...imgs.map((a) => a.height)) };
  }
  function drawFrame(g: CanvasRenderingContext2D, asset: Asset | undefined, box: { width: number; height: number }, alpha = 1, image?: CanvasImageSource) {
    if (!asset) return;
    const img = image ?? assetImage(asset);
    if (!image && (!(img as HTMLImageElement).complete || !(img as HTMLImageElement).naturalWidth)) return;
    g.globalAlpha = alpha;
    g.drawImage(img, Math.floor((box.width - asset.width) / 2), box.height - asset.height, asset.width, asset.height);
    g.globalAlpha = 1;
  }
  function draw() {
    const s = live();
    if (!s || !s.frames.length) return;
    const project = ctx.project();
    const assets = s.frames.map((f) => project.assets[f.assetId]);
    const box = { width: Math.max(...assets.map((a) => a?.width ?? 1)), height: Math.max(...assets.map((a) => a?.height ?? 1)) };
    if (stage.width !== box.width || stage.height !== box.height) {
      stage.width = box.width;
      stage.height = box.height;
    }
    stage.classList.toggle("crisp", !!s.pixelated);
    const g = stage.getContext("2d")!;
    g.clearRect(0, 0, box.width, box.height);
    g.imageSmoothingEnabled = !s.pixelated;
    if (onion.checked && !playing && s.frames.length > 1) {
      drawFrame(g, assets[(cur - 1 + assets.length) % assets.length], box, 0.28);
      drawFrame(g, assets[(cur + 1) % assets.length], box, 0.12);
    }
    const preview = !playing && previewCanvas && previewKey && previewKey === wantedPreviewKey() ? previewCanvas : undefined;
    drawFrame(g, assets[cur], box, onion.checked && !playing ? 0.92 : 1, preview);
    counter.textContent = `${cur + 1} / ${s.frames.length}`;
  }
  function renderTimeline(s: Sprite) {
    const project = ctx.project();
    const durations = frameDurations(s.frames, s.fps);
    timeline.replaceChildren(
      ...s.frames.map((f, i) => {
        const img = assetImage(project.assets[f.assetId]).cloneNode() as HTMLImageElement;
        img.draggable = false;
        if (s.pixelated) img.style.imageRendering = "pixelated";
        const cell = h(
          "button",
          { type: "button", class: "fe-frame", draggable: true, role: "option", "data-index": i, title: `Frame ${i + 1}` },
          img,
          h("span", { class: "fe-frame-meta" }, h("b", { text: String(i + 1) }), h("small", { text: `${Math.round(durations[i])} ms${f.duration ? " ·" : ""}` })),
        );
        cell.onclick = (e) => setSelection(i, e);
        cell.ondragstart = (e) => {
          dragFrom = selection.has(i) ? picked() : [i];
          e.dataTransfer?.setData("text/plain", "frames");
          if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
        };
        cell.ondragover = (e) => {
          if (!dragFrom) return;
          e.preventDefault();
          const r = cell.getBoundingClientRect();
          const after = e.clientX > r.left + r.width / 2;
          timeline.querySelectorAll(".drop-before, .drop-after").forEach((x) => x.classList.remove("drop-before", "drop-after"));
          cell.classList.add(after ? "drop-after" : "drop-before");
        };
        cell.ondragleave = () => cell.classList.remove("drop-before", "drop-after");
        cell.ondrop = (e) => {
          e.preventDefault();
          const r = cell.getBoundingClientRect();
          moveFrames(dragFrom ?? [], e.clientX > r.left + r.width / 2 ? i + 1 : i);
          dragFrom = null;
        };
        cell.ondragend = () => {
          dragFrom = null;
          timeline.querySelectorAll(".drop-before, .drop-after").forEach((x) => x.classList.remove("drop-before", "drop-after"));
        };
        return cell;
      }),
    );
  }
  /** Move frames (by index) so they sit before position `to` (indices of the current order). */
  function moveFrames(from: number[], to: number) {
    if (!from.length) return;
    const s = live();
    if (!s) return;
    const moving = new Set(from);
    const target = to - from.filter((i) => i < to).length;
    edit((x) => {
      const picked = x.frames.filter((_, i) => moving.has(i));
      const rest = x.frames.filter((_, i) => !moving.has(i));
      rest.splice(target, 0, ...picked);
      x.frames = rest;
    });
    selection = new Set(from.map((_, k) => target + k));
    cur = target;
    refresh();
  }
  function refresh() {
    const s = live();
    if (!s) {
      dialog.close();
      return;
    }
    if (!s.frames.length) return;
    cur = Math.max(0, Math.min(cur, s.frames.length - 1));
    selection = new Set([...selection].filter((i) => i < s.frames.length));
    if (!selection.size) selection.add(cur);
    if (document.activeElement !== name) name.value = s.name;
    if (document.activeElement !== fps) fps.value = String(s.fps);
    loop.checked = s.loop;
    const sig = signature(s) + (s.pixelated ? "p" : "");
    if (sig !== shown) {
      renderTimeline(s);
      shown = sig;
      const sizes = gifSizes(s, Math.max(...s.frames.map((f) => ctx.project().assets[f.assetId].width)), Math.max(...s.frames.map((f) => ctx.project().assets[f.assetId].height)));
      const keep = gifSize.value;
      gifSize.replaceChildren(...sizes.map((o) => h("option", { value: o.value, text: o.text, selected: keep ? o.value === keep : o.selected })));
      if (keep && ![...gifSize.options].some((o) => o.value === keep)) gifSize.value = sizes.find((o) => o.selected)!.value;
    }
    timeline.querySelectorAll<HTMLElement>(".fe-frame").forEach((el) => {
      const i = +el.dataset.index!;
      el.classList.toggle("selected", selection.has(i));
      el.classList.toggle("current", i === cur);
      el.setAttribute("aria-selected", String(selection.has(i)));
    });
    timeline.querySelector<HTMLElement>(".fe-frame.current")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    const p = picked();
    const durs = p.map((i) => frameDurations(s.frames, s.fps)[i]);
    if (document.activeElement !== duration) duration.value = String(Math.round(durs[0] ?? 1000 / s.fps));
    framePane.querySelector("#fe-selection-note")!.textContent =
      p.length > 1 ? `${p.length} frames selected (${p.map((i) => i + 1).join(", ")}).` : `Frame ${cur + 1} of ${s.frames.length}.`;
    const total = frameDurations(s.frames, s.fps).reduce((a, b) => a + b, 0);
    exportPane.querySelector("#fe-gif-note")!.textContent = `${s.frames.length} frames · ${(total / 1000).toFixed(2)} s${s.loop ? " · loops" : " · plays once"}.`;
    if (tab === "Effects") schedulePreview();
    draw();
  }

  // Playback clock
  let raf = 0,
    clock = 0,
    last = performance.now();
  function loopTick(now: number) {
    const dt = now - last;
    last = now;
    const s = live();
    if (playing && s && s.frames.length > 1) {
      clock += dt;
      const d = frameDurations(s.frames, s.fps);
      if (clock >= d[cur]) {
        clock = 0;
        if (cur === s.frames.length - 1 && !s.loop) setPlaying(false);
        else cur = (cur + 1) % s.frames.length;
        selection = new Set([cur]);
        counter.textContent = `${cur + 1} / ${s.frames.length}`;
        timeline.querySelectorAll<HTMLElement>(".fe-frame").forEach((el) => {
          el.classList.toggle("current", +el.dataset.index! === cur);
          el.classList.toggle("selected", +el.dataset.index! === cur);
        });
      }
    }
    draw();
    raf = requestAnimationFrame(loopTick);
  }

  setTab("Frame");
  refresh();
  dialog.showModal();
  raf = requestAnimationFrame(loopTick);
  return dialog;
}
