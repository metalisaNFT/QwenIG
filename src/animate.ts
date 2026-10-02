/**
 * The Animate tab: AI video (LTX-2.5 on the engine) and the sprite maker
 * (frames from layers, from a video, or generated per pose with a character reference).
 */
import type { Asset, Layer, Sprite, VideoAsset } from "./model.ts";
import { newLayer } from "./model.ts";
import type { Job, StudioService } from "./service.ts";
import type { StudioContext } from "./studio-context.ts";
import { blobImage, h, jobView } from "./studio-context.ts";
import { blobToDataURL, extractFrames, loadVideo, seek, drawFrame, videoInfo, videoURL } from "./video.ts";
import { fileStem, frameDurations } from "./sprites.ts";
import { editFrame } from "./ai-edit.ts";
import { loadAssetImage } from "./masking.ts";
import { download } from "./storage.ts";
import { assetImage, canvasAsset } from "./frames.ts";
import { openFrameEditor, spriteGIF } from "./frame-editor.ts";
import { improveButton } from "./assist.ts";

export const videoSizes = [
  [768, 512],
  [1024, 576],
  [1280, 704],
  [512, 768],
  [576, 1024],
  [704, 1280],
  [512, 512],
  [768, 768],
] as const;
export const videoLengths = [25, 49, 97, 121, 193] as const;

export function installAnimate(ctx: StudioContext) {
  const panel = document.getElementById("panel-animate")!;

  // ── Video ───────────────────────────────────────────────────────────────────
  const videoPrompt = h("textarea", {
    id: "video-prompt",
    rows: 4,
    maxlength: 20000,
    "aria-label": "Video prompt",
    placeholder: "A paper boat drifting down a rainy street at night, neon reflections, slow camera push-in…",
  }) as HTMLTextAreaElement;
  const videoSize = h("select", { id: "video-size", "aria-label": "Video size" },
    ...videoSizes.map(([w, hh], i) => h("option", { value: `${w}x${hh}`, text: `${w} × ${hh}${i === 0 ? " · fastest" : ""}` }))) as HTMLSelectElement;
  const videoFps = h("select", { id: "video-fps", "aria-label": "Frames per second" },
    h("option", { value: 24, text: "24 fps" }), h("option", { value: 12, text: "12 fps · sprite-friendly" })) as HTMLSelectElement;
  const videoLength = h("select", { id: "video-length", "aria-label": "Video length" }) as HTMLSelectElement;
  const syncLengths = () => {
    const fps = +videoFps.value,
      keep = videoLength.value || "97";
    videoLength.replaceChildren(...videoLengths.map((n) => h("option", { value: n, text: `${(n / fps).toFixed(1)} s · ${n} frames`, selected: String(n) === keep })));
  };
  videoFps.onchange = syncLengths;
  syncLengths();
  const videoSteps = h("input", { type: "number", id: "video-steps", min: 1, max: 100, value: 8 }) as HTMLInputElement;
  const videoGuidance = h("input", { type: "number", id: "video-guidance", min: 0, max: 20, step: 0.1, value: 1 }) as HTMLInputElement;
  const videoSeed = h("input", { type: "number", id: "video-seed", min: -1, max: 2147483647, value: -1 }) as HTMLInputElement;
  const videoNegative = h("textarea", { id: "video-negative", rows: 2, maxlength: 20000, "aria-label": "Video negative prompt" }) as HTMLTextAreaElement;
  videoNegative.value = "worst quality, low quality, blurry, distorted, artifacts";
  const videoImprove = improveButton(ctx, videoPrompt, "video");
  const fromSelection = h("input", { type: "checkbox", id: "video-from-selection" }) as HTMLInputElement;
  const fromSelectionRow = h("label", { class: "check" }, fromSelection, "Start from the selected image");
  const videoGenerate = h("button", { type: "button", class: "generate", id: "video-generate" }, h("span", { text: "▶" }), " Generate video ", h("span", { text: "↗" }));
  const { element: videoJobEl, view: videoView } = jobView("video");
  const videoStatus = h("p", { class: "subtle", id: "video-status" });
  const selectedVideo = h("div", { class: "edit-card", id: "selected-video", hidden: true });
  panel.append(
    h("div", { class: "section-heading" }, h("span", { class: "eyebrow", text: "AI VIDEO" }), h("span", { class: "accent", text: "▶" })),
    h("div", { class: "field-heading prompt-heading" }, h("label", { for: "video-prompt", text: "The shot" }), videoImprove.element),
    videoPrompt,
    h("div", { class: "input-grid" }, h("label", {}, "Size", videoSize), h("label", {}, "Speed", videoFps)),
    h("label", { class: "resolution-label" }, "Length", videoLength),
    fromSelectionRow,
    h(
      "details",
      { class: "advanced" },
      h("summary", {}, "Fine-tune ", h("span", { text: "⌄" })),
      h("div", { class: "input-grid" }, h("label", {}, "Steps", videoSteps), h("label", {}, "Guidance", videoGuidance)),
      h("label", { class: "seed-label" }, "Seed ", h("span", { text: "−1 = random" }), videoSeed),
      h("label", { class: "field-label", text: "Avoid" }),
      videoNegative,
    ),
    videoGenerate,
    videoJobEl,
    videoStatus,
    selectedVideo,
  );

  /** Download a finished video job and put it on the canvas as a video layer. */
  async function placeVideo(job: Job, engine: StudioService, label?: HTMLElement) {
    if (label) label.textContent = "Downloading your video…";
    const projectId = ctx.project().id;
    const blob = await engine.output(job.output_id!);
    const data = await blobToDataURL(blob);
    const m0 = job.metadata;
    // Prefer the engine's own numbers; the browser only refines them when it can decode the file.
    let info = { width: m0.width, height: m0.height, duration: (m0.frames || 1) / (m0.fps || 24) };
    let playable = true;
    const url = URL.createObjectURL(blob);
    try {
      info = await Promise.race([
        videoInfo(url),
        new Promise<never>((_, reject) => setTimeout(() => reject(Error("timeout")), 15000)),
      ]);
    } catch {
      playable = false;
    } finally {
      URL.revokeObjectURL(url);
    }
    const current = ctx.project();
    if (current.id !== projectId) throw Error("The project changed before the video arrived.");
    const existing = Object.values(current.videos).find((v) => v.metadata?.jobId === job.id);
    const id = existing?.id ?? crypto.randomUUID();
    const m = job.metadata;
    const video: VideoAsset = existing ?? {
      id,
      data,
      width: info.width,
      height: info.height,
      duration: info.duration,
      fps: m.fps || 24,
      metadata: {
        prompt: m.prompt,
        negative_prompt: m.negative_prompt,
        width: m.width,
        height: m.height,
        frames: m.frames || Math.round(info.duration * (m.fps || 24)),
        fps: m.fps || 24,
        steps: m.steps,
        guidance: m.guidance,
        seed: m.seed,
        model: m.model,
        jobId: m.jobId,
        createdAt: m.createdAt,
        ...(m.start_image ? { start_image: true } : {}),
        ...(m.demo ? { demo: true } : {}),
      },
    };
    const c = ctx.center();
    const layer = newLayer("video", c.x - info.width / 2, c.y - info.height / 2);
    Object.assign(layer, { videoId: id, width: info.width, height: info.height, name: m.prompt.slice(0, 60) || "Video" });
    ctx.commit(() => {
      current.videos[id] = video;
      current.layers.push(layer);
    });
    ctx.select([layer.id]);
    ctx.fit(true);
    ctx.toast(
      !playable
        ? "Video saved in your project, but this browser cannot play it. Download it from the Animate tab, or use Chrome, Edge, Firefox or Safari."
        : m.demo
          ? "Demo video added (procedural, not AI)."
          : "Your video is on the canvas.",
    );
  }

  videoGenerate.onclick = async () => {
    const text = videoPrompt.value.trim();
    if (!text) return ctx.toast("Describe the shot first.");
    const [width, height] = videoSize.value.split("x").map(Number);
    let image: string | undefined;
    const project = ctx.project();
    try {
      if (fromSelection.checked) {
        const l = ctx.current();
        if (!l?.assetId) return ctx.toast("Select an image to start from, or untick “Start from the selected image”.");
        image = await coverFrame(project.assets[l.assetId], width, height);
      }
      const request = {
        prompt: text,
        negative_prompt: videoNegative.value,
        width,
        height,
        frames: +videoLength.value,
        fps: +videoFps.value,
        steps: +videoSteps.value,
        guidance: +videoGuidance.value,
        seed: +videoSeed.value,
        ...(image ? { image } : {}),
      };
      await ctx.runJob((engine) => engine.video(request), videoView, (job, engine) => placeVideo(job, engine, videoView.label));
    } catch (e) {
      ctx.fail(e);
    } finally {
      sync();
    }
  };

  // ── Sprites ─────────────────────────────────────────────────────────────────
  const fromLayers = h("button", { type: "button", class: "quiet", id: "sprite-from-layers", text: "From selected layers" });
  const fromVideo = h("button", { type: "button", class: "quiet", id: "sprite-from-video", text: "From selected video" });
  const videoFrames = h("select", { id: "sprite-video-frames", "aria-label": "Frames to take" },
    ...[6, 8, 12, 16, 24].map((n) => h("option", { value: n, text: `${n} frames`, selected: n === 8 }))) as HTMLSelectElement;
  const videoEdge = h("select", { id: "sprite-video-size", "aria-label": "Frame size" },
    ...[128, 256, 512].map((n) => h("option", { value: n, text: `${n} px`, selected: n === 256 }))) as HTMLSelectElement;
  const poses = h("textarea", { id: "sprite-poses", rows: 4, maxlength: 4000, "aria-label": "One pose per line" }) as HTMLTextAreaElement;
  poses.value = "standing idle\nwalking, left foot forward\nwalking, both feet together\nwalking, right foot forward";
  const generateFrames = h("button", { type: "button", class: "primary full", id: "sprite-generate", text: "✦ Generate frames with AI" });
  const { element: spriteJobEl, view: spriteView } = jobView("sprite");
  const spriteStatus = h("p", { class: "subtle", id: "sprite-status" });
  const list = h("div", { id: "sprite-list" });
  panel.append(
    h("div", { class: "section-heading sprite-heading" }, h("span", { class: "eyebrow", text: "ANIMATIONS & SPRITES" }), h("span", { class: "accent", text: "▦" })),
    h("p", { class: "subtle", text: "Build an animation from layers, a video or AI poses. Edit its frames, add glitch effects, and export a GIF or a sprite sheet." }),
    h("div", { class: "selection-actions" }, fromLayers, fromVideo),
    h("div", { class: "ai-row" }, videoFrames, videoEdge),
    h(
      "details",
      { class: "advanced", id: "sprite-ai" },
      h("summary", {}, "Generate frames with AI ", h("span", { text: "⌄" })),
      h("p", { class: "subtle", text: "Select your character image first. Each line becomes one frame of the same character (needs reference support)." }),
      poses,
      generateFrames,
    ),
    spriteJobEl,
    spriteStatus,
    list,
  );

  const live = (id: string) => ctx.project().sprites.find((s) => s.id === id);
  function addSprite(name: string, assets: Asset[], fps = 8, pixelated = false, openEditor = false) {
    if (!assets.length) throw Error("A sprite needs at least one frame.");
    const project = ctx.project();
    const sprite: Sprite = { id: crypto.randomUUID(), name: name.slice(0, 200), fps, loop: true, frames: [], ...(pixelated ? { pixelated } : {}) };
    ctx.commit(() => {
      for (const a of assets) {
        project.assets[a.id] = a;
        sprite.frames.push({ assetId: a.id });
      }
      project.sprites.push(sprite);
    });
    renderList();
    if (openEditor) editFrames(sprite.id);
    return sprite;
  }

  fromLayers.onclick = () => {
    const project = ctx.project();
    const layers = ctx.selectedLayers().filter((l) => l.assetId);
    if (!layers.length) return ctx.toast("Select image layers first (shift-click). Left-to-right becomes frame order.");
    layers.sort((a, b) => a.x - b.x || a.y - b.y);
    addSprite(
      `Animation ${project.sprites.length + 1}`,
      layers.map((l) => project.assets[l.assetId!]),
      8,
      layers.every((l) => l.pixelated),
      true,
    );
    ctx.toast(`Sprite created from ${layers.length} layers (left to right).`);
  };

  fromVideo.onclick = async () => {
    const l = ctx.current();
    const project = ctx.project();
    const video = l?.videoId ? project.videos[l.videoId] : undefined;
    if (!video) return ctx.toast("Select a video layer first.");
    try {
      spriteStatus.textContent = "Reading frames…";
      const frames = await extractFrames(videoURL(video.id, video.data), { count: +videoFrames.value, maxEdge: +videoEdge.value }, (done, total) => {
        spriteStatus.textContent = `Reading frames… ${done} / ${total}`;
      });
      if (!frames.length) throw Error("No frames could be read from this video.");
      const fps = Math.max(1, Math.min(60, Math.round(frames.length / Math.max(0.1, video.duration))));
      addSprite(`${l!.name.slice(0, 40)} · frames`, frames.map(canvasAsset), fps, false, true);
      spriteStatus.textContent = "Frames ready. Remove backgrounds and align them below.";
    } catch (e) {
      spriteStatus.textContent = "";
      ctx.fail(e);
    }
  };

  generateFrames.onclick = async () => {
    const l = ctx.current();
    const project = ctx.project();
    if (!l?.assetId) return ctx.toast("Select your character image first.");
    if (!ctx.capabilities().includes("reference")) return ctx.toast("Generating frames needs reference support on the engine (ENABLE_REFERENCES).");
    const lines = poses.value.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 24);
    if (!lines.length) return ctx.toast("Write at least one pose.");
    const character = project.assets[l.assetId];
    const frame = editFrame(character.width, character.height, 1024);
    const reference = await coverFrame(character, Math.min(2048, character.width), Math.min(2048, character.height), true);
    const transparent = ctx.capabilities().includes("transparent");
    const projectId = project.id;
    let spriteId: string | null = null;
    let made = 0;
    for (const [index, pose] of lines.entries()) {
      spriteStatus.textContent = `Frame ${index + 1} of ${lines.length}: ${pose}`;
      const ok = await ctx.runJob(
        (engine) =>
          engine.generate(
            {
              ...project.settings,
              prompt: `${pose}. The same character as image 1: identical design, colours, proportions and art style. Full body, centred, facing the same way, plain background.`,
              width: frame.width,
              height: frame.height,
              seed: -1,
              ...(transparent ? { transparent: true } : {}),
            },
            [reference],
          ),
        spriteView,
        async (job, engine) => {
          const result = await blobImage(await engine.output(job.output_id!));
          const current = ctx.project();
          if (current.id !== projectId) throw Error("The project changed while frames were generating.");
          const asset: Asset = { id: crypto.randomUUID(), ...result };
          const sprite = spriteId ? live(spriteId) : undefined;
          if (!sprite) {
            if (spriteId) throw Error("The sprite was deleted; stopping.");
            spriteId = addSprite(`${l.name.slice(0, 40)} · poses`, [asset], 6, !!l.pixelated).id;
          } else
            ctx.commit(() => {
              current.assets[asset.id] = asset;
              sprite.frames.push({ assetId: asset.id });
            });
          made++;
        },
      );
      if (!ok) break;
    }
    spriteStatus.textContent = made ? `${made} frames generated.` : "";
  };

  // Animation cards: a live preview and the way into the frame editor ----------------------
  let listDirty = true;
  const previews = new Map<string, { canvas: HTMLCanvasElement; sprite: Sprite; playing: boolean }>();

  function editFrames(id: string) {
    openFrameEditor(ctx, id, () => renderList());
  }

  function renderList() {
    previews.clear();
    const project = ctx.project();
    list.replaceChildren();
    if (!project.sprites.length) {
      list.append(h("p", { class: "panel-empty", text: "No animations yet. Make one from layers, a video, AI poses, or Edit → Glitch & filters." }));
      return;
    }
    for (const sprite of [...project.sprites].reverse()) {
      const preview = h("canvas", { class: `sprite-preview${sprite.pixelated ? " crisp" : ""}`, width: 160, height: 160, "aria-label": `${sprite.name} preview` }) as HTMLCanvasElement;
      previews.set(sprite.id, { canvas: preview, sprite, playing: true });
      const sid = sprite.id;
      const total = frameDurations(sprite.frames, sprite.fps).reduce((x, y) => x + y, 0) / 1000;
      const open = h("button", { type: "button", class: "primary", text: "Edit frames ↗", "data-edit-frames": sid });
      open.onclick = () => editFrames(sid);
      preview.onclick = () => editFrames(sid);
      const gif = h("button", { type: "button", class: "quiet", text: "GIF ↓", "data-gif": sid });
      gif.onclick = async () => {
        const s = live(sid);
        if (!s?.frames.length) return;
        gif.setAttribute("disabled", "");
        gif.textContent = "Encoding…";
        try {
          const { blob, width, height } = await spriteGIF(ctx, s, {});
          download(`${fileStem(s.name)}.gif`, blob);
          ctx.toast(`Saved ${fileStem(s.name)}.gif · ${width} × ${height} · ${Math.max(1, Math.round(blob.size / 1024))} KB. More options in Edit frames → Export.`);
        } catch (e) {
          ctx.fail(e);
        } finally {
          gif.removeAttribute("disabled");
          gif.textContent = "GIF ↓";
        }
      };
      const remove = h("button", { type: "button", class: "quiet danger", text: "Delete", "data-delete-sprite": sid });
      remove.onclick = () => {
        ctx.commit(() => (ctx.project().sprites = ctx.project().sprites.filter((s) => s.id !== sid)));
        renderList();
        ctx.toast("Animation deleted. Undo brings it back.");
      };
      const card = h(
        "div",
        { class: "edit-card sprite-card", "data-sprite": sid },
        h("div", { class: "sprite-head" }, h("b", { text: sprite.name }), h("small", { text: `${sprite.frames.length} frames · ${sprite.fps} fps · ${total.toFixed(1)} s${sprite.loop ? "" : " · once"}` })),
        preview,
        h("div", { class: "sprite-actions" }, open, gif, remove),
      );
      list.append(card);
    }
  }

  // One animation loop for all previews; it only draws while the tab is visible.
  let last = performance.now();
  const clocks = new Map<string, { t: number; frame: number }>();
  function tick(now: number) {
    const dt = now - last;
    last = now;
    if (!panel.hidden) {
      const project = ctx.project();
      for (const [id, p] of previews) {
        const s = p.sprite;
        if (!s.frames.length || !p.canvas.isConnected) continue;
        const clock = clocks.get(id) ?? { t: 0, frame: 0 };
        clock.t += dt;
        const durations = frameDurations(s.frames, s.fps);
        while (clock.t >= durations[clock.frame % durations.length]) {
          clock.t -= durations[clock.frame % durations.length];
          clock.frame = s.loop ? (clock.frame + 1) % s.frames.length : Math.min(clock.frame + 1, s.frames.length - 1);
          if (!s.loop && clock.frame === s.frames.length - 1) break;
        }
        clocks.set(id, clock);
        const asset = project.assets[s.frames[clock.frame % s.frames.length].assetId];
        if (!asset) continue;
        const img = assetImage(asset);
        if (!img.complete || !img.naturalWidth) continue;
        const c = p.canvas,
          g = c.getContext("2d")!;
        g.clearRect(0, 0, c.width, c.height);
        g.imageSmoothingEnabled = !s.pixelated;
        const scale = Math.min(c.width / img.naturalWidth, c.height / img.naturalHeight);
        const k = s.pixelated && scale >= 1 ? Math.floor(scale) : scale;
        const w = img.naturalWidth * k,
          hh = img.naturalHeight * k;
        g.drawImage(img, (c.width - w) / 2, c.height - hh, w, hh);
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  function renderSelectedVideo() {
    const l = ctx.current();
    const project = ctx.project();
    const video = l?.kind === "video" && l.videoId ? project.videos[l.videoId] : undefined;
    selectedVideo.hidden = !video;
    if (!video) return;
    const save = h("button", { type: "button", class: "quiet", text: "Download video" });
    save.onclick = async () => {
      const blob = await (await fetch(video.data)).blob();
      download(`${fileStem(l!.name)}.${blob.type.includes("webm") ? "webm" : "mp4"}`, blob);
    };
    const still = h("button", { type: "button", class: "quiet", text: "Current frame → image" });
    still.onclick = async () => {
      const el = document.querySelector<HTMLVideoElement>(`.item[data-id="${l!.id}"] video`);
      const v = el ?? (await loadVideo(videoURL(video.id, video.data)));
      if (!el) await seek(v, 0);
      const a = canvasAsset(drawFrame(v));
      const layer: Layer = Object.assign(newLayer("image", l!.x + l!.width + 32, l!.y), {
        assetId: a.id,
        width: l!.width,
        height: l!.height,
        name: `${l!.name.slice(0, 180)} · frame`,
      });
      ctx.commit(() => {
        project.assets[a.id] = a;
        project.layers.push(layer);
      });
      ctx.select([layer.id]);
    };
    const meta = video.metadata;
    selectedVideo.replaceChildren(
      h("div", { class: "card-heading" }, h("span", { class: "eyebrow", text: "SELECTED VIDEO" }), h("span", { class: "card-tag", text: `${video.width} × ${video.height} · ${video.duration.toFixed(1)} s` })),
      h("p", { class: "subtle", text: meta ? `${meta.demo ? "DEMO · " : ""}${meta.prompt}` : "Imported video" }),
      h("div", { class: "selection-actions" }, save, still),
      h("p", { class: "subtle", text: "To turn it into a sprite: pick the frame count below, then From selected video." }),
    );
  }

  function sync() {
    const caps = ctx.capabilities();
    const engine = ctx.service();
    const l = ctx.current();
    fromSelection.disabled = !l?.assetId;
    if (!l?.assetId) fromSelection.checked = false;
    videoGenerate.disabled = !engine || !caps.includes("video") || ctx.busy();
    videoStatus.textContent = !engine
      ? "Connect your engine to generate video."
      : !caps.includes("video")
        ? "This engine has no video model. Turn on ENABLE_VIDEO in the Colab notebook (needs a large GPU), then reconnect."
        : ctx.busy() && videoView.panel.hidden
          ? "Your engine is busy with another job."
          : "Video uses the LTX-2.5 model. The first video after images loads it (the image model is unloaded to make room), so it takes longer.";
    videoImprove.sync();
    videoImprove.element.hidden = !!engine && !caps.includes("enhance-prompt");
    generateFrames.disabled = !engine || !caps.includes("reference") || ctx.busy();
    fromVideo.disabled = !(l?.kind === "video");
    fromLayers.disabled = !ctx.selectedLayers().some((x) => x.assetId);
    renderSelectedVideo();
  }

  return {
    sync,
    placeVideo,
    /** Rebuild the sprite list; deferred while the Animate tab is hidden (showTab forces it). */
    render(force = false) {
      if (panel.hidden && !force) {
        listDirty = true;
        return sync();
      }
      listDirty = false;
      renderList();
      sync();
    },
  };
}

/** Fit an image into width × height, cropping to cover (start frames, references). */
async function coverFrame(asset: Asset, width: number, height: number, contain = false) {
  const img = await loadAssetImage(asset);
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const g = c.getContext("2d")!;
  g.imageSmoothingQuality = "high";
  const scale = (contain ? Math.min : Math.max)(width / img.naturalWidth, height / img.naturalHeight);
  const w = img.naturalWidth * scale,
    hh = img.naturalHeight * scale;
  g.drawImage(img, (width - w) / 2, (height - hh) / 2, w, hh);
  let data = c.toDataURL("image/png");
  if ((data.length - data.indexOf(",")) * 0.75 > 8 * 1024 * 1024) data = c.toDataURL("image/jpeg", 0.92);
  return data;
}
