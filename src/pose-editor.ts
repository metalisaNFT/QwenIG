/**
 * Pose editor: drag the 18 OpenPose joints over an optional image, start from a preset, mirror it,
 * or detect the pose of a person in the image with the engine. Resolves with the pose, or null.
 */
import type { Asset } from "./model.ts";
import type { PoseSpec } from "./pose.ts";
import { cleanPose, drawPose, fitPose, hitJoint, JOINTS, mirrorPerson, PRESETS, presetPose } from "./pose.ts";
import type { StudioContext } from "./studio-context.ts";
import { h } from "./studio-context.ts";
import { engineFor, followTask } from "./assist.ts";
import { engineUpload } from "./background.ts";
import { loadAssetImage } from "./masking.ts";

const BOX = 520;

/** The skeleton as the engine sees it: a black PNG of exactly width × height. */
export function poseImage(pose: PoseSpec, width = pose.width, height = pose.height) {
  const fitted = width === pose.width && height === pose.height ? pose : fitPose(pose, width, height);
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  drawPose(c.getContext("2d")!, fitted);
  return c.toDataURL("image/png");
}

export async function openPoseEditor(
  ctx: StudioContext,
  options: { width: number; height: number; pose?: PoseSpec | null; background?: Asset; title?: string; detectOnOpen?: boolean },
): Promise<PoseSpec | null> {
  const { width, height } = options;
  let pose: PoseSpec = options.pose ? fitPose(options.pose, width, height) : presetPose("Standing", width, height);
  const scale = Math.min(BOX / width, BOX / height);
  const canvas = h("canvas", { class: "pose-canvas", "aria-label": "Pose — drag the joints" }) as HTMLCanvasElement;
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const g = canvas.getContext("2d")!;
  const background = options.background ? await loadAssetImage(options.background) : null;

  const presetSelect = h("select", { id: "pose-preset", "aria-label": "Preset" },
    h("option", { value: "", text: "Start from a preset…" }),
    ...Object.keys(PRESETS).map((name) => h("option", { value: name, text: name }))) as HTMLSelectElement;
  const mirror = h("button", { type: "button", class: "quiet", id: "pose-mirror", text: "⇋ Mirror" });
  const detect = h("button", { type: "button", class: "quiet", id: "pose-detect", text: "◎ Detect from image", hidden: !background });
  const status = h("p", { class: "subtle", id: "pose-status", role: "status", text: "Drag a joint to move it." });
  const use = h("button", { type: "button", class: "primary", id: "pose-use", text: "Use this pose" });
  const cancel = h("button", { type: "button", class: "quiet", text: "Cancel" });
  const dialog = h(
    "dialog",
    { class: "pose-dialog", "aria-label": "Pose editor" },
    h("div", { class: "dialog-heading" }, h("span", { class: "eyebrow", text: "POSE" }), h("h2", { text: options.title ?? "Strike a pose." })),
    h("div", { class: "pose-stage" }, canvas),
    h("div", { class: "ai-row" }, presetSelect, mirror, detect),
    status,
    h("p", { class: "subtle", text: "Poses guide Qwen-Image through a reference picture, so results follow them closely but not exactly." }),
    h("div", { class: "dialog-actions" }, cancel, use),
  ) as HTMLDialogElement;
  document.body.append(dialog);

  let hover: [number, number] | null = null,
    drag: [number, number] | null = null;
  function paint() {
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = "#000";
    g.fillRect(0, 0, canvas.width, canvas.height);
    if (background) {
      g.globalAlpha = 0.45;
      g.drawImage(background, 0, 0, canvas.width, canvas.height);
      g.globalAlpha = 1;
    }
    drawPose(g, pose, { background: false, scale, highlight: drag ?? hover });
  }
  const at = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * width, ((e.clientY - r.top) / r.height) * height] as const;
  };
  canvas.onpointerdown = (e) => {
    const [x, y] = at(e);
    drag = hitJoint(pose, x, y, 18 / scale);
    if (drag) {
      canvas.setPointerCapture(e.pointerId);
      status.textContent = JOINTS[drag[1]];
    }
    paint();
  };
  canvas.onpointermove = (e) => {
    const [x, y] = at(e);
    if (drag) {
      const k = pose.people[drag[0]][drag[1]];
      k[0] = Math.max(0, Math.min(width, Math.round(x * 10) / 10));
      k[1] = Math.max(0, Math.min(height, Math.round(y * 10) / 10));
    } else {
      hover = hitJoint(pose, x, y, 18 / scale);
      canvas.style.cursor = hover ? "grab" : "default";
    }
    paint();
  };
  canvas.onpointerup = () => {
    drag = null;
    paint();
  };
  presetSelect.onchange = () => {
    if (!presetSelect.value) return;
    pose = presetPose(presetSelect.value, width, height);
    presetSelect.value = "";
    paint();
  };
  mirror.onclick = () => {
    pose = { ...pose, people: pose.people.map((p) => mirrorPerson(p, width)) };
    paint();
  };
  async function runDetect() {
    if (!options.background) return;
    const engine = engineFor(ctx, "detect-pose", "ENABLE_POSE");
    if (!engine) return;
    detect.setAttribute("disabled", "");
    status.textContent = "Finding the person…";
    try {
      const upload = await engineUpload(options.background);
      const result = await ctx.exclusive(async () =>
        followTask<{ width: number; height: number; people: [number, number, number][][] }>(engine, await engine.detectPose(upload.data), {
          timeoutMs: 5 * 60 * 1000,
        }),
      );
      if (!result) return;
      const found = cleanPose(result);
      if (!found) {
        status.textContent = "No person found. Start from a preset and drag the joints instead.";
        return;
      }
      // The background fills the frame, so detection coordinates scale straight across.
      const sx = width / found.width,
        sy = height / found.height;
      pose = { width, height, people: found.people.slice(0, 1).map((p) => p.map(([x, y, c]) => [x * sx, y * sy, c] as [number, number, number])) };
      status.textContent = `Pose found${found.people.length > 1 ? ` (the most visible of ${found.people.length} people)` : ""}. Adjust any joint by dragging.`;
      paint();
    } catch (e) {
      status.textContent = (e as Error).message;
    } finally {
      detect.removeAttribute("disabled");
    }
  }
  detect.onclick = () => void runDetect();
  paint();
  dialog.showModal();
  if (options.detectOnOpen && background && ctx.capabilities().includes("detect-pose")) void runDetect();
  return new Promise((resolve) => {
    let result: PoseSpec | null = null;
    use.onclick = () => {
      result = pose;
      dialog.close();
    };
    cancel.onclick = () => dialog.close();
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(result);
    });
  });
}
