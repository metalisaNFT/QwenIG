# Studio Zero architecture

## Ownership boundaries

The browser owns the creative project. The service owns GPU jobs. The engine adapter owns model-specific options. Neither the project nor the artist-facing canvas knows how a runner is invoked.

```text
Canvas / Layers / Create / History
             │
     Project (TypeScript)
       │             │
 IndexedDB/.zero   StudioService (HTTP + bearer key)
                         │
              FastAPI job API / one-worker queue
                         │
              EngineSet (one model in GPU memory at a time by default)
                 ├─ image: ResidentQwenRunner → private sd-server (img_gen: generate, edit, inpaint, RGBA)
                 │         QwenRunner → sd-cli per image (fallback) · DemoRunner (explicit test mode)
                 └─ video: ResidentVideoRunner → second private sd-server (vid_gen, LTX-2.5) → ffmpeg → MP4/WebM
                           DemoVideoRunner (explicit test mode)
```

The web app is plain TypeScript + Vite, with no runtime UI or canvas dependency. Positioned HTML layers share one CSS-transformed world, so images retain browser rendering quality and note content remains accessible. A dedicated canvas library can replace that renderer without changing the project format or service contract.

## Source map

| Module                      | Responsibility                                                                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/model.ts`              | Versioned project schema, strict import validation, bounds, settings, group inheritance, undo history                                                             |
| `src/main.ts`               | UI binding, canvas pointer state machine, selection, rendering, generation orchestration                                                                          |
| `src/storage.ts`            | Serialized IndexedDB writes, downloads and binary/data conversion                                                                                                 |
| `src/export.ts`             | PNG compositing using project coordinates                                                                                                                         |
| `src/service.ts`            | Typed HTTP boundary; no runner-specific arguments                                                                                                                 |
| `src/image-editor.ts`       | Image workshop session, preview, pointer tools, undo/redo and apply/cancel                                                                                        |
| `src/image-editing.ts`      | Pixel-space crop, rotate, flip, resize, adjustments, soft strokes, feathered selection coverage and raster text                                                   |
| `src/geometry.ts`           | Rotated bounds and proportional resizing anchored to the opposite corner                                                                                          |
| `src/masking.ts`            | Separate alpha masks, live feather/density refinement (cached blob URLs for the canvas), compositing, geometry synchronization during pixel edits                 |
| `src/background.ts`        | Engine upload preparation (≤ 2048 px, ≤ 8 MB), matte → mask conversion and mask inversion |
| `backend/matting.py`       | Background removal: `BiRefNetMatter` (ONNX Runtime, CUDA with CPU fallback) and the labelled `DemoMatter` |
| `src/adjustments.ts`        | Nondestructive per-layer colour adjustments: one affine/Levels definition rendered as an SVG filter (canvas and export) plus a reference implementation for tests |
| `src/typography.ts`         | Shared text wrapping and transparent rendering for canvas and export                                                                                              |
| `src/resolution.ts`         | Generation framing aligned to the engine's 32-pixel constraint                                                                                                    |
| `src/tools.ts`              | Explicit future edit-tool contract and TODOs                                                                                                                      |
| `backend/schema.py`         | Request validation and reserved edit contract                                                                                                                     |
| `backend/app.py`            | Authentication, CORS, job lifecycle, disk metadata, output delivery                                                                                               |
| `backend/runner.py`         | Replaceable runner protocol, subprocess lifecycle, actual CLI translation                                                                                         |
| `backend/model_cache.py`   | Persistent weight store (Drive on Colab): download once, pinned revisions, size-checked reuse, background save |
| `backend/engines.py`        | Image/video engine selection and swapping on one GPU (`ZERO_ENGINE_SWAP`) |
| `src/ai-edit.ts`            | AI edit geometry (frames, outpaint plans and rotation-aware placement) and engine source/mask preparation |
| `src/layer-ai.ts`           | Layers-panel AI edit and pixel-art cards, pixel-art dialog, baking a layer's visible look |
| `src/pixel-art.ts`          | Contrast-aware downscale, off-grid block detection/snap, OKLab k-means palettes, dithering, outline |
| `src/sprites.ts`            | Alpha bounds, union crop, sheet packing, Aseprite-style JSON |
| `src/video.ts`              | Video blob URLs, metadata, frame sampling/extraction |
| `src/animate.ts`            | Animate tab: video generation, video layers, sprite maker (layers / video / AI poses), clean-up and export |
| `src/audio.ts`              | Audio tab: voice (with cloning), music, transcription, the project's clips |
| `src/audio-util.ts`         | Pure helpers for clips (sizes, durations, file types) |
| `src/assist.ts`             | Shared “✦ Improve” button, task polling and image description |
| `backend/audio.py`          | `Transcriber` (faster-whisper, CUDA 12 preload with CPU fallback), `Speaker` (Chatterbox Turbo, sentence chunking), `MusicRunner` (MiniMax Music 3, resident), demo twins, WAV/MP3 helpers |
| `backend/assistant.py`      | `PromptHelper`: Qwen3-VL-2B prompt rewriting and image description; optional DeepSeek API for rewriting |
| `backend/diffusers_runner.py` | Fast image engine: UC GGUF dequantized into diffusers' Qwen-Image 2.1 pipeline with the Fun-Acc 4-step adapter; masked edits by latent blending |
| `backend/vision.py`         | `Upscaler` (spandrel Real-ESRGAN, tiled with blended seams, alpha kept), `PoseDetector` (rtmlib DWPose + YOLOX, people only, OpenPose-18), OpenPose drawing, demo twins |
| `src/pose.ts`               | OpenPose-18 data: presets, mirror, fit, hit-testing, drawing, the pose instruction |
| `src/pose-editor.ts`        | Pose editor dialog (drag joints, presets, detect from image) and the skeleton PNG sent to the engine |
| `src/pose-panel.ts`         | Create → Pose: the project's saved pose and its reference for generation |
| `src/studio-context.ts`     | The narrow interface feature panels use (state access, commit, one engine job at a time) |
| `scripts/build_notebook.py` | Self-contained notebook generated from backend sources                                                                                                            |

## Canvas and layer state

`Project` has `format: "studio-zero"`, `version: 2`, an ID, title, flat back-to-front layer array, groups, an asset map, gallery, generation form settings and `{x, y, zoom, grid}` view state. Version 2 is the first portable public format; the early prototype's local-storage data is migrated once on first load if IndexedDB is empty. Import rejects unknown versions rather than silently discarding them.

World coordinates are independent of zoom. A pointer maps to `(screen - viewportOrigin - pan) / zoom`. Zoom is anchored under the pointer; Fit computes visible bounds. A gesture captures the original geometry once and records one undo snapshot when movement begins. Locked layers stay fixed. Shift-click and marquee affect a set of selected IDs; selection and the active tool are ephemeral UI state.

Every layer has an ID, kind (`image`, `text`, `note`, `prompt`, reserved `mask`), name, x/y, width/height, visibility, lock and optional group membership. Images reference an asset ID; notes/prompts contain plain text. A generation layer is a prompt idea card; completed jobs create ordinary image layers with immutable generation metadata. A mask reserves its target layer ID and pressure-independent strokes (`points`, `radius`, `erase`) for a future brush, and is preserved on save/open even though drawing is not enabled.

Optional layer rotation and flip fields default to zero/false for older files. Text layers retain their content and validated font, size, color, weight, alignment and leading. Canvas and export share text rendering and transform geometry; alignment and Fit use rotated bounds. Resizing keeps the rotated opposite corner fixed.

Groups are deliberately minimal: names, visibility, lock and membership. Visibility and locking inherit from the group. Group selection selects its members. Coordinates and stacking remain global; groups do not alter transforms or impose contiguous stacking. Nested groups can be introduced through a versioned migration later.

## Assets, metadata and persistence

Paint layers are ordinary image assets, created locally from a transparent or solid-color canvas. The workshop records bucket, gradient and shape operations alongside strokes so Undo/Redo replays a deterministic session. `src/paint.ts` supplies a bounded iterative flood fill with seed-relative color tolerance and selection barriers. All new paint effects share selection coverage and opacity compositing. Saving a study copies the source layer's properties and mask, creates new pixel/mask assets, and adds one project history entry; the source is unchanged. The project schema accepts the sixteen standard Canvas/CSS blend modes used by both the isolated layer renderer and PNG export. Workshop preview dimensions use one scale factor, avoiding object-fit letterboxing in pointer coordinates.

Optional `Layer.pixelated` draws an image without smoothing (canvas `image-rendering: pixelated`, export `imageSmoothingEnabled = false`). `video` layers reference `Project.videos[id]` (`{data: data:video/mp4|webm, width, height, duration, fps, metadata}`) and render as muted looping `<video>` elements from blob URLs; export draws the first frame. `Project.sprites` holds `{id, name, fps, loop, pixelated?, frames: [{assetId, duration?}]}`; frames are ordinary assets. All three are optional on import and strictly validated, so the format stays version 2 and older files load unchanged. AI edit results are ordinary image layers (with a layer mask for inpaint/outpaint) plus a gallery entry; the area marked for an inpaint is ephemeral UI state.

Optional `Layer.layerMask` stores an immutable alpha-mask asset ID and an enabled flag for image layers. CSS alpha masking and PNG compositing apply the same mask before layer flips and rotation. Hide/reveal operations edit a temporary mask surface, never the source pixels; applying creates a new mask asset and one project undo entry. Pixel crop/rotate/flip/resize operations are replayed on the mask to preserve registration. Restoring original pixels clears the current mask, with both changes captured by undo. This is separate from the reserved AI `mask` layer kind.

`layerMask.feather` (0–250 mask pixels) and `layerMask.density` (0–1) are optional live refinements; absent means 0 and 1, so older files are unchanged. `effectiveMask()` feathers with an edge-replicated Gaussian (sigma = feather / 2) and then lifts hidden alpha to at least `1 − density`. Export computes it directly; the DOM canvas uses a cached PNG blob URL of the same surface as `mask-image`, computed asynchronously (one job per mask asset, newest settings win) while the previous refinement stays visible.

Optional `Layer.adjustments` (image layers only) stores `{enabled, brightness, contrast, saturation, hue, warmth, tint, black, white, gamma}` with strict ranges on import. Levels become two `feComponentTransfer` primitives; the other settings compose into one `feColorMatrix` (brightness → contrast → saturation → hue → warmth/tint). The generated SVG filter lives in a hidden document `<svg>`, is keyed by its content and reused. The canvas applies it as CSS `filter` on the image element and export as `ctx.filter`; both then apply the refined mask, then opacity and blending. `adjustRGB()` is the numeric reference used by browser checks.

In the workshop, `Rect.feather` produces a soft selection coverage surface (`selectionAlpha`, cached) used for fill/clear, strokes and adjustments; feather 0 keeps the previous hard clip path exactly. Stroke `hardness` < 1 draws a hard core of `size × (1 + h) / 2` blurred with sigma `size × (1 − h) / 8`, so the falloff ends at the brush radius; hardness 1 or absent is the original stroke. Crop ignores feather, so mask replay during crops is unchanged.

Optional `Layer.originalAssetId` retains the source when local edits produce a new asset. `Project.references` holds up to three ordered asset IDs; older version-2 files default to an empty list. Both survive serialization and undo. Reference copies are sent inline as validated data URLs to `/generate` only when the engine advertises `reference`. Metadata stores the reference count, never image payloads. The resident runner forwards them as `ref_images` with automatic reference cropping disabled and loads the optional `ZERO_VISION_ENCODER` at startup.

The image workshop keeps a temporary pixel-operation history. Applying creates a new asset and one project undo entry; cancellation changes nothing. Native-resolution exports calculate a common scale from visible source images, preserving composition geometry. No AI engine is involved in local edits.

An asset stores `{id, data, width, height}`. `data` is an embedded PNG, JPEG or WebP data URL. Canvas copies and history share asset IDs. `.zero` is a self-contained JSON document, not a directory of fragile remote URLs. Inbound data is reconstructed field-by-field, checks references/duplicate IDs/numeric limits and rejects external image URLs or unsupported MIME types. User text is assigned with `textContent`, never injected as HTML.

Generation metadata includes prompt, negative prompt, requested dimensions, steps, guidance, the **resolved numeric seed**, model ID, runner/revision, job ID, timestamp and explicit demo flag. The server returns it with the job and embeds it in its PNG. Canvas export is a new composition and does not copy per-layer metadata into the PNG; use `.zero` to keep all layers' metadata.

IndexedDB autosaves only the current project, debounced then serialized to avoid stale writes winning a race. The UI reports quota/write failures and still allows portable downloads. Undo stores 40 project snapshots; image strings are immutable. Import/new starts a fresh undo stack. Secrets and engine addresses are never part of the project. Server output JSON records survive service restarts; interrupted nonterminal jobs are marked failed when recovered.

## API version 1

All endpoints require `Authorization: Bearer <session key>`. POST requests authenticate before buffering. `/generate` accepts up to 36 MiB for reference payloads; other JSON bodies are capped at 128 KiB. Each of at most three references must decode as PNG/JPEG/WebP, at most 8 MiB, 4096 pixels per side and 16 megapixels. Prompts are capped at 20,000 characters. Dimensions must be multiples of 32 from 256 to 2048, steps 1–100, guidance 0–20, seed -1 or 0–2147483647. The API resolves -1 before enqueueing. At most four nonterminal jobs are admitted; one GPU worker executes them serially. Use one ASGI process.

| Route                    | Response / semantics                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`            | `{ready, mode, message, capabilities, api_version}`. Checks runner/weight paths, not a full inference probe.                    |
| `POST /generate`         | Validated settings → HTTP 202 with job object. Not-ready engine → 503; full queue → 429.                                        |
| `GET /jobs/{id}`         | Job status, progress, message, metadata, optional output ID.                                                                    |
| `POST /jobs/{id}/cancel` | Idempotent cancellation. Running subprocess is terminated and reaped; queued jobs are skipped. Completed jobs remain completed. |
| `GET /outputs/{id}`      | Authenticated `image/png`; 409 if not succeeded, 404 if missing. No token query strings.                                        |
| `POST /remove-background` | `{image}` data URL (same limits as references) → HTTP 202 task. No matter → 501; loading → 503; four open tasks → 429. |
| `GET /tasks/{id}`        | Task status and message. Tasks are in memory only, not in `/jobs` history; the last 20 are kept.                   |
| `GET /tasks/{id}/mask`   | Authenticated grayscale `image/png`, same size as the upload (white = subject); 409 until succeeded.              |
| `POST /tasks/{id}/cancel` | Cancels a queued or running task; a running inference finishes and is discarded.                                  |
| `POST /edit`             | `{operation, image, mask?, strength?, …generation settings}` → 202 job (kind `edit`). Image and mask must be exactly width × height. Mask: white = regenerate. 422 for an operation the engine does not advertise. |
| `POST /speech`           | `{text ≤ 5000, voice? (audio data URL, > 5 s), temperature, seed}` → 202 job (kind `speech`). Long text is spoken in sentence chunks and joined. |
| `POST /music`            | `{style, lyrics, duration 10–300, instrumental, seed}` → 202 job (kind `music`); lyrics or instrumental required. |
| `POST /transcribe`       | `{audio (audio or video data URL ≤ 32 MB), language?}` → 202 task; result `{text, language, duration, segments, srt}`. |
| `POST /describe`         | `{image, purpose: image | video | caption}` → 202 task; result `{prompt, model}`. |
| `POST /upscale`          | `{image, scale: 2 | 4}` → 202 job (kind `upscale`); 422 if the result would exceed 8192 px per side or 48 MP. Metadata: `scale`, `source_width/height`, `width/height` of the result. |
| `POST /detect-pose`      | `{image}` → 202 task; result `{width, height, people: [[x, y, confidence] × 18], model, device}` (OpenPose-18, most visible person first). |
| `POST /enhance-prompt`   | `{prompt, target: image | edit | video | music}` → 202 task; result `{prompt, model}`. |
| `POST /video`            | `{prompt, width, height (÷32), frames (8n+1), fps, steps, guidance, seed, image?, end_image?}` → 202 job (kind `video`); 501 without a video model. `/outputs/{id}` then serves `video/mp4` (or `video/webm`). |

Generation request:

```json
{
  "prompt": "A greenhouse at dusk",
  "negative_prompt": "",
  "width": 1024,
  "height": 1024,
  "steps": 28,
  "guidance": 6,
  "seed": -1
}
```

Jobs transition `queued → running → succeeded | failed | cancelled`; queued cancellation is also allowed. `progress: null` means indeterminate. The CLI adapter does not manufacture a percentage from elapsed time. The frontend polls once per second, retries transient polling failures up to five times, fetches the authenticated output as a blob, embeds it as an asset, and adds a selected image layer at the current view center. Results are tied to the originating project; new/open is blocked while a job is in flight.

Capabilities: `text-to-image`; `reference` (vision encoder); `transparent` (RGBA via the documented prompt phrasing); `inpaint`, `outpaint`, `image-to-image`, `variations` (init image + mask + strength, with the source also as reference 1 when the vision encoder is loaded); `edit` (instruction edit via reference conditioning, needs the vision encoder); `video` (video weights and ffmpeg present); `remove-background`; `describe` and `enhance-prompt` (assistant model; `enhance-prompt` alone with only a DeepSeek key); `transcribe`; `speech`; `music`; `upscale`; `detect-pose`. The demo engine offers `reference` only with `ZERO_DEMO_REFERENCES=1`, and then stamps every reference visibly into its artwork (a text-only demo rejects references rather than ignoring them). Speech and music jobs write WAV and are delivered as MP3 (`ZERO_AUDIO_FORMAT=wav` to keep WAV) through `/outputs/{id}`; text tasks put their result on the task object. Edit jobs share the image job lifecycle, metadata (`kind`, `operation`, `strength`) and PNG embedding. Video jobs request AVI from the engine (MJPEG + PCM audio, the format that carries LTX audio) and the service converts it with ffmpeg to H.264/AAC MP4 (or VP9/Opus WebM).

**Engine swapping:** resident engines serve images, video or music. An engine that declares its size (`vram_gib`, music: 24) is loaded beside the others when that much GPU memory is free; otherwise the others are unloaded first. Small helpers (assistant, transcription, voice) load on first use and stay loaded on GPUs of 40 GB or more (`ZERO_HELPERS_RESIDENT`). A resident sd-server serves either images or video. `EngineSet.acquire(kind)` runs inside the single worker thread: with swapping on (default) it stops the other resident engine, starts the needed one and reports “Loading the … model” as job progress until it is ready. `/health` reports the image engine's readiness; an engine that is merely unloaded reports ready (“loads when it is first needed”) so jobs are accepted and swap in. `/health` also reports `offload` (whether weights were placed in system RAM) and, with video, `video_engine`, `video_model` and `engine_swap`.

**Offload:** `ZERO_OFFLOAD=auto` compares the weight file sizes plus `ZERO_VRAM_HEADROOM_GIB` (6) with the first GPU's memory (`nvidia-smi`), and passes `--offload-to-cpu` only when they would not fit; unknown GPUs keep offloading. Requests above ~2.4 MP ask the engine for tiled VAE decoding.

Background removal runs on the same single worker as generation, so it never competes with an image job for GPU memory, and waits behind one if needed. `/health` adds `remove-background` to `capabilities` when a matter is configured, plus `matting` (loading/ready/failed), `matting_device` and `matting_mode`. `BiRefNetMatter` loads its ONNX session once in the background at start-up, resizes to 1024 × 1024 with ImageNet normalisation, applies a sigmoid to the logits and resizes the matte back to the upload size; a failed CUDA run retries once on the CPU. The browser scales the matte to the image asset's full size and stores it as an ordinary `layerMask` asset (white RGB, coverage in alpha) in one undoable commit, only if the layer still shows the pixels that were sent.

## Runner and deployment

`Runner.readiness()` and `Runner.generate(request, output, cancellationEvent, progressCallback)` isolate compute implementation. QwenRunner uses a list of explicit subprocess arguments without `shell=True`; HTTP callers cannot choose model paths, output paths or executable flags. The adapter applies the documented Qwen 2.1 text encoder, VAE, Euler sampling and CPU offload flags. It validates decoded PNG dimensions and records generation metadata. Cancellation and timeout terminate and reap the child process. Private stderr/stdout logs stay on the engine.

The default ResidentQwenRunner starts the pinned `sd-server` once as a child process on `127.0.0.1` (no web frontend, never tunneled) and loads the weights a single time. Loading starts in the background from the application lifespan, so the API answers immediately; `readiness()` reports loading until the engine's native API responds, and `state()` exposes `engine` and `loaded_in_seconds` through `/health`. Each job is submitted to the engine's native async job API and the PNG is decoded, validated and stamped with Studio Zero metadata exactly as before. A crashed engine is reported through `/health` and restarted lazily (at most once a minute); the lifespan stops it on shutdown. Queued engine jobs are cancelled on the engine; the image already on the GPU finishes and is discarded because the engine cannot interrupt it. QwenRunner (`ZERO_RUNNER=qwen-cli`) remains available and cold-loads weights per image. Runners may optionally implement `start()`, `stop()` and `state()`; replacing the runner does not change the UI or endpoints.

The Colab notebook embeds current backend sources, restores the CUDA runner and weights from the Google Drive cache (building and downloading only in the first session, at pinned revisions), starts the loopback API and executes a real smoke test. Only then does it offer an authenticated HTTPS tunnel. Cloudflare is the transport provider and terminates TLS; the service is access-controlled but not end-to-end encrypted through that provider. A local PC or cloud GPU can use the same backend with different environment paths and transport.

## Future edits

Local soft brush/eraser, feathered rectangle/ellipse/freehand lasso selections, nondestructive per-layer adjustments, live mask feather/density, selection inversion/fill/clear, selected pixel adjustments, editable alpha masks, editable text, arbitrary layer rotation/flips, reference-guided inference and opacity/blending are implemented. AI inpainting/outpainting, instruction edits, RGBA generation, pixel art, sprites and video are implemented. Nested groups, stacked adjustment layers (affecting everything below), curves and batch scheduling remain future work. Keep engine arguments out of the artist-facing UI.
