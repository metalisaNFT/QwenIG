/**
 * Selection-panel cards for image layers: AI edit (engine) and pixel art (browser).
 * Both create new pixels without touching the source asset; Undo restores everything.
 */
import type { Asset, Layer } from "./model.ts";
import type { StudioContext } from "./studio-context.ts";
import { blobImage, h, jobView } from "./studio-context.ts";
import {
  editFrame,
  editModes,
  emptyArea,
  engineMaskForOutpaint,
  engineMaskFromArea,
  engineSource,
  layerMaskFromEngineMask,
  outpaintPlan,
  placeOutpaint,
  editOperation,
  type EditMode,
} from "./ai-edit.ts";
import type { PoseSpec } from "./pose.ts";
import { upscaleMetadata } from "./model.ts";
import { poseInstruction } from "./pose.ts";
import { openPoseEditor, poseImage } from "./pose-editor.ts";
import { engineUpload, dataUrlBytes } from "./background.ts";
import { openImageEditor } from "./image-editor.ts";
import { effectiveMask, loadAssetImage, maskedImage } from "./masking.ts";
import { adjustmentFilter } from "./adjustments.ts";
import { countColors, pixelArt, type PixelArtOptions } from "./pixel-art.ts";
import { canvasPixels, pixelsCanvas } from "./sprites.ts";
import { describeAsset, improveButton } from "./assist.ts";

/** The visible look of an image layer baked into pixels: mask and adjustments applied. */
export async function bakedLayerCanvas(asset: Asset, layer: Layer, maskAsset?: Asset) {
  const img = await loadAssetImage(asset);
  let source: HTMLImageElement | HTMLCanvasElement = img;
  if (layer.layerMask?.enabled && maskAsset) {
    const mask = await loadAssetImage(maskAsset);
    source = maskedImage(img, effectiveMask(mask, img.naturalWidth, img.naturalHeight, layer.layerMask));
  }
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.filter = adjustmentFilter(layer.adjustments);
  ctx.drawImage(source, 0, 0);
  ctx.filter = "none";
  return c;
}

export function installLayerAI(ctx: StudioContext) {
  const actions = document.getElementById("image-edit-actions")!;
  const pixelsCard = actions.querySelector(".pixels-card")!;

  // ── AI edit card ───────────────────────────────────────────────────────────
  let mode: EditMode = "edit";
  const poses = new Map<string, PoseSpec>(); // `${layerId}:${assetId}` → pose for "Change the pose"
  const areas = new Map<string, Asset>(); // `${layerId}:${assetId}` → marked area
  const modeButtons = editModes.map((m) =>
    h("button", { type: "button", class: "chip", "data-mode": m.id, text: m.label }),
  );
  const hint = h("p", { class: "subtle", id: "ai-edit-hint" });
  const prompt = h("textarea", {
    id: "ai-edit-prompt",
    rows: 3,
    maxlength: 20000,
    "aria-label": "What should change",
    placeholder: "Describe the change…",
  }) as HTMLTextAreaElement;
  const areaButton = h("button", { type: "button", class: "quiet", id: "ai-edit-area", text: "Mark area ↗" });
  const areaClear = h("button", { type: "button", class: "quiet tiny", id: "ai-edit-area-clear", text: "Clear" });
  const areaStatus = h("span", { class: "subtle", id: "ai-edit-area-status" });
  const areaRow = h("div", { class: "ai-row", id: "ai-edit-area-row" }, areaButton, areaStatus, areaClear);
  const poseButton = h("button", { type: "button", class: "quiet", id: "ai-edit-pose", text: "Set pose ↗" });
  const poseStatus = h("span", { class: "subtle", id: "ai-edit-pose-status" });
  const poseRow = h("div", { class: "ai-row", id: "ai-edit-pose-row" }, poseButton, poseStatus);
  const sideBoxes = (["left", "right", "top", "bottom"] as const).map((side) =>
    h("label", { class: "check" }, h("input", { type: "checkbox", "data-side": side, checked: side === "left" || side === "right" }), side[0].toUpperCase() + side.slice(1)),
  );
  const amount = h("select", { id: "ai-edit-amount", "aria-label": "How far to extend" },
    h("option", { value: "0.25", text: "+25%" }), h("option", { value: "0.5", text: "+50%", selected: true }), h("option", { value: "1", text: "+100%" }));
  const sidesRow = h("div", { class: "ai-row", id: "ai-edit-sides" }, ...sideBoxes, amount);
  const strength = h("input", { type: "range", id: "ai-edit-strength", min: 5, max: 100, value: 60, "aria-label": "Strength" }) as HTMLInputElement;
  const strengthValue = h("span", { id: "ai-edit-strength-value" });
  const strengthRow = h("label", { class: "ai-slider", id: "ai-edit-strength-row" }, "Strength", strength, strengthValue);
  const size = h("select", { id: "ai-edit-size", "aria-label": "Edit resolution" },
    h("option", { value: "1024", text: "Detail · 1K", selected: true }), h("option", { value: "1536", text: "High · 1.5K" }), h("option", { value: "2048", text: "Maximum · 2K" }));
  const transparent = h("input", { type: "checkbox", id: "ai-edit-transparent" }) as HTMLInputElement;
  const transparentRow = h("label", { class: "check", id: "ai-edit-transparent-row" }, transparent, "Transparent background");
  const promptImprove = improveButton(ctx, prompt, "edit");
  const describeImage = h("button", { type: "button", class: "quiet", id: "describe-image", text: "→ Image prompt" });
  const describeVideo = h("button", { type: "button", class: "quiet", id: "describe-video", text: "→ Video prompt" });
  const describeRow = h("div", { class: "ai-row", id: "describe-row" }, h("span", { class: "subtle", text: "Describe this layer" }), describeImage, describeVideo);
  const run = h("button", { type: "button", class: "primary full", id: "ai-edit-run", text: "✦ Edit with AI" });
  const { element: jobEl, view } = jobView("ai-edit");
  const status = h("p", { class: "subtle", id: "ai-edit-status" });
  const card = h(
    "div",
    { class: "edit-card ai-edit-card", id: "ai-edit-card" },
    h("div", { class: "card-heading" }, h("span", { class: "eyebrow", text: "AI EDIT" }), h("span", { class: "card-tag", text: "new layer · source kept" })),
    h("div", { class: "chips", role: "radiogroup", "aria-label": "AI edit mode" }, ...modeButtons),
    hint,
    promptImprove.element,
    prompt,
    areaRow,
    poseRow,
    sidesRow,
    strengthRow,
    h("div", { class: "ai-row" }, size, transparentRow),
    run,
    jobEl,
    status,
    describeRow,
  );
  pixelsCard.before(card); // AI edit leads: it is what most layers are opened for

  async function describeInto(purpose: "image" | "video") {
    const l = ctx.current();
    if (!l?.assetId) return;
    const button = purpose === "image" ? describeImage : describeVideo;
    const label = button.textContent;
    button.textContent = "Looking…";
    try {
      const text = await describeAsset(ctx, ctx.project().assets[l.assetId], purpose);
      if (!text) return;
      const field = document.getElementById(purpose === "image" ? "prompt" : "video-prompt") as HTMLTextAreaElement | null;
      if (!field) return;
      field.value = text;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      ctx.showTab(purpose === "image" ? "create" : "animate");
      ctx.toast(purpose === "image" ? "Description is in the prompt. Adjust it and Generate." : "Description is in the video prompt. Tick “Start from the selected image” to animate this layer.");
    } catch (e) {
      ctx.fail(e);
    } finally {
      button.textContent = label;
    }
  }
  describeImage.onclick = () => void describeInto("image");
  describeVideo.onclick = () => void describeInto("video");

  const areaKey = (l: Layer) => `${l.id}:${l.assetId}`;
  function sync() {
    const l = ctx.current();
    const caps = ctx.capabilities();
    const spec = editModes.find((m) => m.id === mode)!;
    modeButtons.forEach((b) => {
      const on = b.dataset.mode === mode;
      b.classList.toggle("active", on);
      b.setAttribute("aria-checked", String(on));
      b.setAttribute("role", "radio");
    });
    hint.textContent = spec.hint;
    areaRow.hidden = mode !== "inpaint";
    poseRow.hidden = mode !== "repose";
    const pose = l && poses.get(areaKey(l));
    poseStatus.textContent = pose ? "Pose set" : "No pose yet";
    sidesRow.hidden = mode !== "outpaint";
    strengthRow.hidden = !["image-to-image", "variations"].includes(mode);
    strengthValue.textContent = `${strength.value}%`;
    transparentRow.hidden = !caps.includes("transparent") && !!ctx.service();
    const area = l && areas.get(areaKey(l));
    areaStatus.textContent = area ? "Area marked" : "No area marked yet";
    areaClear.hidden = !area;
    const engine = ctx.service();
    const offered = caps.includes(editOperation(mode));
    const busy = ctx.busy();
    run.disabled = !l?.assetId || !engine || !offered || busy || (!!l && ctx.isLocked(l)) || (mode === "inpaint" && !area) ||
      (mode === "repose" && !pose);
    promptImprove.sync();
    const canUpscale = !!engine && caps.includes("upscale");
    up2.disabled = up4.disabled = !l?.assetId || !canUpscale || busy;
    upStatus.textContent = !engine
      ? "Connect your engine to upscale."
      : !caps.includes("upscale")
        ? "Not on this engine yet: turn on ENABLE_UPSCALE in the notebook and reconnect."
        : l?.assetId
          ? `${ctx.project().assets[l.assetId]?.width ?? 0} × ${ctx.project().assets[l.assetId]?.height ?? 0} px now.`
          : "";
    promptImprove.element.hidden = !!engine && !caps.includes("enhance-prompt");
    describeRow.hidden = !!engine && !caps.includes("describe");
    describeImage.disabled = describeVideo.disabled = !l?.assetId || busy;
    status.textContent = !engine
      ? "Connect your engine to edit with AI."
      : !offered
        ? editOperation(mode) === "edit"
          ? "Instruction edits need the vision encoder: run the notebook with ENABLE_REFERENCES and reconnect."
          : "This engine cannot do this edit yet. Run the updated Colab notebook and reconnect."
        : busy && view.panel.hidden
          ? "Your engine is busy with another job."
          : mode === "inpaint" && !area
            ? "Mark the area to change first."
            : mode === "repose" && !pose
              ? "Set the pose first."
              : "";
  }
  modeButtons.forEach(
    (b) =>
      (b.onclick = () => {
        mode = b.dataset.mode as EditMode;
        const spec = editModes.find((m) => m.id === mode)!;
        if (spec.strength) strength.value = String(Math.round(spec.strength * 100));
        sync();
      }),
  );
  strength.oninput = sync;

  areaButton.onclick = async () => {
    const l = ctx.current();
    if (!l?.assetId) return;
    const asset = ctx.project().assets[l.assetId];
    const existing = areas.get(areaKey(l)) ?? { id: "area", ...emptyArea(asset.width, asset.height) };
    try {
      await openImageEditor(
        asset,
        (marked) => {
          areas.set(areaKey(l), { id: "area", ...marked });
          sync();
          ctx.toast("Area marked. Describe what belongs there, then Edit with AI.");
        },
        "erase",
        { mask: existing, region: true },
        { adjustments: l.adjustments },
      );
    } catch (e) {
      ctx.fail(e);
    }
  };
  poseButton.onclick = async () => {
    const l = ctx.current();
    if (!l?.assetId) return;
    const asset = ctx.project().assets[l.assetId];
    const frame = editFrame(asset.width, asset.height, 768);
    const existing = poses.get(areaKey(l));
    const spec = await openPoseEditor(ctx, {
      width: frame.width,
      height: frame.height,
      pose: existing ?? null,
      background: asset,
      title: "Change the pose.",
      detectOnOpen: !existing,
    });
    if (spec) {
      poses.set(areaKey(l), spec);
      ctx.toast("Pose set. Add anything else to change, then Edit with AI.");
    }
    sync();
  };
  areaClear.onclick = () => {
    const l = ctx.current();
    if (l) areas.delete(areaKey(l));
    sync();
  };

  run.onclick = async () => {
    const l = ctx.current();
    const project = ctx.project();
    if (!l?.assetId) return;
    const asset = project.assets[l.assetId];
    const pose = mode === "repose" ? poses.get(areaKey(l)) : undefined;
    if (mode === "repose" && !pose) return ctx.toast("Set the pose first.");
    const typed = prompt.value.trim();
    const text = pose ? `${poseInstruction(2, true)}${typed ? ` Also: ${typed}` : ""}` : typed || (mode === "variations" ? l.metadata?.prompt ?? "" : "");
    if (!text) return ctx.toast("Describe what you want first.");
    const longEdge = +size.value;
    const projectId = project.id,
      assetId = l.assetId;
    try {
      let plan: ReturnType<typeof outpaintPlan> | undefined;
      let frame = editFrame(asset.width, asset.height, longEdge);
      let mask: string | undefined;
      if (mode === "outpaint") {
        const sides = Object.fromEntries(
          sideBoxes.map((label) => {
            const box = label.querySelector("input")!;
            return [box.dataset.side!, box.checked ? +amount.value : 0];
          }),
        ) as Record<"left" | "right" | "top" | "bottom", number>;
        if (!Object.values(sides).some(Boolean)) return ctx.toast("Choose at least one side to extend.");
        plan = outpaintPlan(asset.width, asset.height, sides);
        frame = editFrame(plan.width, plan.height, longEdge);
        mask = engineMaskForOutpaint(frame, plan, asset.width, asset.height);
      } else if (mode === "inpaint") {
        const area = areas.get(areaKey(l));
        if (!area) return ctx.toast("Mark the area to change first.");
        const prepared = await engineMaskFromArea(area, frame);
        if (prepared.fraction < 0.001) return ctx.toast("The marked area is empty. Mark what should change.");
        mask = prepared.data;
      }
      const image = await engineSource(asset, frame, plan, transparent.checked);
      const settings = {
        ...project.settings,
        prompt: text,
        width: frame.width,
        height: frame.height,
        seed: -1,
        transparent: transparent.checked || undefined,
      };
      const chosenStrength = ["image-to-image", "variations"].includes(mode) ? +strength.value / 100 : undefined;
      const operation = editOperation(mode);
      const label = editModes.find((m) => m.id === mode)!.label;
      const reference_images = pose ? [poseImage(pose, frame.width, frame.height)] : undefined;
      await ctx.runJob(
        (engine) => engine.edit({ ...settings, operation, image, mask, strength: chosenStrength, ...(reference_images ? { reference_images } : {}) }),
        view,
        async (job, engine) => {
          const result = await blobImage(await engine.output(job.output_id!));
          const current = ctx.project();
          if (current.id !== projectId) throw Error("The project changed before the edit arrived.");
          const id = crypto.randomUUID();
          const resultMask = mask ? await layerMaskFromEngineMask(mask, result.width, result.height) : undefined;
          // Follow the source as it is now (it may have moved, been regrouped or deleted meanwhile).
          const live = current.layers.find((x) => x.id === l.id);
          const source = structuredClone(live ?? l);
          if (source.groupId && !current.groups.some((g) => g.id === source.groupId)) source.groupId = null;
          const placed = plan
            ? placeOutpaint(source, asset, plan)
            : { x: source.x, y: source.y, width: source.width, height: source.height };
          const layer: Layer = {
            ...source,
            id: crypto.randomUUID(),
            name: `${label} · ${pose ? typed || "new pose" : text}`.slice(0, 200),
            assetId: id,
            ...placed,
            metadata: structuredClone(job.metadata),
          };
          delete layer.originalAssetId;
          delete layer.layerMask;
          delete layer.adjustments;
          delete layer.pixelated;
          layer.locked = false;
          ctx.commit(() => {
            current.assets[id] = { id, ...result };
            current.gallery.push({ id: job.id, assetId: id, metadata: job.metadata });
            if (resultMask) {
              const maskId = crypto.randomUUID();
              current.assets[maskId] = { id: maskId, ...resultMask };
              // The regenerated area only, softly blended: outside pixels stay the source's.
              layer.layerMask = { assetId: maskId, enabled: true, feather: Math.max(2, Math.round(result.width / 256)) };
            }
            const at = current.layers.findIndex((x) => x.id === source.id);
            current.layers.splice(at >= 0 ? at + 1 : current.layers.length, 0, layer);
          });
          ctx.select([layer.id]);
          if (plan) ctx.fit(true);
          ctx.toast(
            job.metadata.demo
              ? "Demo edit added as a new layer (procedural, not AI)."
              : resultMask
                ? "Edit added as a new layer above the source, masked to the changed area."
                : "Edit added as a new layer above the source.",
          );
          if (live && assetId !== live.assetId) ctx.toast("Note: the source changed while editing; the edit used the earlier pixels.");
        },
      );
    } catch (e) {
      ctx.fail(e);
    } finally {
      sync();
    }
  };

  // ── Pixel art card ─────────────────────────────────────────────────────────
  const pixelOpen = h("button", { type: "button", class: "quiet full", id: "pixel-art-open", text: "▦ Make pixel art ↗" });
  const crisp = h("input", { type: "checkbox", id: "layer-pixelated" }) as HTMLInputElement;
  const pixelCard = h(
    "div",
    { class: "edit-card pixel-card", id: "pixel-card" },
    h("div", { class: "card-heading" }, h("span", { class: "eyebrow", text: "PIXEL ART" }), h("span", { class: "card-tag", text: "new version · original kept" })),
    pixelOpen,
    h("label", { class: "check" }, crisp, "Crisp pixels on the canvas and in exports"),
  );
  actions.append(pixelCard); // after pixels, adjustments and the mask

  // ── Upscale card ────────────────────────────────────────────────────────────
  const up2 = h("button", { type: "button", class: "quiet", id: "upscale-2", text: "×2" });
  const up4 = h("button", { type: "button", class: "quiet", id: "upscale-4", text: "×4" });
  const { element: upJobEl, view: upView } = jobView("upscale");
  const upStatus = h("p", { class: "subtle", id: "upscale-status" });
  const upCard = h(
    "div",
    { class: "edit-card upscale-card", id: "upscale-card" },
    h("div", { class: "card-heading" }, h("span", { class: "eyebrow", text: "UPSCALE" }), h("span", { class: "card-tag", text: "new layer · same size on canvas" })),
    h("div", { class: "ai-row" }, h("span", { class: "subtle", text: "More pixels, sharper detail" }), up2, up4),
    upJobEl,
    upStatus,
  );
  card.after(upCard);

  /** The layer's own pixels for the engine: unchanged when they fit the API limits. */
  async function upscaleSource(asset: Asset) {
    const ok = /^data:image\/(png|jpeg|webp);base64,/.test(asset.data) && dataUrlBytes(asset.data) <= 8 * 1024 * 1024 && Math.max(asset.width, asset.height) <= 4096;
    if (ok) return { data: asset.data, width: asset.width, height: asset.height, reduced: false };
    const upload = await engineUpload(asset);
    return { ...upload, reduced: true };
  }

  async function runUpscale(scale: 2 | 4) {
    const l = ctx.current();
    const project = ctx.project();
    if (!l?.assetId) return;
    const asset = project.assets[l.assetId];
    const projectId = project.id;
    try {
      const source = await upscaleSource(asset);
      const w = source.width * scale,
        hgt = source.height * scale;
      if (Math.max(w, hgt) > 8192 || w * hgt > 48_000_000)
        return ctx.toast(`×${scale} would make ${w} × ${hgt} pixels, over the 8192 px / 48 MP limit. Try ×2.`);
      await ctx.runJob(
        (engine) => engine.upscale(source.data, scale),
        upView,
        async (job, engine) => {
          const result = await blobImage(await engine.output(job.output_id!));
          const current = ctx.project();
          if (current.id !== projectId) throw Error("The project changed before the upscale arrived.");
          const live = current.layers.find((x) => x.id === l.id);
          const sourceLayer = structuredClone(live ?? l);
          if (sourceLayer.groupId && !current.groups.some((g) => g.id === sourceLayer.groupId)) sourceLayer.groupId = null;
          const id = crypto.randomUUID();
          const metadata = upscaleMetadata(job.metadata as any, sourceLayer.metadata, current.settings);
          const layer: Layer = {
            ...sourceLayer,
            id: crypto.randomUUID(),
            name: `${sourceLayer.name} · ×${scale}`.slice(0, 200),
            assetId: id,
            metadata,
          };
          delete layer.originalAssetId;
          delete layer.pixelated;
          layer.locked = false;
          ctx.commit(() => {
            current.assets[id] = { id, ...result };
            current.gallery.push({ id: job.id, assetId: id, metadata: structuredClone(metadata) });
            const at = current.layers.findIndex((x) => x.id === sourceLayer.id);
            current.layers.splice(at >= 0 ? at + 1 : current.layers.length, 0, layer);
          });
          ctx.select([layer.id]);
          ctx.toast(
            job.metadata.demo
              ? "Demo upscale added (resized, not AI)."
              : `Upscaled to ${result.width} × ${result.height} as a new layer above the source${source.reduced ? " (the source was reduced to fit the upload limit first)" : ""}.`,
          );
        },
      );
    } catch (e) {
      ctx.fail(e);
    } finally {
      sync();
    }
  }
  up2.onclick = () => void runUpscale(2);
  up4.onclick = () => void runUpscale(4);
  crisp.onchange = () => {
    const l = ctx.current();
    if (!l?.assetId || ctx.isLocked(l)) return;
    ctx.commit(() => {
      if (crisp.checked) l.pixelated = true;
      else delete l.pixelated;
    });
  };
  pixelOpen.onclick = () => {
    const l = ctx.current();
    if (l?.assetId) void openPixelArt(ctx, l);
  };

  return {
    sync() {
      const l = ctx.current();
      sync();
      crisp.checked = !!l?.pixelated;
      crisp.disabled = pixelOpen.disabled = !l?.assetId || (!!l && ctx.isLocked(l));
    },
  };
}

// ── Pixel art dialog ───────────────────────────────────────────────────────────

let dialog: HTMLDialogElement | null = null;

export async function openPixelArt(ctx: StudioContext, layer: Layer) {
  const project = ctx.project();
  const asset = project.assets[layer.assetId!];
  const baked = await bakedLayerCanvas(asset, layer, layer.layerMask ? project.assets[layer.layerMask.assetId] : undefined);
  // Work from at most 1024 px: pixel art is small, and detection stays fast.
  const scale = Math.min(1, 1024 / Math.max(baked.width, baked.height));
  const work = document.createElement("canvas");
  work.width = Math.round(baked.width * scale);
  work.height = Math.round(baked.height * scale);
  const wctx = work.getContext("2d", { willReadFrequently: true })!;
  wctx.imageSmoothingQuality = "high";
  wctx.drawImage(baked, 0, 0, work.width, work.height);
  const source = canvasPixels(work);

  dialog?.remove();
  const method = h("select", { id: "pixel-method", "aria-label": "Method" },
    h("option", { value: "resize", text: "Downscale (any image)" }),
    h("option", { value: "snap", text: "Snap AI pixel art to its grid" })) as HTMLSelectElement;
  const width = h("input", { type: "range", id: "pixel-width", min: 8, max: 256, value: 64 }) as HTMLInputElement;
  const widthValue = h("span");
  const block = h("input", { type: "number", id: "pixel-block", min: 0, max: 64, value: 0, title: "0 = detect automatically" }) as HTMLInputElement;
  const colors = h("select", { id: "pixel-colors", "aria-label": "Colours" },
    ...[0, 4, 8, 12, 16, 24, 32, 48, 64].map((n) => h("option", { value: n, text: n ? `${n} colours` : "Keep colours", selected: n === 16 }))) as HTMLSelectElement;
  const dither = h("input", { type: "range", id: "pixel-dither", min: 0, max: 100, value: 0 }) as HTMLInputElement;
  const outlineSelect = h("select", { id: "pixel-outline", "aria-label": "Outline" },
    h("option", { value: "none", text: "No outline" }), h("option", { value: "auto", text: "Dark outline" }), h("option", { value: "black", text: "Black outline" })) as HTMLSelectElement;
  const before = h("canvas", { class: "pixel-preview", "aria-label": "Before" }) as HTMLCanvasElement;
  const after = h("canvas", { class: "pixel-preview crisp", "aria-label": "After" }) as HTMLCanvasElement;
  const info = h("p", { class: "subtle", id: "pixel-info", role: "status" });
  const apply = h("button", { type: "button", class: "primary", id: "pixel-apply", text: "Apply to layer" });
  const copy = h("button", { type: "button", class: "quiet", id: "pixel-copy", text: "Keep as new layer" });
  const cancel = h("button", { type: "button", class: "quiet", text: "Cancel" });
  dialog = h(
    "dialog",
    { class: "pixel-dialog", "aria-label": "Pixel art" },
    h("div", { class: "dialog-heading" }, h("span", { class: "eyebrow", text: "PIXEL ART" }), h("h2", { text: "Every pixel on purpose." })),
    h("div", { class: "pixel-previews" }, h("figure", {}, before, h("figcaption", { text: "Before" })), h("figure", {}, after, h("figcaption", { text: "After · enlarged" }))),
    h(
      "div",
      { class: "pixel-controls" },
      h("label", {}, "Method", method),
      h("label", { id: "pixel-width-row" }, "Width in pixels", width, widthValue),
      h("label", { id: "pixel-block-row" }, "Block size (0 = detect)", block),
      h("label", {}, "Palette", colors),
      h("label", {}, "Dithering", dither),
      h("label", {}, "Outline", outlineSelect),
    ),
    info,
    h("p", { class: "subtle", text: layer.layerMask || layer.adjustments ? "The layer's mask and adjustments are baked into the pixel art." : "Transparent areas stay transparent with hard edges." }),
    h("div", { class: "dialog-actions" }, cancel, copy, apply),
  );
  document.body.append(dialog);
  const bctx = before.getContext("2d")!;
  before.width = Math.min(320, work.width);
  before.height = Math.round((before.width * work.height) / work.width);
  bctx.drawImage(work, 0, 0, before.width, before.height);

  let result: ReturnType<typeof pixelArt> | null = null;
  let timer = 0;
  const options = (): PixelArtOptions => ({
    method: method.value as "resize" | "snap",
    targetWidth: +width.value,
    blockSize: +block.value,
    colors: +colors.value,
    dither: +dither.value / 100,
    outline: outlineSelect.value as PixelArtOptions["outline"],
  });
  const update = () => {
    (document.getElementById("pixel-width-row") as HTMLElement).hidden = method.value !== "resize";
    (document.getElementById("pixel-block-row") as HTMLElement).hidden = method.value !== "snap";
    widthValue.textContent = `${width.value} px`;
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      result = pixelArt(source, options());
      const r = result.pixels;
      const out = pixelsCanvas(r);
      const zoom = Math.max(1, Math.floor(320 / Math.max(r.width, r.height)));
      after.width = r.width * zoom;
      after.height = r.height * zoom;
      const actx = after.getContext("2d")!;
      actx.imageSmoothingEnabled = false;
      actx.drawImage(out, 0, 0, after.width, after.height);
      info.textContent = `${r.width} × ${r.height} pixels · ${countColors(r)} colours${result.blockSize ? ` · detected blocks of ${result.blockSize} px` : ""}`;
    }, 60);
  };
  for (const control of [method, width, block, colors, dither, outlineSelect]) control.oninput = update;
  update();
  cancel.onclick = () => dialog?.close();
  const finish = (asNewLayer: boolean) => {
    if (!result) return;
    const current = ctx.project();
    if (current.id !== project.id || !current.layers.includes(layer) || ctx.isLocked(layer))
      return ctx.toast("The layer changed. Open pixel art again.");
    const out = pixelsCanvas(result.pixels);
    const id = crypto.randomUUID();
    ctx.commit(() => {
      current.assets[id] = { id, data: out.toDataURL("image/png"), width: out.width, height: out.height };
      const target: Layer = asNewLayer
        ? { ...structuredClone(layer), id: crypto.randomUUID(), name: `${layer.name.slice(0, 186)} · pixel art` }
        : layer;
      if (asNewLayer) {
        const at = current.layers.indexOf(layer);
        current.layers.splice(at + 1, 0, target);
        delete target.originalAssetId;
      } else target.originalAssetId ||= layer.assetId;
      target.assetId = id;
      target.pixelated = true;
      delete target.layerMask;
      delete target.adjustments;
    });
    dialog?.close();
    ctx.toast(asNewLayer ? "Pixel art added as a new layer." : "Pixel art applied. Restore original brings back the source.");
  };
  apply.onclick = () => finish(false);
  copy.onclick = () => finish(true);
  dialog.addEventListener("close", () => dialog?.remove());
  dialog.showModal();
}
