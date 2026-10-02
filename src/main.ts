import "../styles.css";
import "./workshop.css";
import "./animate.css";
import "./audio.css";
import "./pose.css";
import "./frames.css";
import "./layout.css";
import {
  blankProject,
  newLayer,
  visible,
  locked,
  bounds,
  History,
  parseProject,
  upscaleMetadata,
  validateSettings,
  type Layer,
  type Settings,
  type Generation,
  defaultTextStyle,
  type TextStyle,
} from "./model.ts";
import { saveLocal, loadLocal, download, readData } from "./storage.ts";
import { openExport, openLibrary, openPaintLayer } from "./dialogs.ts";
import {
  alignLayers,
  reorderLayers,
  duplicateLayers,
  movable,
  notePalette,
  type Alignment,
} from "./operations.ts";
import { StudioService, type Job, type Task } from "./service.ts";
import { engineUpload, invertMask, maskFromMatte } from "./background.ts";
import { installToolIcons } from "./icons.ts";
import { openImageEditor } from "./image-editor.ts";
import { generationDimensions } from "./resolution.ts";
import { layerBounds, normalizeAngle, resizeFromCorner } from "./geometry.ts";
import { renderTextLayer } from "./typography.ts";
import { loadAssetImage, refinedMaskURL, transformMask } from "./masking.ts";
import { installLayerAI } from "./layer-ai.ts";
import { installAnimate } from "./animate.ts";
import { installAudio } from "./audio.ts";
import { improveButton } from "./assist.ts";
import { installPoseControls, poseForGeneration } from "./pose-panel.ts";
import { installGlitchPanel } from "./glitch-panel.ts";
import { releaseVideoURLs, videoURL } from "./video.ts";
import type { JobView, StudioContext } from "./studio-context.ts";
import {
  adjustmentFilter,
  adjustmentRanges,
  isActive,
  isNeutral,
  neutralAdjustments,
  type AdjustmentKey,
} from "./adjustments.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const input = (id: string) => $<HTMLInputElement>(id);
const button = (id: string) => $<HTMLButtonElement>(id);
const viewport = $("viewport"),
  world = $("world");
let project = blankProject(),
  selected = new Set<string>(),
  tool = "select",
  space = false;
const history = new History();
let service: StudioService | null = null,
  activeJob: string | null = null,
  generating = false;
let engineCapabilities: string[] = [];
// Feature panels (installed once the studio context exists, near the end of this module).
let layerAI: ReturnType<typeof installLayerAI> | undefined;
let glitchPanel: ReturnType<typeof installGlitchPanel> | undefined;
let animatePanel: ReturnType<typeof installAnimate> | undefined;
let audioPanel: ReturnType<typeof installAudio> | undefined;
let promptImprove: ReturnType<typeof improveButton> | undefined;
let poseControls: ReturnType<typeof installPoseControls> | undefined;
let engineMatting: "birefnet" | "demo" | undefined;
// One background removal at a time; tied to the layer and the pixels it was started for.
type BackgroundRun = { layerId: string; taskId?: string; cancelled: boolean };
let backgroundTask: BackgroundRun | null = null;
let toastTimer = 0,
  saveTimer = 0,
  dirty = false,
  saveRevision = 0;
function toast(message: string) {
  $("toast").textContent = message;
  $("toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(
    () => $("toast").classList.remove("show"),
    5000,
  );
}
function fail(e: unknown) {
  toast(
    e instanceof Error ? e.message : "Something went wrong. Please try again.",
  );
}
function autosave() {
  dirty = true;
  const revision = ++saveRevision;
  $("save-status").textContent = "Saving locally…";
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveLocal(project)
      .then(() => {
        if (revision === saveRevision) {
          dirty = false;
          $("save-status").textContent = "Saved on this device";
        }
      })
      .catch(() => {
        $("save-status").textContent = "Storage full — save a .zero file";
        toast(
          "Local save failed. Download your .zero project to keep your work.",
        );
      });
  }, 300);
}
function commit(action: () => void) {
  history.push(project);
  action();
  render();
  autosave();
}
function current() {
  return project.layers.find((l) => selected.has(l.id));
}
function choose(id: string, additive = false) {
  if (!additive) selected.clear();
  if (additive && selected.has(id)) selected.delete(id);
  else selected.add(id);
  renderSelection();
  renderLayers();
}
function showTab(name: string) {
  document.body.classList.add("panels-open");
  if ($(`panel-${name}`).hidden) document.querySelector(".inspector")!.scrollTop = 0; // a new tab starts at its top
  for (const n of ["create", "layers", "animate", "audio", "history"]) {
    $(`panel-${n}`).hidden = n !== name;
    $(`tab-${n}`).classList.toggle("active", n === name);
    $(`tab-${n}`).setAttribute("aria-selected", String(n === name));
  }
  if (name === "history") void refreshEngineHistory();
  if (name === "animate") animatePanel?.render(true);
  if (name === "audio") audioPanel?.render(true);
}
for (const n of ["create", "layers", "animate", "audio", "history"])
  button(`tab-${n}`).onclick = () => showTab(n);
function setTool(next: string) {
  tool = next;
  document
    .querySelectorAll<HTMLElement>(".toolbar [data-tool]")
    .forEach((el) => {
      el.classList.toggle("selected", el.dataset.tool === tool);
      el.setAttribute("aria-pressed", String(el.dataset.tool === tool));
    });
  viewport.classList.toggle("hand", tool === "hand" || space);
}
document
  .querySelectorAll<HTMLElement>(".toolbar [data-tool]")
  .forEach((el) => (el.onclick = () => setTool(el.dataset.tool!)));
function point(clientX: number, clientY: number) {
  const r = viewport.getBoundingClientRect();
  return {
    x: (clientX - r.left - project.view.x) / project.view.zoom,
    y: (clientY - r.top - project.view.y) / project.view.zoom,
  };
}
function center() {
  const r = viewport.getBoundingClientRect();
  return point(r.left + r.width / 2, r.top + r.height / 2);
}
function view() {
  const v = project.view;
  world.style.transform = `translate(${v.x}px,${v.y}px) scale(${v.zoom})`;
  viewport.style.backgroundPosition = `${v.x}px ${v.y}px`;
  viewport.style.backgroundSize = `${24 * v.zoom}px ${24 * v.zoom}px`;
  viewport.classList.toggle("no-grid", !v.grid);
  $("grid-toggle").setAttribute("aria-pressed", String(v.grid));
  $("zoom-value").textContent = `${Math.round(v.zoom * 100)}%`;
}
function zoom(next: number, clientX?: number, clientY?: number) {
  const r = viewport.getBoundingClientRect(),
    cx = clientX ?? r.left + r.width / 2,
    cy = clientY ?? r.top + r.height / 2,
    p = point(cx, cy);
  project.view.zoom = Math.min(8, Math.max(0.05, next));
  project.view.x = cx - r.left - p.x * project.view.zoom;
  project.view.y = cy - r.top - p.y * project.view.zoom;
  view();
  autosave();
}
function fit(selectionOnly = false) {
  const b = bounds(
    project.layers.filter(
      (l) => visible(project, l) && (!selectionOnly || selected.has(l.id)),
    ),
  );
  if (!b) {
    project.view = { ...project.view, x: 0, y: 0, zoom: 1 };
  } else {
    const r = viewport.getBoundingClientRect(),
      z = Math.max(
        0.05,
        Math.min(2, (r.width - 140) / b.width, (r.height - 160) / b.height),
      );
    project.view.zoom = z;
    project.view.x = (r.width - b.width * z) / 2 - b.x * z;
    project.view.y = (r.height - b.height * z) / 2 - b.y * z;
  }
  view();
  autosave();
}
function position(el: HTMLElement, l: Layer) {
  Object.assign(el.style, {
    left: `${l.x}px`,
    top: `${l.y}px`,
    width: `${l.width}px`,
    height: `${l.height}px`,
    transform: `rotate(${l.rotation || 0}deg)`,
  });
}
function textNode(tag: string, text: string, className = "") {
  const el = document.createElement(tag);
  el.textContent = text;
  el.className = className;
  return el;
}
function icon(label: string, glyph: string, action: () => void) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = glyph;
  b.title = label;
  b.setAttribute("aria-label", label);
  b.onclick = (e) => {
    e.stopPropagation();
    action();
  };
  return b;
}
function renderCanvas() {
  world.replaceChildren();
  for (const l of project.layers) {
    const el = document.createElement("div");
    el.className = `item ${l.kind}-item`;
    el.dataset.id = l.id;
    el.hidden = !visible(project, l);
    position(el, l);
    if (l.assetId) {
      const img = new Image();
      img.src = project.assets[l.assetId].data;
      img.alt = l.name;
      if (l.pixelated) img.style.imageRendering = "pixelated";
      el.append(img);
    } else if (l.kind === "video" && l.videoId && project.videos[l.videoId]) {
      const v = project.videos[l.videoId];
      const video = document.createElement("video");
      video.src = videoURL(v.id, v.data);
      video.muted = true;
      video.loop = true;
      video.autoplay = true;
      video.playsInline = true;
      video.setAttribute("aria-label", l.name);
      // Click a selected video to play/pause; sound on with the speaker control in the panel.
      video.ondblclick = (e) => {
        e.stopPropagation();
        if (video.paused) void video.play();
        else video.pause();
      };
      el.append(video);
    } else if (l.kind === "text") {
      const textCanvas = renderTextLayer(l);
      textCanvas.className = "editable-text";
      textCanvas.setAttribute("role", "img");
      textCanvas.setAttribute("aria-label", l.text || "Empty text layer");
      el.append(textCanvas);
    } else {
      const card = textNode("div", "", "card");
      card.append(
        textNode(
          "span",
          l.kind === "note"
            ? "FIELD NOTE"
            : l.kind === "mask"
              ? "MASK · PLANNED"
              : "GENERATION IDEA",
          "card-label",
        ),
        document.createTextNode(l.text || ""),
      );
      el.append(card);
    }
    const content = el.firstElementChild as HTMLElement;
    content.style.opacity = String(l.opacity ?? 1);
    content.style.transform = `scale(${l.flipX ? -1 : 1}, ${l.flipY ? -1 : 1})`;
    applyLayerLook(content, l);
    el.style.mixBlendMode = l.blendMode || "normal";
    if (l.kind === "note") {
      const palette = notePalette[l.noteColor || "sage"];
      content.style.backgroundColor = palette[0];
      content.style.color = palette[1];
    }
    el.append(
      textNode("span", l.name, "layer-caption"),
      textNode("span", "", "resize-handle"),
    );
    world.append(el);
  }
  $("empty-state").hidden = project.layers.length > 0;
}
/** Live adjustments and the refined mask: the DOM twin of export's per-layer compositing. */
function applyLayerLook(content: HTMLElement, l: Layer) {
  content.style.filter = l.assetId ? adjustmentFilter(l.adjustments) : "";
  if (l.layerMask?.enabled && project.assets[l.layerMask.assetId]) {
    const url = refinedMaskURL(
      project.assets[l.layerMask.assetId],
      l.layerMask,
      refreshLayerLooks,
    );
    content.style.maskImage = `url("${url}")`;
    content.style.maskSize = "100% 100%";
    content.style.maskRepeat = "no-repeat";
    content.style.maskMode = "alpha";
  } else content.style.maskImage = "";
}
/** Updates filters/masks in place (no rebuild), e.g. while a slider moves. */
function refreshLayerLooks() {
  for (const el of world.children as HTMLCollectionOf<HTMLElement>) {
    const l = project.layers.find((x) => x.id === el.dataset.id);
    const content = el.firstElementChild as HTMLElement | null;
    if (l && content) applyLayerLook(content, l);
  }
}
function renderSelection() {
  syncHistory();
  for (const el of world.children as HTMLCollectionOf<HTMLElement>) {
    const l = project.layers.find((l) => l.id === el.dataset.id)!;
    el.classList.toggle("selected", selected.has(l.id));
    el.classList.toggle("locked", locked(project, l));
  }
  const l = current();
  layerAI?.sync();
  glitchPanel?.sync();
  animatePanel?.sync();
  button("reference-selection").disabled =
    !l?.assetId || selected.size !== 1 || project.references.length >= 3;
  $("selection-panel").hidden = !l;
  if (!l) return;
  input("layer-opacity").value = String(Math.round((l.opacity ?? 1) * 100));
  $("opacity-value").textContent = `${input("layer-opacity").value}%`;
  ($("layer-blend") as HTMLSelectElement).value = l.blendMode || "normal";
  input("layer-opacity").disabled = locked(project, l);
  ($("layer-blend") as HTMLSelectElement).disabled = locked(project, l);
  $("note-colors").hidden = l.kind !== "note";
  document
    .querySelectorAll<HTMLButtonElement>("#note-colors [data-color]")
    .forEach((b) => {
      b.disabled = locked(project, l);
      b.classList.toggle("active", b.dataset.color === (l.noteColor || "sage"));
    });
  $("alignment-panel").hidden = selected.size < 2;
  button("original-size").disabled =
    !l.assetId || locked(project, l) || selected.size !== 1;
  button("save-original").disabled = !l.assetId || selected.size !== 1;
  $("image-edit-actions").hidden = !l.assetId || selected.size !== 1;
  if (l.assetId) {
    const a = project.assets[l.assetId];
    $("image-resolution").textContent =
      `${a.width} × ${a.height} original pixels · ${Math.round(l.width)} × ${Math.round(l.height)} on canvas`;
    button("edit-image").disabled = locked(project, l);
    button("edit-mask").disabled = locked(project, l);
    button("edit-mask").textContent = l.layerMask
      ? "Edit mask ↗"
      : "Add layer mask ↗";
    button("toggle-mask").disabled = !l.layerMask || locked(project, l);
    button("toggle-mask").textContent = l.layerMask?.enabled
      ? "Disable mask"
      : "Enable mask";
    button("remove-mask").disabled = !l.layerMask || locked(project, l);
    $("mask-status").textContent = l.layerMask
      ? l.layerMask.enabled
        ? "Mask active · white shows, black hides. Hidden pixels can be revealed again."
        : "Mask disabled · the full image is visible."
      : "Hide and reveal parts of this image without erasing pixels.";
    const maskAsset = l.layerMask && project.assets[l.layerMask.assetId];
    button("mask-preview").hidden = !maskAsset;
    button("mask-preview").disabled = locked(project, l);
    button("mask-preview").classList.toggle("off", !l.layerMask?.enabled);
    if (maskAsset) {
      const img = $("mask-preview").querySelector("img")!;
      if (img.src !== maskAsset.data) img.src = maskAsset.data;
    }
    $("mask-properties").hidden = !l.layerMask;
    const feather = l.layerMask?.feather ?? 0,
      density = l.layerMask?.density ?? 1;
    input("mask-feather").value = String(feather);
    input("mask-density").value = String(Math.round(density * 100));
    $("mask-feather-value").textContent = `${feather} px`;
    $("mask-density-value").textContent = `${Math.round(density * 100)}%`;
    input("mask-feather").disabled = input("mask-density").disabled =
      !l.layerMask || locked(project, l);
    button("invert-mask").disabled = !l.layerMask || locked(project, l);
    renderAdjustmentControls(l);
    renderBackgroundControls(l);
    button("restore-original").disabled =
      !l.originalAssetId || locked(project, l);
  }
  $("selection-count").textContent = `${selected.size} selected`;
  input("layer-name").value = l.name;
  for (const k of ["x", "y", "width", "height"] as const)
    input(`layer-${k}`).value = String(Math.round(l[k]));
  input("note-text").value = l.text || "";
  $("note-edit-label").hidden = !["note", "prompt", "text"].includes(l.kind);
  $("typography-controls").hidden = l.kind !== "text" || selected.size !== 1;
  const style = { ...defaultTextStyle, ...l.textStyle };
  ($("text-font") as HTMLSelectElement).value = style.fontFamily;
  input("text-size").value = String(style.fontSize);
  input("text-color").value = style.color;
  input("text-leading").value = String(style.lineHeight);
  input("text-bold").checked = style.bold;
  input("text-italic").checked = style.italic;
  ($("text-align") as HTMLSelectElement).value = style.align;
  input("layer-rotation").value = String(l.rotation || 0);
  for (const id of [
    "rotate-layer-left",
    "rotate-layer-right",
    "flip-layer-x",
    "flip-layer-y",
    "reset-transform",
  ])
    button(id).disabled = !movable(project, selected).length;
  for (const id of [
    "layer-name",
    "layer-x",
    "layer-y",
    "layer-width",
    "layer-height",
    "note-text",
    "text-font",
    "text-size",
    "text-color",
    "text-leading",
    "text-bold",
    "text-italic",
    "text-align",
    "layer-rotation",
  ])
    input(id).disabled = locked(project, l) || selected.size !== 1;
  $("metadata-panel").hidden = !l.metadata;
  $("metadata").textContent = l.metadata
    ? JSON.stringify(l.metadata, null, 2)
    : "";
}
function renderLayers() {
  const list = $("layer-list");
  list.replaceChildren();
  const drawnGroups = new Set<string>();
  for (const l of [...project.layers].reverse()) {
    if (l.groupId && !drawnGroups.has(l.groupId)) {
      const g = project.groups.find((g) => g.id === l.groupId)!;
      drawnGroups.add(g.id);
      const row = textNode("div", "▱", "group-row");
      const name = document.createElement("input");
      name.value = g.name;
      name.maxLength = 200;
      name.setAttribute("aria-label", "Group name");
      name.onchange = () => commit(() => (g.name = name.value || "Group"));
      row.append(
        name,
        icon(`Select ${g.name}`, "↖", () => {
          selected = new Set(
            project.layers.filter((x) => x.groupId === g.id).map((x) => x.id),
          );
          renderSelection();
          renderLayers();
        }),
        icon(
          g.visible ? "Hide group" : "Show group",
          g.visible ? "◉" : "○",
          () => commit(() => (g.visible = !g.visible)),
        ),
        icon(
          g.locked ? "Unlock group" : "Lock group",
          g.locked ? "▣" : "□",
          () => commit(() => (g.locked = !g.locked)),
        ),
      );
      list.append(row);
    }
    const row = textNode(
      "div",
      "",
      `layer-row ${selected.has(l.id) ? "active" : ""} ${l.groupId ? "group-child" : ""}`,
    );
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-label", `Select ${l.name}`);
    row.onclick = (e) => choose(l.id, e.shiftKey);
    row.ondblclick = () => showTab("layers"); // open the Edit tab for this layer
    row.onkeydown = (e) => {
      if (e.key === "Enter") choose(l.id, e.shiftKey);
    };
    if (l.assetId) {
      const img = new Image();
      img.src = project.assets[l.assetId].data;
      img.className = "layer-thumb";
      img.alt = "";
      img.style.filter = adjustmentFilter(l.adjustments);
      row.append(img);
      if (l.layerMask && project.assets[l.layerMask.assetId]) {
        // Photoshop-style mask chip: white shows, black hides. Click to edit the mask.
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = `mask-thumb${l.layerMask.enabled ? "" : " off"}`;
        chip.title = l.layerMask.enabled
          ? "Layer mask · click to edit"
          : "Layer mask (disabled) · click to edit";
        chip.setAttribute("aria-label", `Edit mask of ${l.name}`);
        const maskImg = new Image();
        maskImg.src = project.assets[l.layerMask.assetId].data;
        maskImg.alt = "";
        chip.append(maskImg);
        chip.onclick = (e) => {
          e.stopPropagation();
          selected = new Set([l.id]);
          renderSelection();
          renderLayers();
          if (!locked(project, l)) void editMask();
        };
        row.append(chip);
      }
    } else
      row.append(
        textNode(
          "span",
          l.kind === "text"
            ? "T"
            : l.kind === "note"
              ? "▤"
              : l.kind === "video"
                ? "▶"
                : "✦",
          "layer-thumb",
        ),
      );
    const title = textNode("span", l.name, "layer-title");
    const traits = [l.metadata?.demo ? "Demo output" : l.kind];
    if (l.layerMask) traits.push(l.layerMask.enabled ? "mask" : "mask off");
    if (l.adjustments && !isNeutral(l.adjustments))
      traits.push(l.adjustments.enabled ? "adjusted" : "adjustments off");
    title.append(textNode("small", traits.join(" · ")));
    row.append(
      title,
      icon(
        l.visible ? `Hide ${l.name}` : `Show ${l.name}`,
        l.visible ? "◉" : "○",
        () => commit(() => (l.visible = !l.visible)),
      ),
      icon(
        l.locked ? `Unlock ${l.name}` : `Lock ${l.name}`,
        l.locked ? "▣" : "□",
        () => commit(() => (l.locked = !l.locked)),
      ),
    );
    list.append(row);
  }
  $("layers-empty").hidden = project.layers.length > 0;
  $("layer-count").textContent = `${project.layers.length} LAYERS`;
  $("layers-badge").textContent = String(project.layers.length);
}
function renderGallery() {
  const gallery = $("gallery");
  gallery.replaceChildren();
  $("history-count").textContent = String(project.gallery.length);
  if (!project.gallery.length) {
    gallery.append(
      textNode("p", "Your generated images will appear here.", "subtle"),
    );
    return;
  }
  for (const g of [...project.gallery].reverse()) {
    const b = document.createElement("button");
    b.className = "gallery-card";
    const img = new Image();
    img.src = project.assets[g.assetId].data;
    img.alt = g.metadata.prompt;
    b.append(
      img,
      textNode("span", g.metadata.prompt),
      textNode(
        "small",
        `${g.metadata.demo ? "DEMO · " : ""}Seed ${g.metadata.seed}`,
      ),
    );
    b.onclick = () => placeAsset(g.assetId, g.metadata);
    gallery.append(b);
  }
}
function settingsToForm() {
  const s = project.settings;
  for (const [key, id] of Object.entries({
    prompt: "prompt",
    negative_prompt: "negative-prompt",
    width: "width",
    height: "height",
    steps: "steps",
    guidance: "guidance",
    seed: "seed",
  }))
    input(id).value = String(s[key as keyof Settings]);
  input("transparent").checked = !!s.transparent;
  updateFraming();
}
function formSettings(): Settings {
  return {
    prompt: input("prompt").value.trim(),
    negative_prompt: input("negative-prompt").value,
    width: +input("width").value,
    height: +input("height").value,
    steps: +input("steps").value,
    guidance: +input("guidance").value,
    seed: +input("seed").value,
    ...(input("transparent").checked ? { transparent: true } : {}),
  };
}
function updateFraming() {
  $("dimension-label").textContent =
    `${input("width").value} × ${input("height").value}`;
  const edge = Math.max(+input("width").value, +input("height").value);
  ($("generation-resolution") as HTMLSelectElement).value = [
    1024, 1536, 2048,
  ].includes(edge)
    ? String(edge)
    : "custom";
  $("resolution-hint").textContent =
    `${((+input("width").value * +input("height").value) / 1e6).toFixed(1)} megapixels · Original pixels preserved.${edge > 1024 ? " Larger images need more GPU memory and time." : ""}`;
  document
    .querySelectorAll<HTMLElement>(".ratio")
    .forEach((el) =>
      el.classList.toggle(
        "active",
        Math.abs(
          +el.dataset.width! / +el.dataset.height! -
            +input("width").value / +input("height").value,
        ) < 0.04,
      ),
    );
}
function render() {
  releaseVideoURLs(project.videos);
  input("project-title").value = project.title;
  document.title = `${project.title} — Studio Zero`;
  renderCanvas();
  renderSelection();
  renderLayers();
  renderGallery();
  renderReferences();
  animatePanel?.render();
  audioPanel?.render();
  poseControls?.render();
  updateGuideSummary();
  view();
}
/** The folded "Guide with pictures" group says what is active without opening it. */
let guideCount = 0;
function updateGuideSummary() {
  // A reference or pose added from elsewhere (layer menu, drop) opens the folded group so it is seen.
  const count = project.references.length + (project.pose?.enabled ? 1 : 0);
  if (count > guideCount) $<HTMLDetailsElement>("guide-group").open = true;
  guideCount = count;
  const parts = [];
  if (project.pose?.enabled) parts.push("pose on");
  if (project.references.length)
    parts.push(`${project.references.length} reference${project.references.length > 1 ? "s" : ""}`);
  $("guide-summary").textContent = parts.join(" · ") || "pose · references";
  $("guide-summary").classList.toggle("active", parts.length > 0);
}
function addNote(x?: number, y?: number, kind: "note" | "prompt" = "note") {
  const c = center(),
    l = newLayer(kind, x ?? c.x - 130, y ?? c.y - 90);
  if (kind === "prompt") {
    l.text = input("prompt").value.trim();
    if (!l.text) return toast("Write a prompt first, then save it as an idea.");
  }
  commit(() => {
    project.layers.push(l);
    selected = new Set([l.id]);
  });
  setTool("select");
  showTab("layers");
}
function addText(x: number, y: number) {
  const l = newLayer("text", x, y);
  commit(() => {
    project.layers.push(l);
    selected = new Set([l.id]);
  });
  setTool("select");
  showTab("layers");
  input("note-text").focus();
  input("note-text").select();
}
async function importImages(
  files: FileList | File[],
  location?: { x: number; y: number },
) {
  const projectId = project.id;
  for (const [i, file] of Array.from(files).entries()) {
    try {
      if (!["image/png", "image/jpeg", "image/webp"].includes(file.type))
        throw Error("Use PNG, JPEG or WebP images.");
      if (file.size > 40 * 1024 * 1024)
        throw Error("This image is too large (40 MB maximum).");
      const data = await readData(file),
        img = new Image();
      img.src = data;
      await img.decode();
      if (project.id !== projectId) return;
      if (
        img.width * img.height > 64e6 ||
        Math.max(img.width, img.height) > 32768
      )
        throw Error(
          "Use an image under 64 megapixels and 32,768 pixels per side.",
        );
      const id = crypto.randomUUID(),
        scale = 1,
        c = location || center();
      const l = newLayer(
        "image",
        c.x - (img.width * scale) / 2 + i * 24,
        c.y - (img.height * scale) / 2 + i * 24,
      );
      Object.assign(l, {
        width: Math.max(16, img.width * scale),
        height: Math.max(16, img.height * scale),
        assetId: id,
        name: file.name.replace(/\.[^.]+$/, "").slice(0, 200),
      });
      commit(() => {
        project.assets[id] = { id, data, width: img.width, height: img.height };
        project.layers.push(l);
        selected = new Set([l.id]);
      });
    } catch (e) {
      fail(e);
    }
  }
  showTab("layers");
  fit(true);
}
function placeAsset(assetId: string, metadata: Generation) {
  const anchor = current();
  const a = project.assets[assetId],
    c = center(),
    scale = 1,
    l = newLayer(
      "image",
      c.x - (a.width * scale) / 2,
      c.y - (a.height * scale) / 2,
    );
  Object.assign(l, {
    width: a.width * scale,
    height: a.height * scale,
    assetId,
    name: metadata.prompt.slice(0, 45) || "Generated image",
    metadata: structuredClone(metadata),
  });
  if (anchor && visible(project, anchor)) {
    l.x = anchor.x + anchor.width + 32;
    l.y = anchor.y;
  }
  commit(() => {
    project.layers.push(l);
    selected = new Set([l.id]);
  });
  const r = viewport.getBoundingClientRect(),
    v = project.view;
  if (
    l.x * v.zoom + v.x < 30 ||
    (l.x + l.width) * v.zoom + v.x > r.width - 30 ||
    l.y * v.zoom + v.y < 70 ||
    (l.y + l.height) * v.zoom + v.y > r.height - 70
  )
    fit(true);
}
function remove() {
  const ids = project.layers
    .filter((l) => selected.has(l.id) && !locked(project, l))
    .map((l) => l.id);
  if (!ids.length) return toast("Select an unlocked layer to delete.");
  commit(() => {
    project.layers = project.layers.filter((l) => !ids.includes(l.id));
    // Videos are large: drop embedded videos no layer uses any more (Undo restores them).
    for (const id of Object.keys(project.videos))
      if (!project.layers.some((l) => l.videoId === id)) delete project.videos[id];
    selected.clear();
    project.groups = project.groups.filter((g) =>
      project.layers.some((l) => l.groupId === g.id),
    );
  });
}
function reorder(direction: number) {
  if (movable(project, selected).length)
    commit(() => reorderLayers(project, selected, direction));
}
function undo(redo = false) {
  const p = redo ? history.redo(project) : history.undo(project);
  if (!p) return;
  project = p;
  selected.clear();
  settingsToForm();
  render();
  autosave();
}

type Gesture = {
  kind: "pan" | "move" | "resize" | "marquee";
  cx: number;
  cy: number;
  x: number;
  y: number;
  start: { x: number; y: number };
  originals: Layer[];
  selection: Set<string>;
  started: boolean;
};
let gesture: Gesture | null = null;
viewport.onpointerdown = (e) => {
  if (
    (e.target as HTMLElement).closest("button") ||
    (e.button !== 0 && e.button !== 1)
  )
    return;
  const p = point(e.clientX, e.clientY),
    item = (e.target as HTMLElement).closest<HTMLElement>(".item"),
    l = project.layers.find((l) => l.id === item?.dataset.id);
  let kind: Gesture["kind"];
  if (space || tool === "hand" || e.button === 1) kind = "pan";
  else if (tool === "note") {
    addNote(p.x, p.y);
    return;
  } else if (tool === "text") {
    addText(p.x, p.y);
    return;
  } else if (l) {
    if (!selected.has(l.id) || e.shiftKey) choose(l.id, e.shiftKey);
    if (locked(project, l) || !selected.has(l.id)) return;
    kind = (e.target as HTMLElement).classList.contains("resize-handle")
      ? "resize"
      : "move";
  } else {
    kind = "marquee";
    if (!e.shiftKey) selected.clear();
    renderSelection();
    renderLayers();
  }
  e.preventDefault();
  viewport.focus();
  viewport.setPointerCapture(e.pointerId);
  gesture = {
    kind,
    cx: e.clientX,
    cy: e.clientY,
    x: project.view.x,
    y: project.view.y,
    start: p,
    originals: project.layers
      .filter((l) => selected.has(l.id) && !locked(project, l))
      .map((l) => ({ ...l })),
    selection: new Set(selected),
    started: false,
  };
  viewport.classList.toggle("panning", kind === "pan");
};
viewport.onpointermove = (e) => {
  const g = gesture;
  if (!g) return;
  const dx = e.clientX - g.cx,
    dy = e.clientY - g.cy;
  if (!g.started && Math.hypot(dx, dy) < 3) return;
  if (!g.started) {
    if (g.kind === "move" || g.kind === "resize") history.push(project);
    g.started = true;
  }
  if (g.kind === "pan") {
    project.view.x = g.x + dx;
    project.view.y = g.y + dy;
    view();
  } else if (g.kind === "marquee") {
    const p = point(e.clientX, e.clientY),
      left = Math.min(p.x, g.start.x),
      top = Math.min(p.y, g.start.y),
      right = Math.max(p.x, g.start.x),
      bottom = Math.max(p.y, g.start.y);
    const el = $("marquee");
    el.hidden = false;
    Object.assign(el.style, {
      left: `${left * project.view.zoom + project.view.x}px`,
      top: `${top * project.view.zoom + project.view.y}px`,
      width: `${(right - left) * project.view.zoom}px`,
      height: `${(bottom - top) * project.view.zoom}px`,
    });
    selected = new Set(g.selection);
    for (const l of project.layers) {
      const box = layerBounds(l);
      if (
        visible(project, l) &&
        box.x < right &&
        box.x + box.width > left &&
        box.y < bottom &&
        box.y + box.height > top
      )
        selected.add(l.id);
    }
    renderSelection();
    renderLayers();
  } else {
    for (const original of g.originals) {
      const l = project.layers.find((l) => l.id === original.id)!;
      if (g.kind === "move") {
        l.x = original.x + dx / project.view.zoom;
        l.y = original.y + dy / project.view.zoom;
      } else {
        Object.assign(
          l,
          resizeFromCorner(
            original,
            dx / project.view.zoom,
            dy / project.view.zoom,
          ),
        );
      }
      const el = [...world.children].find(
        (el) => (el as HTMLElement).dataset.id === l.id,
      ) as HTMLElement;
      position(el, l);
    }
    renderSelection();
  }
};
function endGesture() {
  if (gesture?.started) autosave();
  if (gesture?.started && gesture.kind === "resize") {
    renderCanvas();
    renderSelection();
  }
  gesture = null;
  $("marquee").hidden = true;
  viewport.classList.remove("panning");
}
viewport.onpointerup = endGesture;
viewport.onpointercancel = endGesture;
viewport.onlostpointercapture = endGesture;
// Pointer capture retargets double-clicks to the viewport; find the layer at the click.
viewport.ondblclick = (e) => {
  if (tool !== "select" || space) return;
  const item = document
    .elementFromPoint(e.clientX, e.clientY)
    ?.closest<HTMLElement>(".item");
  const l = project.layers.find((layer) => layer.id === item?.dataset.id);
  if (!l) return;
  choose(l.id);
  if (l.kind === "image") void editImage();
  else if (["note", "prompt", "text"].includes(l.kind)) {
    showTab("layers");
    input("note-text").focus();
  }
};
viewport.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    if (!gesture)
      zoom(
        project.view.zoom * Math.exp(-e.deltaY * 0.0015),
        e.clientX,
        e.clientY,
      );
  },
  { passive: false },
);
viewport.ondragover = (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
};
viewport.ondrop = (e) => {
  e.preventDefault();
  if (e.dataTransfer)
    void importImages(e.dataTransfer.files, point(e.clientX, e.clientY));
};
button("zoom-in").onclick = () => zoom(project.view.zoom * 1.2);
button("zoom-out").onclick = () => zoom(project.view.zoom / 1.2);
button("zoom-value").onclick = () => zoom(1);
button("fit").onclick = () => fit();
button("grid-toggle").onclick = () => {
  project.view.grid = !project.view.grid;
  view();
  autosave();
};
button("add-image").onclick = button("empty-import").onclick = () =>
  input("image-upload").click();
input("image-upload").onchange = () => {
  if (input("image-upload").files)
    void importImages(input("image-upload").files!);
  input("image-upload").value = "";
};
button("add-prompt").onclick = () => addNote(undefined, undefined, "prompt");
button("empty-generate").onclick = () => {
  showTab("create");
  input("prompt").focus();
};
button("delete-layer").onclick = remove;
button("front").onclick = () => reorder(1);
button("back").onclick = () => reorder(-1);
button("duplicate").onclick = () => {
  if (selected.size)
    commit(() => {
      selected = new Set(duplicateLayers(project, selected).map((l) => l.id));
    });
};
for (const k of ["x", "y", "width", "height"] as const)
  input(`layer-${k}`).onchange = () => {
    const l = current(),
      v = +input(`layer-${k}`).value;
    if (
      !l ||
      locked(project, l) ||
      !Number.isFinite(v) ||
      Math.abs(v) > (k === "x" || k === "y" ? 1e7 : 32768) ||
      ((k === "width" || k === "height") && v < 16)
    )
      return renderSelection();
    commit(() => {
      if (
        l.kind === "image" &&
        input("lock-ratio").checked &&
        (k === "width" || k === "height")
      ) {
        const other = k === "width" ? "height" : "width";
        const next = (l[other] * v) / l[k];
        if (next < 16 || next > 32768) return;
        l[other] = next;
      }
      l[k] = v;
    });
  };
// One undo entry per text editing session; autosave also captures unblurred edits.
function liveText(id: string, update: (value: string) => void) {
  let remembered = false;
  input(id).onfocus = () => {
    remembered = false;
  };
  input(id).oninput = () => {
    if (!remembered) {
      history.push(project);
      remembered = true;
    }
    update(input(id).value);
    syncHistory();
    renderCanvas();
    renderLayers();
    for (const el of world.children as HTMLCollectionOf<HTMLElement>) {
      const l = project.layers.find((l) => l.id === el.dataset.id)!;
      el.classList.toggle("selected", selected.has(l.id));
      el.classList.toggle("locked", locked(project, l));
    }
    autosave();
  };
}
liveText("layer-name", (value) => {
  const l = current();
  if (l && !locked(project, l)) l.name = value.trim() || "Untitled layer";
});
liveText("note-text", (value) => {
  const l = current();
  if (l && !locked(project, l)) l.text = value;
});
for (const id of [
  "text-font",
  "text-size",
  "text-color",
  "text-leading",
  "text-bold",
  "text-italic",
  "text-align",
]) {
  input(id).onchange = () => {
    const l = current();
    if (!l || l.kind !== "text" || selected.size !== 1 || locked(project, l))
      return;
    const fontSize = +input("text-size").value,
      lineHeight = +input("text-leading").value;
    if (
      !Number.isFinite(fontSize) ||
      fontSize < 8 ||
      fontSize > 512 ||
      !Number.isFinite(lineHeight) ||
      lineHeight < 0.8 ||
      lineHeight > 3
    ) {
      renderSelection();
      return toast("Use a font size of 8–512 and line spacing of 0.8–3.");
    }
    const style: TextStyle = {
      fontFamily: input("text-font").value as TextStyle["fontFamily"],
      fontSize,
      color: input("text-color").value,
      bold: input("text-bold").checked,
      italic: input("text-italic").checked,
      align: input("text-align").value as TextStyle["align"],
      lineHeight,
    };
    commit(() => {
      l.textStyle = style;
    });
  };
}
input("layer-rotation").onchange = () => {
  const l = current(),
    angle = +input("layer-rotation").value;
  if (!l || locked(project, l) || selected.size !== 1) return;
  if (!Number.isFinite(angle)) {
    renderSelection();
    return;
  }
  commit(() => {
    l.rotation = normalizeAngle(angle);
  });
};
function transformLayers(action: (l: Layer) => void) {
  if (movable(project, selected).length)
    commit(() => movable(project, selected).forEach(action));
}
button("rotate-layer-left").onclick = () =>
  transformLayers((l) => {
    l.rotation = normalizeAngle((l.rotation || 0) - 90);
  });
button("rotate-layer-right").onclick = () =>
  transformLayers((l) => {
    l.rotation = normalizeAngle((l.rotation || 0) + 90);
  });
button("flip-layer-x").onclick = () =>
  transformLayers((l) => {
    l.flipX = !l.flipX;
  });
button("flip-layer-y").onclick = () =>
  transformLayers((l) => {
    l.flipY = !l.flipY;
  });
button("reset-transform").onclick = () =>
  transformLayers((l) => {
    l.rotation = 0;
    l.flipX = false;
    l.flipY = false;
  });
button("group-layers").onclick = () => {
  const layers = project.layers.filter(
    (l) => selected.has(l.id) && !locked(project, l),
  );
  if (!layers.length) return toast("Select unlocked layers to group.");
  commit(() => {
    const id = crypto.randomUUID();
    project.groups.push({
      id,
      name: "New group",
      visible: true,
      locked: false,
    });
    layers.forEach((l) => (l.groupId = id));
    project.groups = project.groups.filter((g) =>
      project.layers.some((l) => l.groupId === g.id),
    );
  });
};
button("ungroup").onclick = () =>
  commit(() => {
    project.layers
      .filter((l) => selected.has(l.id) && !locked(project, l))
      .forEach((l) => (l.groupId = null));
    project.groups = project.groups.filter((g) =>
      project.layers.some((l) => l.groupId === g.id),
    );
  });
liveText("project-title", (value) => {
  project.title = value.trim() || "Untitled canvas";
  document.title = `${project.title} — Studio Zero`;
});
function saveFile() {
  download(
    `${project.title}.zero`,
    new Blob([JSON.stringify(project)], { type: "application/json" }),
  );
  toast("Project download requested, with its images and settings.");
}
button("save-project").onclick = saveFile;
async function png(selection?: Set<string>) {
  openExport(project, selection);
}
button("export-image").onclick = () => void png();
button("export-selection").onclick = () => void png(selected);
function switchProject(next: typeof project) {
  clearTimeout(saveTimer);
  project = next;
  selected.clear();
  history.clear();
  settingsToForm();
  render();
  autosave();
}
button("new-project").onclick = async () => {
  if (generating)
    return toast(
      "Finish or cancel the current generation before starting a new project.",
    );
  try {
    await saveLocal(project);
  } catch {
    return toast("Save a .zero backup first: browser storage is unavailable.");
  }
  switchProject(blankProject());
  showTab("create");
};
button("open-project").onclick = async () => {
  if (generating)
    return toast(
      "Finish or cancel the current generation before opening a project.",
    );
  try {
    await saveLocal(project);
  } catch {
    toast("Browser storage is unavailable. Download a .zero backup.");
  }
  void openLibrary(
    project.id,
    async (p) => {
      await saveLocal(project);
      switchProject(p);
    },
    () => button("new-project").click(),
    () => input("project-import").click(),
  );
};
input("project-import").onchange = async () => {
  const file = input("project-import").files?.[0];
  input("project-import").value = "";
  if (!file || generating) return;
  try {
    if (file.size > 250 * 1024 * 1024)
      throw Error("Projects must be smaller than 250 MB.");
    const p = parseProject(await file.text());
    await saveLocal(project);
    // Import as a separate local project so an old portable copy cannot overwrite a newer canvas.
    p.id = crypto.randomUUID();
    switchProject(p);
    toast("Project opened.");
  } catch (e) {
    fail(e);
  }
};
for (const id of [
  "prompt",
  "negative-prompt",
  "width",
  "height",
  "steps",
  "guidance",
  "seed",
  "transparent",
])
  input(id).oninput = () => {
    const s = formSettings();
    try {
      validateSettings({ ...s, prompt: s.prompt || "draft" });
      project.settings = s;
      autosave();
    } catch {
      /* incomplete numeric input is not persisted */
    }
    updateFraming();
  };
document.querySelectorAll<HTMLElement>(".ratio").forEach(
  (el) =>
    (el.onclick = () => {
      const size = generationDimensions(
        Math.max(+input("width").value, +input("height").value),
        +el.dataset.width!,
        +el.dataset.height!,
      );
      input("width").value = String(size.width);
      input("height").value = String(size.height);
      project.settings = formSettings();
      updateFraming();
      autosave();
    }),
);
$("generation-resolution").onchange = () => {
  const value = ($("generation-resolution") as HTMLSelectElement).value;
  if (value === "custom") {
    document.querySelector<HTMLDetailsElement>(".advanced")!.open = true;
    input("width").focus();
    return;
  }
  const size = generationDimensions(
    +value,
    +input("width").value || 1024,
    +input("height").value || 1024,
  );
  input("width").value = String(size.width);
  input("height").value = String(size.height);
  project.settings = formSettings();
  updateFraming();
  autosave();
};
button("reuse-prompt").onclick = () => {
  const m = current()?.metadata;
  if (m) {
    const { prompt, negative_prompt, width, height, steps, guidance, seed } = m;
    project.settings = {
      prompt,
      negative_prompt,
      width,
      height,
      steps,
      guidance,
      seed,
    };
    settingsToForm();
    showTab("create");
    autosave();
  }
};
button("shortcuts").onclick = () =>
  $<HTMLDialogElement>("help-dialog").showModal();
const panelToggle = icon("Show or hide creative panels", "☷", () => {
  document.body.classList.toggle("panels-open");
  panelToggle.setAttribute(
    "aria-expanded",
    String(document.body.classList.contains("panels-open")),
  );
});
panelToggle.className = "tool panel-toggle";
/** Layers dock: shown beside the canvas on wide screens, floating over it on narrow ones. */
function setLayersFlip(flip: boolean) {
  document.body.classList.toggle("layers-flip", flip);
  button("layers-toggle").setAttribute("aria-pressed", String(flip !== matchMedia("(max-width: 1180px)").matches));
  try {
    localStorage.setItem("studio-zero-layers-hidden", flip ? "1" : "0");
  } catch {
    /* private mode: the choice just isn't remembered */
  }
}
button("layers-toggle").onclick = () => setLayersFlip(!document.body.classList.contains("layers-flip"));
button("layers-close").onclick = () => setLayersFlip(!document.body.classList.contains("layers-flip"));
try {
  if (localStorage.getItem("studio-zero-layers-hidden") === "1" && !matchMedia("(max-width: 1180px)").matches)
    setLayersFlip(true);
} catch {
  /* ignore */
}
panelToggle.id = "panel-toggle";
document.querySelector(".tool-stack")!.append(panelToggle);
document.addEventListener("keydown", (e) => {
  const editing = (e.target as HTMLElement).closest(
    "input, textarea, select, [contenteditable=true]",
  );
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    saveFile();
    return;
  }
  if (editing || document.querySelector("dialog[open]")) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    undo(e.shiftKey);
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
    e.preventDefault();
    button("duplicate").click();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
    e.preventDefault();
    selected = new Set(
      project.layers.filter((l) => visible(project, l)).map((l) => l.id),
    );
    renderSelection();
    renderLayers();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "n") {
    e.preventDefault();
    newPaintLayer();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key.startsWith("Arrow") && selected.size) {
    e.preventDefault();
    if (!e.repeat) history.push(project);
    const amount = e.shiftKey ? 10 : 1;
    for (const l of movable(project, selected)) {
      if (e.key === "ArrowLeft") l.x -= amount;
      if (e.key === "ArrowRight") l.x += amount;
      if (e.key === "ArrowUp") l.y -= amount;
      if (e.key === "ArrowDown") l.y += amount;
    }
    render();
    autosave();
    return;
  }
  if (e.key.toLowerCase() === "f") fit(e.shiftKey);
  if (e.key === "[") reorder(-1);
  if (e.key === "]") reorder(1);
  if (e.code === "Space") {
    e.preventDefault();
    space = true;
    viewport.classList.add("hand");
  }
  if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    remove();
  }
  if (e.key.toLowerCase() === "v") setTool("select");
  if (e.key.toLowerCase() === "h") setTool("hand");
  if (e.key.toLowerCase() === "n") setTool("note");
  if (e.key.toLowerCase() === "t") setTool("text");
  const editTools: Record<string, string> = {
    b: "brush",
    e: "erase",
    i: "eyedropper",
    g: "gradient",
    k: "bucket",
    u: "shape",
    m: "select",
    c: "crop",
    l: "lasso",
  };
  const editTool = editTools[e.key.toLowerCase()];
  if (editTool && !e.repeat) {
    e.preventDefault();
    if (editTool === "brush" && !selected.size) newPaintLayer();
    else void editImage(editTool);
  }
  if (e.key === "Escape") {
    selected.clear();
    renderSelection();
    renderLayers();
    setTool("select");
  }
});
document.addEventListener("keyup", (e) => {
  if (e.code === "Space") {
    space = false;
    setTool(tool);
  }
});
window.addEventListener("blur", () => {
  space = false;
  setTool(tool);
  endGesture();
});
window.addEventListener("beforeunload", (e) => {
  if (dirty || generating) {
    e.preventDefault();
    e.returnValue = "";
  }
});

const connectionDialog = $<HTMLDialogElement>("connection-dialog");
const historyControls = document.createElement("div");
historyControls.className = "history-controls";
const undoButton = icon("Undo · Ctrl/⌘ Z", "↶", () => undo());
const redoButton = icon("Redo · Ctrl/⌘ Shift Z", "↷", () => undo(true));
historyControls.append(undoButton, redoButton);
document.querySelector(".canvas-bottom")!.prepend(historyControls);
function syncHistory() {
  if (typeof undoButton !== "undefined") {
    undoButton.disabled = !history.canUndo;
    redoButton.disabled = !history.canRedo;
  }
}
const fitSelection = icon("Focus selection · Shift F", "⌖", () => fit(true));
fitSelection.id = "focus-selection";
document.querySelector(".zoom-controls")!.append(fitSelection);
let opacityEditing = false;
input("layer-opacity").onpointerdown = () => (opacityEditing = false);
input("layer-opacity").onfocus = () => (opacityEditing = false);
input("layer-opacity").oninput = () => {
  if (!opacityEditing) {
    history.push(project);
    opacityEditing = true;
  }
  const value = +input("layer-opacity").value / 100;
  movable(project, selected).forEach((l) => (l.opacity = value));
  renderCanvas();
  renderSelection();
  autosave();
};
($("layer-blend") as HTMLSelectElement).onchange = () => {
  const value = ($("layer-blend") as HTMLSelectElement)
    .value as Layer["blendMode"];
  commit(() =>
    movable(project, selected).forEach((l) => (l.blendMode = value)),
  );
};
document
  .querySelectorAll<HTMLButtonElement>("#note-colors [data-color]")
  .forEach(
    (b) =>
      (b.onclick = () =>
        commit(() =>
          movable(project, selected)
            .filter((l) => l.kind === "note")
            .forEach(
              (l) => (l.noteColor = b.dataset.color as Layer["noteColor"]),
            ),
        )),
  );
document
  .querySelectorAll<HTMLButtonElement>("[data-align]")
  .forEach(
    (b) =>
      (b.onclick = () =>
        commit(() =>
          alignLayers(project, selected, b.dataset.align as Alignment),
        )),
  );
button("original-size").onclick = () => {
  const l = current();
  if (l?.assetId && !locked(project, l)) {
    const a = project.assets[l.assetId];
    commit(() => {
      l.width = a.width;
      l.height = a.height;
    });
    fit(true);
  }
};
button("save-original").onclick = async () => {
  const l = current();
  if (!l?.assetId) return;
  try {
    const blob = await (
      await fetch(project.assets[l.originalAssetId || l.assetId].data)
    ).blob();
    download(
      `${l.name}.${blob.type.split("/")[1] === "jpeg" ? "jpg" : blob.type.split("/")[1]}`,
      blob,
    );
  } catch (e) {
    fail(e);
  }
};

async function editImage(initialTool = "select") {
  const l = current(),
    projectId = project.id;
  if (!l?.assetId || selected.size !== 1)
    return toast("Select one image to edit.");
  if (locked(project, l)) return toast("Unlock this image before editing.");
  const previousAssetId = l.assetId;
  try {
    const maskImage = l.layerMask
      ? await loadAssetImage(project.assets[l.layerMask.assetId])
      : undefined;
    const sourceImage = maskImage
      ? await loadAssetImage(project.assets[l.assetId])
      : undefined;
    await openImageEditor(
      project.assets[l.assetId],
      (asset, operations, asNewLayer) => {
        if (
          project.id !== projectId ||
          !project.layers.includes(l) ||
          locked(project, l)
        )
          throw Error(
            "The layer changed while editing. Open the editor again.",
          );
        const old = project.assets[previousAssetId],
          scaleX = l.width / old.width,
          scaleY = l.height / old.height;
        const transformedMask =
          maskImage && sourceImage
            ? transformMask(maskImage, sourceImage, operations)
            : undefined;
        commit(() => {
          const target = asNewLayer
            ? {
                ...structuredClone(l),
                id: crypto.randomUUID(),
                name: `${l.name.slice(0, 192)} · study`,
              }
            : l;
          if (asNewLayer) {
            project.layers.push(target);
            selected = new Set([target.id]);
          }
          const id = crypto.randomUUID();
          project.assets[id] = { id, ...asset };
          target.originalAssetId ||= previousAssetId;
          target.assetId = id;
          if (transformedMask && target.layerMask) {
            const maskId = crypto.randomUUID();
            project.assets[maskId] = { id: maskId, ...transformedMask };
            target.layerMask.assetId = maskId;
          }
          const fitScale = Math.min(
            1,
            32768 / Math.max(asset.width * scaleX, asset.height * scaleY),
          );
          target.width = Math.max(16, asset.width * scaleX * fitScale);
          target.height = Math.max(16, asset.height * scaleY * fitScale);
        });
        fit(true);
        toast(
          asNewLayer
            ? "New study added. Your source layer is unchanged."
            : "Edits applied. Your original image is preserved.",
        );
      },
      initialTool,
      undefined,
      { adjustments: l.adjustments, masked: !!l.layerMask },
    );
  } catch (e) {
    fail(e);
  }
}
button("edit-image").onclick = () => void editImage();
function newPaintLayer() {
  const base = selected.size === 1 ? current() : undefined;
  const asset = base?.assetId ? project.assets[base.assetId] : undefined;
  openPaintLayer(
    asset?.width ?? project.settings.width,
    asset?.height ?? project.settings.height,
    (name, canvas) => {
      const p = center(),
        id = crypto.randomUUID();
      const layer = newLayer(
        "image",
        base?.x ?? p.x - canvas.width / 2,
        base?.y ?? p.y - canvas.height / 2,
      );
      layer.name = name;
      layer.assetId = id;
      layer.width =
        base && asset
          ? (base.width * canvas.width) / asset.width
          : canvas.width;
      layer.height =
        base && asset
          ? (base.height * canvas.height) / asset.height
          : canvas.height;
      const fitScale = Math.min(1, 32768 / Math.max(layer.width, layer.height));
      layer.width = Math.max(16, layer.width * fitScale);
      layer.height = Math.max(16, layer.height * fitScale);
      if (base) {
        layer.rotation = base.rotation;
        layer.flipX = base.flipX;
        layer.flipY = base.flipY;
      }
      commit(() => {
        project.assets[id] = {
          id,
          data: canvas.toDataURL("image/png"),
          width: canvas.width,
          height: canvas.height,
        };
        project.layers.push(layer);
        selected = new Set([layer.id]);
      });
      showTab("layers");
      fit(true);
      // The creation dialog closes before the image decoder opens the workshop.
      void editImage("brush");
    },
  );
}
button("new-paint-layer").onclick = newPaintLayer;
button("empty-paint").onclick = newPaintLayer;
button("brush-image").onclick = () =>
  selected.size ? void editImage("brush") : newPaintLayer();
button("erase-image").onclick = () => void editImage("erase");
for (const name of ["gradient", "shape", "eyedropper", "bucket"])
  button(`${name}-image`).onclick = () => void editImage(name);
async function editMask() {
  const l = current(),
    projectId = project.id;
  if (!l?.assetId || selected.size !== 1 || locked(project, l)) return;
  try {
    await openImageEditor(
      project.assets[l.assetId],
      (asset) => {
        if (
          project.id !== projectId ||
          !project.layers.includes(l) ||
          locked(project, l)
        )
          throw Error("The layer changed. Open its mask again.");
        commit(() => {
          const id = crypto.randomUUID();
          project.assets[id] = { id, ...asset };
          // Keep live feather/density; a newly painted mask starts enabled.
          l.layerMask = { ...l.layerMask, assetId: id, enabled: true };
        });
        toast("Mask applied. Hidden pixels can be revealed again.");
      },
      "erase",
      { mask: l.layerMask ? project.assets[l.layerMask.assetId] : undefined },
      {
        adjustments: l.adjustments,
        maskFeather: l.layerMask?.feather,
        maskDensity: l.layerMask?.density,
      },
    );
  } catch (e) {
    fail(e);
  }
}
button("edit-mask").onclick = () => void editMask();
button("mask-preview").onclick = () => void editMask();
button("toggle-mask").onclick = () => {
  const l = current();
  if (l?.layerMask && !locked(project, l))
    commit(() => {
      l.layerMask!.enabled = !l.layerMask!.enabled;
    });
};
button("remove-mask").onclick = () => {
  const l = current();
  if (l?.layerMask && !locked(project, l))
    commit(() => {
      delete l.layerMask;
    });
};

function renderBackgroundControls(l: Layer) {
  const b = button("remove-background"),
    hint = $("remove-background-hint");
  const busy = !!backgroundTask,
    mine = backgroundTask?.layerId === l.id;
  const available =
    !!service && engineCapabilities.includes("remove-background");
  b.textContent = mine
    ? "Finding the subject… · Cancel"
    : "✦ Remove background";
  b.disabled = mine ? false : busy || !available || locked(project, l);
  b.classList.toggle("busy", mine);
  hint.textContent = mine
    ? "Your engine is separating the subject. The result becomes this layer's mask."
    : busy
      ? "Another background removal is running."
      : !service
        ? "Connect your engine to remove backgrounds with AI (updated Colab notebook)."
        : !available
          ? "This engine has no background removal. Run the updated Colab notebook and reconnect."
          : engineMatting === "demo"
            ? "Demo engine: a border-colour key for testing, not AI."
            : l.layerMask
              ? "AI finds the subject and replaces this mask. Undo restores the current one."
              : "AI finds the subject and hides the background with a mask. No pixels are erased.";
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function removeBackground() {
  const l = current(),
    engine = service;
  if (backgroundTask) {
    if (backgroundTask.layerId === l?.id) {
      backgroundTask.cancelled = true;
      if (backgroundTask.taskId && engine)
        void engine.cancelTask(backgroundTask.taskId).catch(() => {});
      toast("Background removal cancelled.");
    }
    return;
  }
  if (!l?.assetId || selected.size !== 1)
    return toast("Select one image first.");
  if (locked(project, l)) return toast("Unlock this image first.");
  if (!engine || !engineCapabilities.includes("remove-background"))
    return toast("Connect an engine with background removal first.");
  const projectId = project.id,
    assetId = l.assetId;
  const run: BackgroundRun = {
    layerId: l.id,
    cancelled: false,
  };
  backgroundTask = run;
  renderSelection();
  try {
    const upload = await engineUpload(project.assets[assetId]);
    if (run.cancelled) return;
    let task: Task = await engine.removeBackground(upload.data);
    run.taskId = task.id;
    if (run.cancelled) {
      void engine.cancelTask(task.id).catch(() => {});
      return;
    }
    const deadline = Date.now() + 10 * 60 * 1000;
    let failures = 0;
    while (task.status === "queued" || task.status === "running") {
      if (run.cancelled) return;
      if (Date.now() > deadline)
        throw Error("Background removal took too long. Check the engine.");
      await sleep(600);
      try {
        task = await engine.task(task.id);
        failures = 0;
      } catch (e) {
        if (++failures > 5) throw e;
      }
    }
    if (run.cancelled || task.status === "cancelled") return;
    if (task.status === "failed") throw Error(task.message);
    const matte = await engine.taskMask(task.id);
    const asset = project.assets[assetId];
    if (!asset) throw Error("The image changed. Try again.");
    const mask = await maskFromMatte(matte, asset.width, asset.height);
    if (run.cancelled) return;
    // Only apply to the same layer, still showing the pixels the mask was computed from.
    if (
      project.id !== projectId ||
      !project.layers.includes(l) ||
      l.assetId !== assetId ||
      locked(project, l)
    )
      throw Error(
        "The image changed while its background was being removed. Try again.",
      );
    const replaced = !!l.layerMask;
    commit(() => {
      const id = crypto.randomUUID();
      project.assets[id] = { id, ...mask };
      // Keep a live feather; drop density, which would show the background again.
      const feather = l.layerMask?.feather;
      l.layerMask = {
        assetId: id,
        enabled: true,
        ...(feather ? { feather } : {}),
      };
    });
    toast(
      (task.demo
        ? "Demo mask applied (border-colour key, not AI). "
        : "Background hidden with a layer mask. ") +
        (replaced ? "Undo restores your previous mask. " : "") +
        "Refine the edge with Edit mask or Feather.",
    );
  } catch (e) {
    fail(e);
  } finally {
    if (backgroundTask === run) backgroundTask = null;
    renderSelection();
  }
}
button("remove-background").onclick = () => void removeBackground();
button("invert-mask").onclick = async () => {
  const l = current();
  if (!l?.layerMask || locked(project, l)) return;
  const maskId = l.layerMask.assetId;
  try {
    const inverted = await invertMask(project.assets[maskId]);
    if (!project.layers.includes(l) || l.layerMask?.assetId !== maskId) return;
    commit(() => {
      const id = crypto.randomUUID();
      project.assets[id] = { id, ...inverted };
      l.layerMask = { ...l.layerMask!, assetId: id };
    });
    toast("Mask inverted: hidden and visible areas swapped.");
  } catch (e) {
    fail(e);
  }
};

type SliderSpec = {
  key: AdjustmentKey;
  label: string;
  toUi?: (v: number) => number;
  fromUi?: (v: number) => number;
  format: (v: number) => string;
  heading?: string;
};
const signed = (v: number) => (v > 0 ? `+${v}` : String(v));
const adjustmentSpecs: SliderSpec[] = [
  { key: "brightness", label: "Brightness", format: signed },
  { key: "contrast", label: "Contrast", format: signed },
  { key: "saturation", label: "Saturation", format: signed },
  { key: "hue", label: "Hue", format: (v) => `${signed(v)}°` },
  {
    key: "warmth",
    label: "Warmth",
    format: (v) => (v ? `${signed(v)} ${v > 0 ? "warm" : "cool"}` : "0"),
  },
  {
    key: "tint",
    label: "Tint",
    format: (v) => (v ? `${signed(v)} ${v > 0 ? "magenta" : "green"}` : "0"),
  },
  { key: "black", label: "Black point", format: String, heading: "LEVELS" },
  {
    key: "gamma",
    label: "Midtones",
    // Symmetric slider: −100…100 maps to 0.25…4 (1 = unchanged).
    toUi: (g) => Math.round(50 * Math.log2(g)),
    fromUi: (v) => +(2 ** (v / 50)).toFixed(3),
    format: (g) => g.toFixed(2),
  },
  { key: "white", label: "White point", format: String },
];
const adjustmentInputs = new Map<AdjustmentKey, HTMLInputElement>();
let adjustEditing = false;
for (const spec of adjustmentSpecs) {
  const host = $("adjustment-sliders");
  if (spec.heading)
    host.append(textNode("span", spec.heading, "eyebrow adjustment-heading"));
  const label = textNode("label", `${spec.label} `);
  const output = document.createElement("output");
  const slider = document.createElement("input");
  slider.type = "range";
  const [min, max] = adjustmentRanges[spec.key];
  slider.min = String(spec.toUi ? spec.toUi(min) : min);
  slider.max = String(spec.toUi ? spec.toUi(max) : max);
  slider.step = "1";
  slider.id = `adjust-${spec.key}`;
  slider.title = "Double-click to reset";
  slider.setAttribute("aria-label", spec.label);
  label.append(output, slider);
  host.append(label);
  adjustmentInputs.set(spec.key, slider);
  slider.onpointerdown = slider.onfocus = () => (adjustEditing = false);
  slider.oninput = () => {
    const l = current();
    if (!l?.assetId || locked(project, l)) return;
    if (!adjustEditing) {
      history.push(project);
      adjustEditing = true;
    }
    const a = (l.adjustments ??= { ...neutralAdjustments });
    const value = spec.fromUi ? spec.fromUi(+slider.value) : +slider.value;
    a[spec.key] = value;
    // Keep Levels valid: the other end moves out of the way.
    if (spec.key === "black" && a.white - a.black < 5) a.white = a.black + 5;
    if (spec.key === "white" && a.white - a.black < 5) a.black = a.white - 5;
    a.enabled = true;
    if (isNeutral(a)) delete l.adjustments;
    refreshLayerLooks();
    renderAdjustmentControls(l);
    syncHistory();
    autosave();
  };
  slider.onchange = () => {
    adjustEditing = false;
    renderLayers();
  };
  slider.ondblclick = () => {
    const l = current();
    if (!l?.adjustments || locked(project, l)) return;
    commit(() => {
      l.adjustments![spec.key] = neutralAdjustments[spec.key];
      if (isNeutral(l.adjustments)) delete l.adjustments;
    });
  };
}
function renderAdjustmentControls(l: Layer) {
  const a = l.adjustments ?? neutralAdjustments;
  const lockedLayer = locked(project, l);
  for (const spec of adjustmentSpecs) {
    const slider = adjustmentInputs.get(spec.key)!;
    slider.value = String(spec.toUi ? spec.toUi(a[spec.key]) : a[spec.key]);
    slider.disabled = lockedLayer;
    (slider.previousElementSibling as HTMLOutputElement).textContent =
      spec.format(a[spec.key]);
  }
  const changes = adjustmentSpecs.filter(
    (s) => a[s.key] !== neutralAdjustments[s.key],
  ).length;
  $("adjustments-state").textContent = !changes
    ? "none"
    : `${changes} change${changes > 1 ? "s" : ""}${a.enabled ? "" : " · hidden"}`;
  $("adjustments-card").classList.toggle(
    "has-changes",
    isActive(l.adjustments),
  );
  button("toggle-adjustments").disabled = !changes || lockedLayer;
  button("toggle-adjustments").textContent =
    changes && !a.enabled ? "Show adjustments" : "Hide adjustments";
  button("reset-adjustments").disabled = !changes || lockedLayer;
}
button("toggle-adjustments").onclick = () => {
  const l = current();
  if (l?.adjustments && !locked(project, l))
    commit(() => (l.adjustments!.enabled = !l.adjustments!.enabled));
};
button("reset-adjustments").onclick = () => {
  const l = current();
  if (l?.adjustments && !locked(project, l)) {
    commit(() => delete l.adjustments);
    toast("Adjustments reset. Undo brings them back.");
  }
};
let maskPropertyEditing = false;
for (const [id, apply] of [
  [
    "mask-feather",
    (m: NonNullable<Layer["layerMask"]>, v: number) =>
      v ? (m.feather = v) : delete m.feather,
  ],
  [
    "mask-density",
    (m: NonNullable<Layer["layerMask"]>, v: number) =>
      v < 100 ? (m.density = v / 100) : delete m.density,
  ],
] as const) {
  const slider = input(id);
  slider.onpointerdown = slider.onfocus = () => (maskPropertyEditing = false);
  slider.oninput = () => {
    const l = current();
    if (!l?.layerMask || locked(project, l)) return;
    if (!maskPropertyEditing) {
      history.push(project);
      maskPropertyEditing = true;
    }
    apply(l.layerMask, +slider.value);
    refreshLayerLooks();
    renderSelection();
    autosave();
  };
  slider.onchange = () => (maskPropertyEditing = false);
  slider.ondblclick = () => {
    const l = current();
    if (!l?.layerMask || locked(project, l)) return;
    commit(() => apply(l.layerMask!, id === "mask-feather" ? 0 : 100));
  };
}
button("restore-original").onclick = () => {
  const l = current();
  if (!l?.originalAssetId || locked(project, l)) return;
  commit(() => {
    l.assetId = l.originalAssetId;
    const a = project.assets[l.assetId!];
    l.width = a.width;
    l.height = a.height;
    delete l.originalAssetId;
    delete l.layerMask;
  });
  fit(true);
};
button("view-pixels").onclick = () => {
  const l = current();
  if (!l?.assetId) return;
  const a = project.assets[l.assetId],
    r = viewport.getBoundingClientRect();
  const z = Math.max(0.05, Math.min(8, a.width / l.width));
  project.view.zoom = z;
  project.view.x = r.width / 2 - (l.x + l.width / 2) * z;
  project.view.y = r.height / 2 - (l.y + l.height / 2) * z;
  view();
  autosave();
};

function renderReferences() {
  updateGuideSummary();
  const list = $("reference-list");
  list.replaceChildren();
  $("reference-count").textContent = `${project.references.length} / 3`;
  button("add-reference").disabled = project.references.length >= 3;
  $("reference-hint").textContent =
    service && !engineCapabilities.includes("reference")
      ? "This engine supports text only. To generate with references, use the updated Colab notebook with reference support enabled, then reconnect."
      : "Images are sent to your engine when you generate. Refer to image 1, 2, or 3 in your prompt.";
  project.references.forEach((id, index) => {
    const a = project.assets[id],
      row = textNode("div", "", "reference-row"),
      img = new Image();
    img.src = a.data;
    img.alt = `Reference ${index + 1}`;
    row.append(
      img,
      textNode("span", `Image ${index + 1} · ${a.width} × ${a.height}`),
      icon(`Remove reference ${index + 1}`, "×", () =>
        commit(() => {
          project.references = project.references.filter((key) => key !== id);
        }),
      ),
    );
    list.append(row);
  });
}
button("add-reference").onclick = () => input("reference-upload").click();
input("reference-upload").onchange = async () => {
  const files = Array.from(input("reference-upload").files || []),
    projectId = project.id;
  input("reference-upload").value = "";
  for (const file of files) {
    if (project.references.length >= 3) {
      toast("You can use up to three reference images.");
      break;
    }
    try {
      if (
        !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
        file.size > 40 * 1024 * 1024
      )
        throw Error("Use PNG, JPEG or WebP images under 40 MB.");
      const data = await readData(file),
        img = new Image();
      img.src = data;
      await img.decode();
      if (project.id !== projectId) return;
      if (
        img.naturalWidth * img.naturalHeight > 64e6 ||
        Math.max(img.naturalWidth, img.naturalHeight) > 32768
      )
        throw Error(
          "Reference images must be under 64 megapixels and 32,768 pixels per side.",
        );
      commit(() => {
        const id = crypto.randomUUID();
        project.assets[id] = {
          id,
          data,
          width: img.naturalWidth,
          height: img.naturalHeight,
        };
        project.references.push(id);
      });
    } catch (e) {
      fail(e);
    }
  }
};
button("reference-selection").onclick = () => {
  const l = current();
  if (!l?.assetId || selected.size !== 1)
    return toast("Select one image first.");
  if (project.references.includes(l.assetId))
    return toast("This image is already a reference.");
  if (project.references.length >= 3)
    return toast("Remove a reference before adding another.");
  commit(() => project.references.push(l.assetId!));
};
async function prepareReferences() {
  return Promise.all(
    project.references.map(async (id) => {
      const a = project.assets[id],
        img = new Image();
      img.src = a.data;
      await img.decode();
      const scale = Math.min(
        1,
        2048 / Math.max(img.naturalWidth, img.naturalHeight),
      );
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = canvas.getContext("2d")!;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL("image/png");
      if ((data.length - data.indexOf(",") - 1) * 0.75 > 8 * 1024 * 1024)
        throw Error(
          "A reference is too large to send. Resize it in the image editor first.",
        );
      return data;
    }),
  );
}

const contextMenu = document.createElement("div");
contextMenu.className = "context-menu";
contextMenu.hidden = true;
contextMenu.setAttribute("role", "menu");
document.body.append(contextMenu);
const menuActions: [string, string, () => void][] = [
  [
    "Edit layer",
    "↗",
    () => {
      showTab("layers");
      input("layer-name").focus();
    },
  ],
  ["Duplicate", "Ctrl D", () => button("duplicate").click()],
  [
    "Remove background",
    "AI",
    () => {
      showTab("layers");
      void removeBackground();
    },
  ],
  ["Bring forward", "]", () => reorder(1)],
  ["Send backward", "[", () => reorder(-1)],
  ["Focus selection", "Shift F", () => fit(true)],
  ["Export selection", "PNG", () => void png(selected)],
  ["Delete", "⌫", remove],
];
for (const [name, hint, action] of menuActions) {
  const b = document.createElement("button");
  b.setAttribute("role", "menuitem");
  b.append(textNode("span", name), textNode("small", hint));
  b.onclick = () => {
    contextMenu.hidden = true;
    action();
  };
  contextMenu.append(b);
}
viewport.oncontextmenu = (e) => {
  e.preventDefault();
  const item = (e.target as HTMLElement).closest<HTMLElement>(".item");
  if (item?.dataset.id && !selected.has(item.dataset.id))
    choose(item.dataset.id);
  if (!selected.size) return;
  contextMenu.hidden = false;
  contextMenu.style.left = `${Math.min(e.clientX, innerWidth - 220)}px`;
  contextMenu.style.top = `${Math.min(e.clientY, innerHeight - 300)}px`;
  contextMenu.querySelector<HTMLButtonElement>("button")!.focus();
};
document.addEventListener("pointerdown", (e) => {
  if (!contextMenu.contains(e.target as Node)) contextMenu.hidden = true;
});
contextMenu.onkeydown = (e) => {
  const buttons = [...contextMenu.querySelectorAll("button")],
    at = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    e.stopPropagation();
    buttons[
      (at + (e.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length
    ].focus();
  }
  if (e.key === "Escape") {
    contextMenu.hidden = true;
    viewport.focus();
  }
};

const engineHistory = document.createElement("section");
engineHistory.className = "engine-history";
engineHistory.innerHTML =
  '<div class="section-heading"><span class="eyebrow">FROM YOUR ENGINE</span><button class="quiet tiny" id="refresh-engine-history">Refresh</button></div><p class="subtle">Reconnect to recover recent images or resume a job after an interruption.</p><div id="engine-jobs"></div>';
$("panel-history").append(engineHistory);
button("refresh-engine-history").onclick = () => void refreshEngineHistory();
async function refreshEngineHistory() {
  const list = $("engine-jobs");
  list.replaceChildren();
  if (!service) {
    list.append(
      textNode("p", "Connect your engine to view its recent jobs.", "subtle"),
    );
    return;
  }
  const engine = service;
  button("refresh-engine-history").disabled = true;
  try {
    const jobs = await engine.jobs();
    if (engine !== service) return;
    if (!jobs.length)
      list.append(textNode("p", "No jobs on this engine yet.", "subtle"));
    for (const job of jobs.slice(0, 12)) {
      const row = document.createElement("button");
      row.className = "engine-job";
      row.append(
        textNode("span", job.metadata.prompt ?? job.metadata.text ?? job.metadata.style ?? ""),
        textNode(
          "small",
          `${job.metadata.demo ? "DEMO · " : ""}${({ video: "VIDEO · ", edit: "EDIT · ", speech: "VOICE · ", music: "SONG · " } as Record<string, string>)[job.metadata.kind ?? ""] ?? ""}${job.status} · Seed ${job.metadata.seed}`,
        ),
      );
      row.disabled = generating;
      row.onclick = () => {
        const audio = job.metadata.kind === "speech" || job.metadata.kind === "music";
        if ((job.status === "failed" || job.status === "cancelled") && audio) {
          showTab("audio");
          toast(`That ${job.metadata.kind === "music" ? "song" : "voice clip"} did not finish: ${job.message}`);
        } else if (job.status === "failed" || job.status === "cancelled") {
          const {
            prompt,
            negative_prompt,
            width,
            height,
            steps,
            guidance,
            seed,
          } = job.metadata;
          project.settings = {
            prompt,
            negative_prompt,
            width,
            height,
            steps,
            guidance,
            seed,
          };
          settingsToForm();
          showTab("create");
          autosave();
        } else {
          if (!audio) showTab("create");
          void runGeneration(engine, () => engine.job(job.id));
        }
      };
      row.title =
        job.status === "succeeded"
          ? "Place this result on the canvas"
          : ["queued", "running"].includes(job.status)
            ? "Resume following this job"
            : "Use these settings again";
      list.append(row);
    }
  } catch (e) {
    list.append(textNode("p", (e as Error).message, "subtle"));
  } finally {
    button("refresh-engine-history").disabled = false;
  }
}
button("connect-open").onclick = () => {
  if (generating)
    return toast(
      "Finish or cancel this generation before changing the connection.",
    );
  connectionDialog.showModal();
};
button("connection-close").onclick = () => connectionDialog.close();
button("disconnect").onclick = () => {
  engineCapabilities = [];
  engineMatting = undefined;
  service = null;
  input("service-token").value = "";
  $("connection-label").textContent = "Your private engine";
  $("connection-detail").textContent = "Connect when you’re ready to create";
  $("connection-dot").classList.remove("online");
  connectionDialog.close();
  renderReferences();
  renderSelection();
  syncPanels();
};
$<HTMLFormElement>("connection-form").onsubmit = async (e) => {
  e.preventDefault();
  button("connection-submit").disabled = true;
  $("connection-error").textContent = "";
  try {
    const candidate = new StudioService(
      input("service-url").value.trim(),
      input("service-token").value.trim(),
    );
    const health = await candidate.health();
    if (!health.ready) throw Error(health.message);
    service = candidate;
    engineCapabilities = health.capabilities;
    engineMatting = health.matting_mode;
    renderReferences();
    renderSelection();
    syncPanels();
    $("connection-label").textContent =
      health.mode === "demo"
        ? "Demo engine · no AI model"
        : "Private engine connected";
    $("connection-detail").textContent =
      health.mode === "demo"
        ? "Test artwork only · for trying the studio"
        : "Ready to bring your ideas to life";
    $("connection-dot").classList.add("online");
    input("service-token").value = "";
    connectionDialog.close();
    toast(
      health.mode === "demo"
        ? "Demo connected. Outputs are procedural test artwork, not AI generation."
        : "Your engine is ready.",
    );
  } catch (e) {
    $("connection-error").textContent = (e as Error).message;
  } finally {
    button("connection-submit").disabled = false;
  }
};
let jobView: JobView | null = null;
function createJobView(): JobView {
  return {
    panel: $("job-panel"),
    label: $("job-label"),
    progress: $<HTMLProgressElement>("job-progress"),
    cancel: button("cancel-job"),
  };
}
function updateJob(job: Job, view = jobView ?? createJobView()) {
  view.label.textContent = job.message;
  if (job.progress === null) view.progress.removeAttribute("value");
  else view.progress.value = job.progress;
}
function syncPanels() {
  layerAI?.sync();
  glitchPanel?.sync();
  animatePanel?.sync();
  audioPanel?.sync();
  promptImprove?.sync();
  if (promptImprove) promptImprove.element.hidden = !!service && !engineCapabilities.includes("enhance-prompt");
}
$<HTMLFormElement>("generation-form").onsubmit = async (e) => {
  e.preventDefault();
  if (generating) return;
  try {
    const s = formSettings();
    validateSettings(s);
    project.settings = s;
    autosave();
    if (!service) {
      connectionDialog.showModal();
      return;
    }
    const engine = service;
    if ((project.references.length || project.pose?.enabled) && !engineCapabilities.includes("reference"))
      throw Error(
        "Your engine does not support references yet. Run the updated Colab notebook with reference support enabled, then reconnect, or remove the references for text-only generation.",
      );
    if (s.transparent && !engineCapabilities.includes("transparent"))
      throw Error(
        "This engine cannot create transparent images. Run the updated Colab notebook and reconnect, or untick Transparent background.",
      );
    const projectId = project.id;
    await runGeneration(engine, async () => {
      const references = await prepareReferences();
      if (project.id !== projectId)
        throw Error("The project changed before generation started.");
      const pose = poseForGeneration(project, s.width, s.height, references.length);
      return pose
        ? engine.generate({ ...s, prompt: `${s.prompt} ${pose.instruction}` }, [...references, pose.image])
        : engine.generate(s, references);
    });
  } catch (e) {
    fail(e);
  }
};
/** Fetch an image result, keep it in History and place it on the canvas. */
async function placeImageJob(job: Job, engine: StudioService) {
  const projectId = project.id;
  let entry = project.gallery.find((g) => g.id === job.id);
  if (!entry) {
    const blob = await engine.output(job.output_id!),
      data = await readData(blob),
      img = new Image();
    img.src = data;
    await img.decode();
    if (project.id !== projectId)
      throw Error("The project changed before its result arrived.");
    const assetId = crypto.randomUUID();
    const metadata = job.metadata.kind === "upscale" ? upscaleMetadata(job.metadata as any, undefined, project.settings) : job.metadata;
    commit(() => {
      project.assets[assetId] = {
        id: assetId,
        data,
        width: img.width,
        height: img.height,
      };
      project.gallery.push({ id: job.id, assetId, metadata });
    });
    entry = project.gallery.find((g) => g.id === job.id)!;
  }
  placeAsset(entry.assetId, entry.metadata);
  toast(
    job.metadata.demo
      ? "Demo artwork added to your canvas."
      : "Your new image is on the canvas.",
  );
}
async function runGeneration(
  engine: StudioService,
  submit: () => Promise<Job>,
) {
  await runEngineJob(engine, () => submit(), createJobView(), (job, e) =>
    job.metadata.kind === "video"
      ? animatePanel!.placeVideo(job, e)
      : job.metadata.kind === "speech" || job.metadata.kind === "music"
        ? audioPanel!.placeAudio(job, e)
        : placeImageJob(job, e),
  );
}
/** One engine job at a time, followed with progress in `view`. */
async function runEngineJob(
  engine: StudioService,
  submit: (engine: StudioService) => Promise<Job>,
  view: JobView,
  handle: (job: Job, engine: StudioService) => Promise<void>,
) {
  if (generating) {
    toast("Your engine is busy. Wait for the current job or cancel it.");
    return false;
  }
  const projectId = project.id;
  generating = true;
  jobView = view;
  button("generate").disabled = true;
  view.cancel.disabled = true;
  view.cancel.onclick = () => void cancelActive();
  view.panel.hidden = false;
  view.label.textContent = "Reaching your engine…";
  view.progress.removeAttribute("value");
  syncPanels();
  let failed = false,
    succeeded = false;
  try {
    let job = await submit(engine);
    activeJob = job.id;
    view.cancel.disabled = false;
    updateJob(job, view);
    let failures = 0;
    while (job.status === "queued" || job.status === "running") {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        job = await engine.job(job.id);
        failures = 0;
        updateJob(job, view);
      } catch {
        if (++failures >= 5)
          throw Error(
            "Connection interrupted. Reconnect, then open History → From your engine to recover this job.",
          );
        view.label.textContent = "Connection interrupted. Retrying…";
      }
    }
    if (job.status === "cancelled") {
      toast("Cancelled.");
      return false;
    }
    if (job.status === "failed") throw Error(job.message);
    if (!job.output_id) throw Error("The service did not return an output.");
    if (project.id !== projectId)
      throw Error("The project changed before its result arrived.");
    await handle(job, engine);
    succeeded = true;
  } catch (e) {
    failed = true;
    view.label.textContent = (e as Error).message;
    fail(e);
  } finally {
    generating = false;
    activeJob = null;
    jobView = null;
    button("generate").disabled = false;
    view.cancel.disabled = true;
    view.panel.hidden = !failed;
    syncPanels();
  }
  return succeeded;
}
async function cancelActive() {
  if (!activeJob || !service) return;
  const view = jobView;
  if (view) view.cancel.disabled = true;
  try {
    const job = await service.cancel(activeJob);
    if (view) updateJob(job, view);
  } catch (e) {
    fail(e);
  } finally {
    if (view && jobView === view) view.cancel.disabled = false;
  }
}

const studio: StudioContext = {
  project: () => project,
  current,
  selectedLayers: () => project.layers.filter((l) => selected.has(l.id)),
  select(ids) {
    selected = new Set(ids);
    renderSelection();
    renderLayers();
  },
  commit,
  undo: (redo = false) => undo(redo),
  render,
  service: () => service,
  capabilities: () => engineCapabilities,
  toast,
  fail,
  fit,
  showTab,
  center,
  isLocked: (l) => locked(project, l),
  busy: () => generating,
  async exclusive(task) {
    if (generating) {
      toast("Your engine is busy. Wait for the current job or cancel it.");
      return undefined;
    }
    generating = true;
    button("generate").disabled = true;
    syncPanels();
    try {
      return await task();
    } finally {
      generating = false;
      button("generate").disabled = false;
      syncPanels();
    }
  },
  runJob(submit, view, handle) {
    if (!service) {
      connectionDialog.showModal();
      return Promise.resolve(false);
    }
    return runEngineJob(service, submit, view, handle);
  },
};
layerAI = installLayerAI(studio);
glitchPanel = installGlitchPanel(studio);
animatePanel = installAnimate(studio);
audioPanel = installAudio(studio);
poseControls = installPoseControls(studio, () => {
  const s = formSettings();
  return { width: s.width, height: s.height };
});
{
  const ideaLabel = document.querySelector<HTMLLabelElement>('label[for="prompt"]')!;
  promptImprove = improveButton(studio, $<HTMLTextAreaElement>("prompt"), "image");
  const row = document.createElement("div");
  row.className = "field-heading prompt-heading";
  ideaLabel.replaceWith(row);
  ideaLabel.classList.remove("field-label");
  row.append(ideaLabel, promptImprove.element);
}

async function start() {
  installToolIcons();
  try {
    const saved = await loadLocal();
    if (saved) {
      project = saved;
      $("save-status").textContent = "Saved on this device";
    } else {
      const old = localStorage.getItem("studio-zero-project");
      if (old) {
        const p = JSON.parse(old);
        project.title = String(p.title || "Recovered canvas").slice(0, 200);
        for (const l of p.layers || []) {
          const layer = newLayer(
            l.type === "image"
              ? "image"
              : l.type === "request"
                ? "prompt"
                : "note",
            Number(l.x) || 0,
            Number(l.y) || 0,
          );
          layer.name = String(l.name || layer.name).slice(0, 200);
          layer.width = Number(l.width) || layer.width;
          layer.height = Number(l.height) || layer.height;
          const doc = new DOMParser().parseFromString(
            String(l.text || l.prompt || ""),
            "text/html",
          );
          layer.text = doc.body.textContent || "";
          if (layer.kind === "image") {
            if (!/^data:image\/(png|jpeg|webp);base64,/.test(l.src)) continue;
            layer.assetId = crypto.randomUUID();
            project.assets[layer.assetId] = {
              id: layer.assetId,
              data: l.src,
              width: layer.width,
              height: layer.height,
            };
          }
          project.layers.push(layer);
        }
        project = parseProject(JSON.stringify(project));
        autosave();
        toast("Recovered your previous canvas.");
      }
    }
  } catch {
    toast("Could not restore autosave. You can open a saved .zero project.");
  }
  settingsToForm();
  render();
  connectFromLink();
}
/** The notebook's "Open Studio Zero" link carries the address and key in the #fragment (never sent to a server). */
function connectFromLink() {
  const params = new URLSearchParams(location.hash.slice(1));
  const url = params.get("connect");
  if (!url) return;
  const key = params.get("key");
  window.history.replaceState(null, "", location.pathname + location.search);
  input("service-url").value = url;
  if (key) input("service-token").value = key;
  connectionDialog.showModal();
  if (key) $<HTMLFormElement>("connection-form").requestSubmit();
}
void start();
