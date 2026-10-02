/**
 * Edit → Glitch & filters: stack glitch effects on the selected image layer with a live
 * preview, apply them as a new version (original kept) or a new layer, or turn the layer into
 * a looping glitch animation that opens in the frame editor.
 */
import type { Layer, Sprite } from "./model.ts";
import type { StudioContext } from "./studio-context.ts";
import { h } from "./studio-context.ts";
import { applyStack, glitchFrames, type Rhythm } from "./glitch.ts";
import { stackEditor } from "./glitch-ui.ts";
import { bakedLayerCanvas } from "./layer-ai.ts";
import { canvasPixels, pixelsCanvas } from "./sprites.ts";
import { canvasAsset } from "./frames.ts";
import { openFrameEditor } from "./frame-editor.ts";

const tick = () => new Promise((r) => setTimeout(r, 0));

function scaled(source: HTMLCanvasElement, edge: number, crisp: boolean) {
  const k = Math.min(1, edge / Math.max(source.width, source.height));
  if (k === 1) return source;
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(source.width * k));
  c.height = Math.max(1, Math.round(source.height * k));
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.imageSmoothingEnabled = !crisp;
  g.imageSmoothingQuality = "high";
  g.drawImage(source, 0, 0, c.width, c.height);
  return c;
}

export function installGlitchPanel(ctx: StudioContext) {
  const actions = document.getElementById("image-edit-actions")!;
  const preview = h("canvas", { class: "glitch-preview", id: "glitch-preview", "aria-label": "Effect preview (hold to compare with the original)" }) as HTMLCanvasElement;
  const effects = stackEditor(() => schedule(), "glitch");
  const apply = h("button", { type: "button", class: "primary", id: "glitch-apply", text: "Apply to layer" });
  const copy = h("button", { type: "button", class: "quiet", id: "glitch-copy", text: "As new layer" });
  const frames = h("select", { id: "glitch-frames", "aria-label": "Frames" }, ...[8, 12, 16, 24].map((n) => h("option", { value: n, text: `${n} frames`, selected: n === 12 }))) as HTMLSelectElement;
  const rhythmPick = h("select", { id: "glitch-rhythm", "aria-label": "Rhythm" },
    h("option", { value: "bursts", text: "Bursts" }), h("option", { value: "steady", text: "Steady" }), h("option", { value: "pulse", text: "Pulse" })) as HTMLSelectElement;
  const fps = h("select", { id: "glitch-fps", "aria-label": "Speed" }, ...[8, 12, 15, 24].map((n) => h("option", { value: n, text: `${n} fps`, selected: n === 12 }))) as HTMLSelectElement;
  const edge = h("select", { id: "glitch-size", "aria-label": "Frame size" }, ...[256, 512, 768, 1024].map((n) => h("option", { value: n, text: `up to ${n} px`, selected: n === 512 }))) as HTMLSelectElement;
  const animate = h("button", { type: "button", class: "quiet full", id: "glitch-animate", text: "✦ Make glitch animation ↗" });
  const status = h("p", { class: "subtle", id: "glitch-status", role: "status" });
  const card = h(
    "details",
    { class: "edit-card glitch-card", id: "glitch-card" },
    h("summary", { class: "card-heading" }, h("span", { class: "eyebrow", text: "GLITCH & FILTERS" }), h("span", { class: "card-tag", text: "new version · original kept" })),
    preview,
    effects.element,
    h("div", { class: "ai-row" }, copy, apply),
    h("div", { class: "card-heading" }, h("span", { class: "eyebrow", text: "ANIMATE" }), h("span", { class: "card-tag", text: "loop → frame editor · GIF" })),
    h("div", { class: "ai-row" }, frames, rhythmPick),
    h("div", { class: "ai-row" }, fps, edge),
    animate,
    status,
  ) as HTMLDetailsElement;
  (document.getElementById("upscale-card") ?? actions.lastElementChild)!.after(card);
  card.addEventListener("toggle", () => card.open && schedule());

  // Preview: the baked layer at most 360 px, recomputed when the layer or the stack changes.
  let source: { key: string; canvas: HTMLCanvasElement } | null = null;
  let result: HTMLCanvasElement | null = null;
  let timer = 0,
    comparing = false;
  const layerKey = (l: Layer) => `${l.id}:${l.assetId}:${l.layerMask?.assetId ?? ""}:${JSON.stringify(l.adjustments ?? {})}`;
  async function base(l: Layer) {
    const key = layerKey(l);
    if (source?.key === key) return source.canvas;
    const project = ctx.project();
    const baked = await bakedLayerCanvas(project.assets[l.assetId!], l, l.layerMask ? project.assets[l.layerMask.assetId] : undefined);
    source = { key, canvas: scaled(baked, 360, !!l.pixelated) };
    return source.canvas;
  }
  function schedule() {
    clearTimeout(timer);
    timer = window.setTimeout(async () => {
      const l = ctx.current();
      if (!card.open || !l?.assetId) return;
      const src = await base(l);
      result = pixelsCanvas(applyStack(canvasPixels(src), effects.stack(), effects.seed()));
      draw();
    }, 80);
  }
  function draw() {
    const show = comparing ? source?.canvas : result;
    if (!show) return;
    preview.width = show.width;
    preview.height = show.height;
    preview.getContext("2d")!.drawImage(show, 0, 0);
    preview.classList.toggle("crisp", !!ctx.current()?.pixelated);
  }
  const compare = (on: boolean) => () => {
    comparing = on;
    draw();
  };
  preview.onpointerdown = compare(true);
  preview.onpointerup = preview.onpointerleave = compare(false);

  async function full(l: Layer) {
    const project = ctx.project();
    return bakedLayerCanvas(project.assets[l.assetId!], l, l.layerMask ? project.assets[l.layerMask.assetId] : undefined);
  }
  async function finish(asNew: boolean) {
    const l = ctx.current();
    if (!l?.assetId || ctx.isLocked(l)) return;
    const stack = effects.stack();
    if (!stack.length) return ctx.toast("Add an effect first.");
    const project = ctx.project();
    status.textContent = "Applying to the full image…";
    apply.setAttribute("disabled", "");
    copy.setAttribute("disabled", "");
    try {
      await tick();
      const out = pixelsCanvas(applyStack(canvasPixels(await full(l)), stack, effects.seed()));
      if (ctx.project() !== project || !project.layers.includes(l)) return ctx.toast("The layer changed. Try again.");
      const a = canvasAsset(out);
      ctx.commit(() => {
        project.assets[a.id] = a;
        const target: Layer = asNew ? { ...structuredClone(l), id: crypto.randomUUID(), name: `${l.name.slice(0, 186)} · glitch` } : l;
        if (asNew) {
          project.layers.splice(project.layers.indexOf(l) + 1, 0, target);
          delete target.originalAssetId;
        } else target.originalAssetId ||= l.assetId;
        target.assetId = a.id;
        delete target.layerMask; // baked in
        delete target.adjustments;
      });
      if (asNew) ctx.select([project.layers[project.layers.indexOf(l) + 1].id]);
      ctx.toast(asNew ? "Glitched copy added above the layer." : "Effects applied. Restore original brings back the source.");
    } catch (e) {
      ctx.fail(e);
    } finally {
      status.textContent = "";
      apply.removeAttribute("disabled");
      copy.removeAttribute("disabled");
    }
  }
  apply.onclick = () => void finish(false);
  copy.onclick = () => void finish(true);

  animate.onclick = async () => {
    const l = ctx.current();
    if (!l?.assetId) return;
    const stack = effects.stack();
    if (!stack.length) return ctx.toast("Add an effect first.");
    const project = ctx.project();
    animate.setAttribute("disabled", "");
    status.textContent = "Making frames…";
    try {
      await tick();
      const src = scaled(await full(l), +edge.value, !!l.pixelated);
      const made = glitchFrames(canvasPixels(src), stack, { frames: +frames.value, rhythm: rhythmPick.value as Rhythm, seed: effects.seed() });
      const assets = made.map((p) => canvasAsset(pixelsCanvas(p)));
      if (ctx.project() !== project) return;
      const sprite: Sprite = {
        id: crypto.randomUUID(),
        name: `${l.name.slice(0, 180)} · glitch`,
        fps: +fps.value,
        loop: true,
        frames: assets.map((a) => ({ assetId: a.id })),
        ...(l.pixelated ? { pixelated: true } : {}),
      };
      ctx.commit(() => {
        assets.forEach((a) => (project.assets[a.id] = a));
        project.sprites.push(sprite);
      });
      ctx.render();
      openFrameEditor(ctx, sprite.id, () => ctx.render());
      ctx.toast(`${assets.length}-frame glitch animation created. Export it as a GIF from the frame editor.`);
    } catch (e) {
      ctx.fail(e);
    } finally {
      status.textContent = "";
      animate.removeAttribute("disabled");
    }
  };

  return {
    sync() {
      const l = ctx.current();
      const ok = !!l?.assetId && ctx.selectedLayers().length === 1;
      card.hidden = !ok;
      apply.toggleAttribute("disabled", !ok || (!!l && ctx.isLocked(l)));
      if (ok && card.open && (!source || source.key !== layerKey(l!))) schedule();
    },
  };
}
