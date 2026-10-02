/**
 * Create → Pose: a saved pose that guides new images. When on, generation sends the skeleton
 * as the last reference image and adds an instruction naming it.
 */
import type { Project } from "./model.ts";
import { drawPose, fitPose, poseInstruction } from "./pose.ts";
import { openPoseEditor, poseImage } from "./pose-editor.ts";
import type { StudioContext } from "./studio-context.ts";
import { h } from "./studio-context.ts";

/** The extra reference and prompt sentence for a generation, or null when no pose is on. */
export function poseForGeneration(project: Project, width: number, height: number, referenceCount: number) {
  if (!project.pose?.enabled) return null;
  if (referenceCount >= 3)
    throw Error("A pose uses one of the three reference slots. Remove a reference image or turn the pose off.");
  return { image: poseImage(project.pose.spec, width, height), instruction: poseInstruction(referenceCount + 1) };
}

export function installPoseControls(ctx: StudioContext, size: () => { width: number; height: number }) {
  const references = document.querySelector("#panel-create .references-panel")!;
  const thumb = h("canvas", { class: "pose-thumb", width: 54, height: 80, "aria-hidden": "true" }) as HTMLCanvasElement;
  const enabled = h("input", { type: "checkbox", id: "pose-enabled" }) as HTMLInputElement;
  const edit = h("button", { type: "button", class: "quiet", id: "pose-edit", text: "Edit pose ↗" });
  const clear = h("button", { type: "button", class: "quiet tiny", id: "pose-clear", text: "Clear" });
  const hint = h("p", { class: "subtle", id: "pose-hint" });
  const block = h(
    "section",
    { class: "pose-panel", "aria-label": "Pose" },
    h("div", { class: "field-heading" }, h("label", { text: "Pose" }), h("span", { text: "guides the figure" })),
    h("div", { class: "pose-row" }, thumb, h("div", { class: "pose-controls" }, h("label", { class: "check" }, enabled, "Use this pose"), h("div", { class: "ai-row" }, edit, clear))),
    hint,
  );
  references.before(block);

  function render() {
    const project = ctx.project();
    const pose = project.pose;
    const g = thumb.getContext("2d")!;
    g.fillStyle = "#000";
    g.fillRect(0, 0, thumb.width, thumb.height);
    if (pose) {
      const fitted = fitPose(pose.spec, thumb.width, thumb.height);
      drawPose(g, fitted, { background: false });
    }
    enabled.checked = !!pose?.enabled;
    enabled.disabled = !pose;
    clear.hidden = !pose;
    const reference = ctx.capabilities().includes("reference");
    hint.textContent = !pose
      ? "Draw a pose (or detect one from a photo) and new images follow it."
      : ctx.service() && !reference
        ? "Poses need reference support: run the notebook with ENABLE_REFERENCES and reconnect."
        : pose.enabled
          ? "On: the skeleton is sent as the last reference image. Results follow it closely, not exactly."
          : "Off: tick “Use this pose” to guide the next image.";
  }

  edit.onclick = async () => {
    const project = ctx.project();
    const { width, height } = size();
    const selected = ctx.current();
    const background = selected?.assetId ? project.assets[selected.assetId] : undefined;
    const spec = await openPoseEditor(ctx, {
      width,
      height,
      pose: project.pose?.spec ?? null,
      // Only a background with the frame's shape can be traced without distortion.
      background: background && Math.abs(background.width / background.height - width / height) < 0.02 ? background : undefined,
    });
    if (!spec || ctx.project() !== project) return;
    ctx.commit(() => {
      project.pose = { spec, enabled: true };
    });
    render();
    ctx.toast("Pose saved. New images follow it while “Use this pose” is ticked.");
  };
  enabled.onchange = () => {
    const project = ctx.project();
    if (!project.pose) return;
    ctx.commit(() => {
      project.pose!.enabled = enabled.checked;
    });
    render();
  };
  clear.onclick = () => {
    const project = ctx.project();
    ctx.commit(() => {
      delete project.pose;
    });
    render();
  };
  render();
  return { render };
}
