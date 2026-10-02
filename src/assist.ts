/**
 * Small engine helpers shared by panels: follow a short task, "Improve" a prompt in place,
 * and describe an image as a prompt. They run as the studio's one busy task (single GPU queue).
 */
import type { Asset } from "./model.ts";
import type { PromptResult, PromptTarget, StudioService, Task } from "./service.ts";
import type { StudioContext } from "./studio-context.ts";
import { h } from "./studio-context.ts";
import { engineUpload } from "./background.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll a task until it ends; returns its result or throws its message. */
export async function followTask<R>(
  engine: StudioService,
  start: Task<R>,
  options: { onProgress?: (task: Task<R>) => void; cancelled?: () => boolean; timeoutMs?: number } = {},
): Promise<R> {
  let task = start;
  const deadline = Date.now() + (options.timeoutMs ?? 15 * 60 * 1000);
  let failures = 0;
  while (task.status === "queued" || task.status === "running") {
    if (options.cancelled?.()) {
      void engine.cancelTask(task.id).catch(() => {});
      throw Error("Cancelled.");
    }
    if (Date.now() > deadline) throw Error("The engine took too long. Try again.");
    await sleep(600);
    try {
      task = await engine.task<R>(task.id);
      failures = 0;
    } catch (e) {
      if (++failures >= 5) throw e;
    }
    options.onProgress?.(task);
  }
  if (task.status === "cancelled") throw Error("Cancelled.");
  if (task.status !== "succeeded" || task.result === undefined) throw Error(task.message);
  return task.result;
}

/** The engine, or a helpful toast when it is missing or lacks `capability`. */
export function engineFor(ctx: StudioContext, capability: string, setting: string): StudioService | null {
  const engine = ctx.service();
  if (!engine) {
    ctx.toast("Connect your engine first.");
    return null;
  }
  if (!ctx.capabilities().includes(capability)) {
    ctx.toast(`Your engine does not offer this yet. Turn on ${setting} in the Colab notebook, run it, then reconnect.`);
    return null;
  }
  return engine;
}

/**
 * A "✦ Improve" button for a prompt field: rewrites the text with the engine's prompt helper.
 * The previous text stays one click away ("Undo") until the user types again.
 */
export function improveButton(ctx: StudioContext, field: HTMLTextAreaElement | HTMLInputElement, target: PromptTarget) {
  const improve = h("button", {
    type: "button",
    class: "assist-button",
    title: "Rewrite this idea into a detailed prompt with your engine's assistant",
    text: "✦ Improve",
  }) as HTMLButtonElement;
  const undo = h("button", { type: "button", class: "assist-button undo", hidden: true, text: "↺ Undo" }) as HTMLButtonElement;
  let previous: string | null = null;
  const wrap = h("span", { class: "assist-row" }, improve, undo);
  field.addEventListener("input", () => {
    previous = null;
    undo.hidden = true;
  });
  undo.onclick = () => {
    if (previous === null) return;
    field.value = previous;
    previous = null;
    undo.hidden = true;
    field.dispatchEvent(new Event("change", { bubbles: true }));
  };
  improve.onclick = async () => {
    const text = field.value.trim();
    if (!text) return ctx.toast("Write a short idea first, then Improve it.");
    const engine = engineFor(ctx, "enhance-prompt", "ENABLE_ASSISTANT");
    if (!engine) return;
    const label = improve.textContent;
    improve.textContent = "Improving…";
    try {
      const result = await ctx.exclusive(async () =>
        followTask<PromptResult>(engine, await engine.enhancePrompt(text, target), { timeoutMs: 5 * 60 * 1000 }),
      );
      if (!result) return;
      if (field.value.trim() !== text) return ctx.toast("You edited the prompt meanwhile, so it was left as is.");
      previous = field.value;
      field.value = result.prompt;
      undo.hidden = false;
      field.dispatchEvent(new Event("change", { bubbles: true }));
      ctx.toast(/demo/i.test(result.model) ? "Demo rewrite (not AI)." : "Prompt improved. Undo brings back yours.");
    } catch (e) {
      ctx.fail(e);
    } finally {
      improve.textContent = label;
    }
  };
  const sync = () => {
    improve.disabled = ctx.busy();
  };
  return { element: wrap, sync };
}

/** Describe an image asset with the engine's vision model. */
export async function describeAsset(
  ctx: StudioContext,
  asset: Asset,
  purpose: "image" | "video" | "caption" = "image",
): Promise<string | undefined> {
  const engine = engineFor(ctx, "describe", "ENABLE_ASSISTANT");
  if (!engine) return undefined;
  const upload = await engineUpload(asset);
  const result = await ctx.exclusive(async () =>
    followTask<PromptResult>(engine, await engine.describe(upload.data, purpose), { timeoutMs: 5 * 60 * 1000 }),
  );
  return result?.prompt;
}
