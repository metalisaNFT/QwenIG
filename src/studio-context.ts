/** What feature panels may use from the studio. Keeps main.ts the single owner of state. */
import type { Layer, Project } from "./model.ts";
import type { Job, StudioService } from "./service.ts";

export interface JobView {
  panel: HTMLElement;
  label: HTMLElement;
  progress: HTMLProgressElement;
  cancel: HTMLButtonElement;
}

export interface StudioContext {
  project(): Project;
  current(): Layer | undefined;
  selectedLayers(): Layer[];
  select(ids: string[]): void;
  commit(action: () => void): void;
  /** Project undo / redo (for dialogs, where the global shortcuts are paused). */
  undo(redo?: boolean): void;
  render(): void;
  service(): StudioService | null;
  capabilities(): string[];
  toast(message: string): void;
  fail(e: unknown): void;
  fit(selectionOnly?: boolean): void;
  showTab(name: string): void;
  center(): { x: number; y: number };
  isLocked(l: Layer): boolean;
  /** True while any engine job runs (one at a time keeps the single GPU queue honest). */
  busy(): boolean;
  /**
   * Submit and follow one engine job with progress in `view`. `handle` receives the finished
   * job and fetches/places its output. Resolves true on success, false on cancel or failure.
   */
  runJob(
    submit: (engine: StudioService) => Promise<Job>,
    view: JobView,
    handle: (job: Job, engine: StudioService) => Promise<void>,
  ): Promise<boolean>;
  /** Run engine work that is not a single job (e.g. per-frame background removal) as the one busy task. */
  exclusive<T>(task: () => Promise<T>): Promise<T | undefined>;
}

/** Small DOM helper shared by panels. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, string | boolean | number>> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (key === "class") el.className = String(value);
    else if (key === "text") el.textContent = String(value);
    else if (key in el && typeof value !== "string") (el as any)[key] = value;
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  el.append(...children);
  return el;
}

export function jobView(prefix: string): { element: HTMLElement; view: JobView } {
  const label = h("span", { class: "job-text", text: "Waiting…" });
  const cancel = h("button", { type: "button", class: "quiet tiny", text: "Cancel" });
  const progress = h("progress", { max: 100 }) as HTMLProgressElement;
  const panel = h("div", { class: "inline-job", id: `${prefix}-job`, hidden: true }, h("div", { class: "job-line" }, label, cancel), progress);
  return { element: panel, view: { panel, label, progress, cancel } };
}

export async function blobImage(blob: Blob) {
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  const img = new Image();
  img.src = data;
  await img.decode();
  return { data, width: img.naturalWidth, height: img.naturalHeight };
}
