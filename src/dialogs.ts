import type { Project } from "./model.ts";
import { listLocal, loadLocal, download } from "./storage.ts";
import { exportPNG, nativeExportScale } from "./export.ts";
import { validatePixelSize } from "./image-editing.ts";

const paintDialog = document.createElement("dialog");
paintDialog.className = "paint-layer-dialog";
paintDialog.setAttribute("aria-label", "New paint layer");
paintDialog.innerHTML = `<form><div class="dialog-heading"><div><span class="eyebrow">START WITH A MARK</span><h2>New paint layer</h2></div><button type="button" class="quiet" data-close aria-label="Cancel new paint layer">✕</button></div><p class="subtle">Build a background, sketch an idea, or paint an overlay. Your layer stays separate from the artwork underneath.</p><label>Layer name<input name="name" maxlength="200" value="Paint layer" required></label><div class="input-grid"><label>Width (px)<input name="width" type="number" min="16" max="16384" required></label><label>Height (px)<input name="height" type="number" min="16" max="16384" required></label></div><label>Starting surface<select name="background"><option value="transparent">Transparent overlay</option><option value="#ffffff">White paper</option><option value="#181b19">Studio dark</option></select></label><p class="subtle" data-error role="alert"></p><button class="primary full" type="submit">Create & paint ↗</button></form>`;
document.body.append(paintDialog);
paintDialog.querySelector<HTMLButtonElement>("[data-close]")!.onclick = () =>
  paintDialog.close();
export function openPaintLayer(
  width: number,
  height: number,
  create: (name: string, canvas: HTMLCanvasElement) => void,
) {
  const form = paintDialog.querySelector("form")!;
  const field = (name: string) =>
    form.elements.namedItem(name) as HTMLInputElement;
  field("name").value = "Paint layer";
  field("width").value = String(width);
  field("height").value = String(height);
  field("background").value = "transparent";
  const error = paintDialog.querySelector<HTMLElement>("[data-error]")!;
  error.textContent =
    "Up to 16 megapixels. Dimensions match your selected image, or your generation settings.";
  form.onsubmit = (e) => {
    e.preventDefault();
    try {
      const w = +field("width").value,
        h = +field("height").value;
      validatePixelSize(w, h);
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      if (field("background").value !== "transparent") {
        const ctx = c.getContext("2d")!;
        ctx.fillStyle = field("background").value;
        ctx.fillRect(0, 0, w, h);
      }
      create(field("name").value.trim() || "Paint layer", c);
      paintDialog.close();
    } catch (e) {
      error.textContent = (e as Error).message;
    }
  };
  paintDialog.showModal();
}

// All templates here are static; user-authored strings are assigned as textContent.
const exportDialog = document.createElement("dialog");
exportDialog.className = "export-dialog";
exportDialog.innerHTML = `<div class="dialog-heading"><div><span class="eyebrow">THE FINISHING TOUCH</span><h2>Take it with you.</h2></div><button class="quiet" data-close aria-label="Close export">✕</button></div><div class="export-preview"><img alt="Composition export preview"></div><div class="export-options"><label>Size<select id="export-scale"><option value="0.5">Half · 0.5×</option><option value="1" selected>Canvas size · 1×</option><option value="2">Double · 2×</option></select></label><label>Background<select id="export-background"><option value="transparent">Transparent</option><option value="white">White</option><option value="dark">Studio dark</option></select></label><label>Margin<select id="export-padding"><option value="0">None</option><option value="32">32 px</option><option value="64">64 px</option><option value="128">128 px</option></select></label></div><p class="subtle export-description" role="status"></p><button class="primary full" data-download>Download PNG ↗</button>`;
document.body.append(exportDialog);
const nativeOption = document.createElement("option");
nativeOption.value = "native";
nativeOption.textContent = "Full image resolution";
exportDialog.querySelector("#export-scale")!.prepend(nativeOption);
let exportUrl = "",
  exportRevision = 0;
exportDialog.querySelector<HTMLButtonElement>("[data-close]")!.onclick = () =>
  exportDialog.close();
exportDialog.onclose = () => {
  exportRevision++;
  URL.revokeObjectURL(exportUrl);
  exportUrl = "";
};
export function openExport(project: Project, selected?: Set<string>) {
  const p = structuredClone(project),
    ids = selected ? new Set(selected) : undefined;
  (exportDialog.querySelector("#export-scale") as HTMLSelectElement).value =
    "native";
  const description = exportDialog.querySelector<HTMLElement>(
      ".export-description",
    )!,
    img = exportDialog.querySelector("img")!,
    downloadButton =
      exportDialog.querySelector<HTMLButtonElement>("[data-download]")!;
  let blob: Blob | null = null;
  async function preview() {
    const revision = ++exportRevision;
    downloadButton.disabled = true;
    description.textContent = "Preparing your composition…";
    try {
      const scaleValue = (
          exportDialog.querySelector("#export-scale") as HTMLSelectElement
        ).value,
        scale =
          scaleValue === "native" ? nativeExportScale(p, ids) : +scaleValue,
        background = (
          exportDialog.querySelector("#export-background") as HTMLSelectElement
        ).value as "transparent" | "white" | "dark",
        padding = +(
          exportDialog.querySelector("#export-padding") as HTMLSelectElement
        ).value;
      const result = await exportPNG(p, ids, { scale, background, padding });
      if (revision !== exportRevision) return;
      blob = result;
      URL.revokeObjectURL(exportUrl);
      exportUrl = URL.createObjectURL(result);
      img.src = exportUrl;
      await img.decode();
      if (revision !== exportRevision) return;
      description.textContent = `${img.naturalWidth.toLocaleString()} × ${img.naturalHeight.toLocaleString()} px · ${(blob.size / 1024).toFixed(0)} KB · ${ids ? "Selected layers" : "Whole composition"}`;
      downloadButton.disabled = false;
    } catch (e) {
      if (revision === exportRevision) {
        description.textContent = (e as Error).message;
        img.removeAttribute("src");
      }
    }
  }
  exportDialog
    .querySelectorAll("select")
    .forEach((el) => (el.onchange = () => void preview()));
  downloadButton.onclick = () => {
    if (blob) {
      download(`${p.title}${ids ? "-selection" : ""}.png`, blob);
      description.textContent += " · Download requested";
    }
  };
  exportDialog.showModal();
  void preview();
}

const library = document.createElement("dialog");
library.className = "library-dialog";
library.innerHTML = `<div class="dialog-heading"><div><span class="eyebrow">YOUR CREATIVE SPACE</span><h2>Pick up an idea.</h2></div><button class="quiet" data-close aria-label="Close projects">✕</button></div><p class="subtle">Projects saved on this device. Download a .zero file for a portable backup.</p><div class="project-grid"></div><p data-error role="alert"></p><div class="dialog-actions"><button class="quiet" data-import>Import .zero</button><button class="primary" data-new>＋ New canvas</button></div>`;
document.body.append(library);
library.querySelector<HTMLButtonElement>("[data-close]")!.onclick = () =>
  library.close();
export async function openLibrary(
  currentId: string,
  select: (p: Project) => Promise<void>,
  create: () => void,
  importFile: () => void,
) {
  const grid = library.querySelector<HTMLElement>(".project-grid")!,
    error = library.querySelector<HTMLElement>("[data-error]")!;
  grid.replaceChildren();
  error.textContent = "";
  library.showModal();
  library.querySelector<HTMLButtonElement>("[data-new]")!.onclick = () => {
    library.close();
    create();
  };
  library.querySelector<HTMLButtonElement>("[data-import]")!.onclick = () => {
    library.close();
    importFile();
  };
  try {
    const projects = await listLocal();
    if (!projects.length)
      error.textContent = "Your first saved canvas will appear here.";
    for (const p of projects) {
      const b = document.createElement("button");
      b.className = `project-card ${p.id === currentId ? "current" : ""}`;
      const cover = document.createElement("div");
      cover.className = "project-cover";
      if (p.thumbnail) {
        const img = new Image();
        img.src = p.thumbnail;
        img.alt = "";
        cover.append(img);
      } else cover.textContent = "Ø";
      const title = document.createElement("strong");
      title.textContent = p.title;
      const meta = document.createElement("small");
      meta.textContent = `${p.layers} layers${p.id === currentId ? " · Current canvas" : ""}`;
      b.append(cover, title, meta);
      b.onclick = async () => {
        try {
          const loaded = await loadLocal(p.id);
          if (!loaded) throw Error("This project could not be found.");
          await select(loaded);
          library.close();
        } catch (e) {
          error.textContent = (e as Error).message;
        }
      };
      grid.append(b);
    }
  } catch {
    error.textContent =
      "Browser storage is unavailable. You can still import a .zero file.";
  }
}
