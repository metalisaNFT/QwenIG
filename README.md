# Studio Zero

A personal, canvas-first image studio. A quiet green-black workspace for images, references, notes and ideas, with a private, replaceable image engine. No third-party creative interface or node graph.

## Start the studio

Requires Node.js 22.18+ (24 recommended) and Python 3.11+ for the service.

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5173**. Keep that terminal running. Use a local server; opening `index.html` directly is no longer supported. For a production build, run `npm run build`, then `npm run preview` (port 4173).

The studio uses a fixed port because the API allows exact browser origins. If startup reports that port 5173 is already in use, open the existing studio at **http://127.0.0.1:5173**, or stop the earlier studio terminal and start it again. Preview likewise stays on port 4173.

If connecting reports **Failed to fetch** or **Could not reach the engine**, check the browser's address as well as the API/tunnel. In particular, `http://127.0.0.1:5174` is not allowed by the default API or Colab notebook. Open the studio on port 5173 to use the running API without a restart. To intentionally use a different frontend address, add its exact origin (scheme, host, and port) to `ZERO_ALLOWED_ORIGINS` in the API startup environment (cell 4 for Colab), then restart the API. Also confirm that Colab and the tunnel are still running and that the service address is the current tunnel URL.

## Try the complete flow without a GPU

This uses a real HTTP job service with a **clearly labeled procedural demo**, not an AI model. It tests the same request, polling, download and metadata paths used by Qwen.

Windows PowerShell, in a second terminal:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend/requirements.txt
.\.venv\Scripts\python.exe scripts/run_demo.py
```

macOS / Linux:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.txt
.venv/bin/python scripts/run_demo.py
```

1. Click the engine pill in the top bar (**Your private engine**).
2. Enter `http://127.0.0.1:8000` and the random access key printed by the demo service. Connect.
3. Write an idea, choose framing, and **Generate image**. The result appears as an image layer.
4. Drag the image; use its bottom-right handle to scale. Add a note with **T**, then click the canvas. Double-click a note to edit its text in **Edit**.
5. Import reference images with the image tool or drop PNG/JPEG/WebP files onto the canvas.
6. **Save .zero** downloads the project with embedded images. **Open** restores it. **Export PNG** downloads the composition; **Edit → Export PNG** exports the selection.

**Layout:** tools on the far left, the **Layers** list beside them (☰ Layers hides it; on narrow screens it floats over the canvas), the canvas in the middle, and the panels on the right: **Create** (the idea, then folded *Size*, *Guide with pictures* and *Fine-tune* sections, with **Generate image** pinned at the bottom), **Edit** (the selected layer: AI edit, upscale, pixels, adjustments, mask, pixel art, then *Position, size & look*), **Animate**, **Audio** and **History**. Double-click a layer in the list to open it in Edit. Wherever this guide says **Edit → …** for a layer action, that is now the **Edit** tab.

The service key and address are kept in memory. Refreshing the page requires reconnecting. Never put the key in a project, URL query string, or source file.

## Resolution, references, and image editing

### Paint, compose, explore

**＋ New paint layer** (toolbar, or **Ctrl/⌘ + Shift + N**) starts a transparent overlay, white paper, or dark surface with your chosen dimensions. It defaults to the selected image's resolution and placement, or your generation size. You can also choose **Start painting** on an empty canvas, or press **B** with nothing selected. No engine connection is needed.

The image workshop now includes these Photoshop-style essentials:

- **Eyedropper · I:** sample the current image pixels; **Alt-click** samples while painting. **X** swaps foreground/background and **D** resets them to black/white. Live layer adjustments are previewed but are not part of the sampled pixel color.
- **Paint bucket · K:** fill connected colors with adjustable tolerance and opacity. Turn off **Contiguous pixels only** to fill all matching colors. Transparent pixels and selection boundaries are respected.
- **Gradient · G:** drag a linear or radial gradient between foreground/background colors, or fade to transparency. **Shift** constrains direction to 45° steps.
- **Shapes · U:** drag filled or outlined rectangles and ellipses, or lines with adjustable stroke width. **Shift** makes squares/circles or constrains lines. Shapes are raster marks, editable through Undo/Redo.
- **M / L / C:** selection, lasso, and crop selection in the workshop. Gradients, shapes and fills honor hard, inverted and feathered selections; **Delete** clears selected pixels.
- **Keep as new layer:** keep the source layer and add your edited study above it. Toggle layer visibility to compare, or blend it into the original. **Apply to layer** updates the selected layer while preserving its original asset.
- **16 layer blend modes:** Normal, Multiply, Screen, Overlay, Darken, Lighten, Color dodge/burn, Hard/Soft light, Difference, Exclusion, Hue, Saturation, Color and Luminosity. They work with opacity, masks, project saves and PNG export.

One personal workflow: generate or import an image → add a transparent paint layer → draw a color wash or graphic shapes → apply it → experiment with Soft light or Color in **Layers** → use **Use selected layer** in **Create** to develop a painted study with your engine. Pixel editing remains local; references are sent only when you generate.

### Images and resolution

**Create → Generation resolution** offers 1K, 1.5K and 2K long-edge sizes. Custom dimensions remain under Fine-tune. Larger requests need more GPU memory and time. New images enter the canvas at their native pixel dimensions; the view zooms to fit. **Edit → View at 100%** shows image pixels at screen size. **Export PNG → Full image resolution** also recovers native pixels from older projects whose layers were placed at 520–560 pixels. Canvas size remains available for exports that must match layout dimensions.

**Create → Reference images → Add images** accepts up to three PNG/JPEG/WebP images. **Use selected layer** attaches an existing image. Refer to “image 1”, “image 2”, and “image 3” in the prompt. References are saved inside the project and sent only when generating; upload copies are reduced to at most 2048 pixels on the long edge. Removing a reference detaches it without deleting a canvas layer.

**Double-click an image**, or choose **Edit → Edit image pixels**, to crop a rectangle, ellipse or freehand lasso selection, rotate 90°, flip, resize pixels, adjust brightness/contrast/saturation, paint, erase to transparency, or place raster text. Selections can be inverted, filled, or cleared, and also limit adjustments, brush and eraser strokes. **Feather** (0–150 px) softens any selection's edge; the soft coverage is previewed by dimming unselected areas, and feathered fills, clears, adjustments and strokes blend into the surrounding pixels. Selections that touch the image border stay solid there. Crop always uses the hard outline. **Hardness** (0–100%) gives brushes and erasers a soft falloff within the same brush size; a ring cursor shows the size and the solid core. Shortcuts: M / B / E / T tools, X swaps foreground/background (Reveal/Hide in masks), [ ] size, Shift + [ ] hardness, Ctrl/⌘ + A / D / Shift + I select all, deselect, invert. Use Fit/100%/200%, Undo/Redo, then **Apply to layer**. Cancel leaves the layer untouched. Editing is capped at 16 megapixels. Resizing interpolates pixels; it is not AI upscaling.

Editing creates a new image asset. **Restore original** resets the layer and **Save original** downloads its untouched source. Project Undo/Redo also covers applied edits. Workshop text becomes pixels.

**Press T and click the canvas** to add an editable text layer. Double-click it to edit its words in Layers, with font, size, color, bold/italic, alignment and line spacing controls. Text stays editable in portable project saves and exports on transparency. The Layers panel also rotates layers to any angle, flips them, or resets their transform without changing image pixels. Rotated bounds are used for Fit, alignment and PNG export.

**Layers** shows three clearly separated cards for a selected image: **Pixels** (edits that create a new image version while the original is kept), **Adjustments** (live, revisitable) and **Layer mask** (hides without touching pixels). The editor itself carries a coloured banner saying whether you are editing image pixels or the mask.

**Adjustments (nondestructive):** open **Edit → Adjustments** for brightness, contrast, saturation, hue, warmth, tint and Levels (black point, midtones, white point). They change how the layer looks without changing its pixels, and appear on the canvas, the layer thumbnail, saves, autosave and PNG export. Double-click a slider to reset it, **Hide adjustments** compares before/after, **Reset all** removes them; every change is one project Undo step. They apply in this order: Levels, brightness, contrast, saturation, hue, then warmth/tint (so warmth can tint a desaturated image). The image workshop's own _Adjust pixels_ section still bakes selection-limited changes into a new version. Reference images and **Save original** use the unadjusted pixels.

**Layer masks:** select one image, open **Layers**, and choose **Add layer mask**. Use Hide and Reveal brushes, or select an area and choose Hide selection / Reveal selection. Freehand lasso closes your outline when you release the pointer. Invert selects the area outside it. Apply mask preserves the original pixels; Disable mask shows the full image, and Remove mask can be undone. Masks follow image crops, rotations and resizing, and are included in project saves and PNG exports. Restore original resets pixel edits and removes the current mask; project Undo restores both. Mask brushes default to 60% hardness, and Hide/Reveal selection honour feather. The mask editor has three views: **Result** (the layer as it will look, with live adjustments), **Mask** (white visible, black hidden, grey partial) and **Overlay** (hidden areas tinted red over the full image). The layer list shows a mask thumbnail beside the image thumbnail (struck through when disabled); click it to edit the mask. The mask card adds live **Feather** (0–150 px, in image pixels) and **Density** (0–100%; lower lets hidden areas show through). These refinements never rewrite the stored mask, can be changed or reset at any time, and are applied identically on the canvas and in PNG export. Local masks do not require an engine connection.

**Remove background (AI, on your engine):** select one image and choose **Edit → Layer mask → ✦ Remove background** (also in the right-click menu). The connected engine runs [BiRefNet](https://huggingface.co/onnx-community/BiRefNet-ONNX) (MIT) and returns a soft subject matte, which becomes the layer's mask: the background is hidden, not erased. Refine it with **Edit mask** (soft Hide/Reveal brushes), **Feather**, or **Invert mask** to keep the background instead. It replaces an existing mask (keeping its feather); one Undo restores the previous mask. Click the button again while it runs to cancel. The studio sends a copy of the image's current pixels (at most 2048 px on the long edge, JPEG unless transparency must be kept); the mask is scaled back to the image's full resolution. It needs an engine connection and the updated notebook; the demo service offers a clearly labelled border-colour key for testing, not AI.

**Existing Colab sessions:** local editing and resolution/export improvements work immediately. Reference-guided generation needs the updated [notebook](colab/Studio_Zero_Colab.ipynb): `ENABLE_REFERENCES = True` downloads the vision encoder and adds a reference-edit GPU smoke test. Upload the updated notebook, run it, and reconnect using its new key and tunnel address. Cached weights and engine builds can be reused. Old APIs are identified as text-only; the UI refuses to silently ignore attached references.

The integration follows the pinned engine's [Qwen editing instructions](https://github.com/leejet/stable-diffusion.cpp/blob/2bb72947cb129962f350452148658a32f4d3c057/docs/qwen_image_2.1.md) and [native API](https://github.com/leejet/stable-diffusion.cpp/blob/2bb72947cb129962f350452148658a32f4d3c057/examples/server/api.md). Local API/adapter tests and browser pixel checks cover the implementation; real GPU reference quality must be verified by the notebook smoke test.

## AI edits, transparency, pixel art, animations, GIFs and video

**Transparent background:** tick **Create → Transparent background** for an RGBA PNG (sprites, stickers, cut-outs). Qwen-Image 2.1 produces real alpha from its documented RGBA prompt phrasing, which the engine adds for you. The AI edit card and sprite poses offer the same option.

**AI edit (Edit → AI edit):** select one image and pick a mode. Every result is a **new layer above the source**; the source is never overwritten, and one Undo removes the edit.
- **Change with words** — an instruction for the whole image (“make the jacket red”, “move the cup to the left”). Uses the vision encoder (`ENABLE_REFERENCES`).
- **Repaint an area** — **Mark area ↗** opens the mask editor in marking mode (Mark / Unmark brushes and selections; marked areas show red), then describe what belongs there. The result layer is masked to the marked area with a soft edge, so everything outside stays pixel-identical.
- **Extend the canvas** — choose sides and how far (+25/50/100%). The result is placed so its original part lines up exactly with the source (rotated and flipped layers included) and is masked to the new margin plus a thin blend band.
- **Re-imagine** / **Variations** — image-to-image with a strength slider (Variations reuses the source's prompt when you leave it empty).
Edits run at 1K/1.5K/2K on the long edge (multiples of 32) and appear in History like generations, with operation and strength in their metadata.

**Pixel art (Edit → Pixel art, no engine needed):** **Make pixel art ↗** shows before/after and creates real low-resolution pixels. *Downscale* is contrast-aware: flat areas average, while cells with an edge keep their minority extreme so thin outlines and small highlights survive. *Snap AI pixel art* detects the block size of “pixel art” that a model drew off-grid and takes the most common colour per block. Palettes (4–64 colours) are k-means in OKLab using real image colours, with optional ordered dithering and a 1-pixel outline. **Apply** keeps the original (Restore original brings it back); **Keep as new layer** leaves the source untouched. The layer's mask and adjustments are baked in. **Crisp pixels** draws any image layer without smoothing on the canvas and in PNG export.

**Animate tab — video:** describe a shot, choose size (768 × 512 is fastest), speed (24 fps, or 12 fps for sprites) and length (1–8 s, frame counts follow the model's 8n + 1 rule), optionally **Start from the selected image**, and **Generate video**. The engine runs LTX-2.5 (with sound) and returns an MP4 (or WebM with `ZERO_VIDEO_FORMAT=webm`). The video becomes a looping, muted video layer (double-click a selected video to pause); **Download video** and **Current frame → image** are in the Animate tab. Videos are embedded in `.zero` projects; deleting a video's last layer drops it (Undo restores it). PNG export draws a video's first frame. If a browser cannot decode the file, the video is still saved and can be downloaded.

**Animate tab — animations & sprites:** build an animation from
- **selected layers** (left to right becomes frame order),
- **a selected video** (6–24 evenly spaced frames at 128–512 px), or
- **Generate frames with AI** — select a character image, write one pose per line; each pose is generated with the character as reference image 1 (transparent when the engine supports it).

Each animation appears as a card with a live preview, **Edit frames ↗**, **GIF ↓** (quick export) and **Delete**. New animations open straight in the frame editor.

**Frame editor (Edit frames ↗):** a full-screen workspace for one animation. The stage plays or steps frames (← → keys, Space), with **onion skin** (previous and next frame faintly behind) on a checkerboard. The timeline below shows every frame with its hold time: click to pick, shift-click for a range, Ctrl/⌘-click to add; **drag thumbnails to reorder**. Side tabs:
- **Frame** — hold time in milliseconds for the selected frames (or back to the FPS timing), **Duplicate**, **Delete**, **Reverse**, **Ping-pong** (adds the frames backwards so the loop rocks), **Edit pixels ↗** (the image workshop on that frame; *save as copy* inserts a new frame), **Frame → canvas**, and add frames from the **selected layers** or a **blank frame**.
- **Effects** — the glitch stack (below) on the selected frames or all frames, with a different glitch per frame if you like and a live preview on the stage; **Make glitch loop** turns the current frame into 6–24 glitching frames.
- **Clean up** — **Remove backgrounds** (engine matting baked into every frame), **Align & trim** (one floor line and one crop, so the character does not jitter), and **Pixel art (shared palette)**.
- **Export** — **animated GIF** (size: original or a long-edge limit, or ×1–×8 for pixel art without blurring; 16–256 colours; ordered dithering; transparency; loop setting and per-frame hold times are kept) and **Sheet + JSON** (packed PNG plus Aseprite-style JSON with frame rectangles, durations, a frame tag and a bottom-centre pivot, read by Godot, Phaser, Unity importers and most tools), or **Sheet → canvas**.

Every change is one project step: ↶ ↷ in the header or Ctrl/⌘+Z / Shift+Z undo and redo while the editor is open.

**Glitch & filters (Edit → Glitch & filters, no engine needed):** stack up to six effects, each with its own strength: RGB split, slice shift, block glitch, pixel sort, VHS (colour bleed and a rolling tracking band), wave, scanlines, CRT, noise, channel swap, posterize, halftone and vignette. Presets (Classic glitch, VHS tape, Datamosh, CRT monitor, Melt, Print) fill the stack; the seed (🎲 Shuffle) picks a different random glitch. The preview updates live; press and hold it to see the original. **Apply to layer** keeps the original (Restore original brings it back); **As new layer** adds a copy above. **Make glitch animation ↗** turns the layer into an 8–24 frame loop (rhythm: *bursts* mostly calm with sudden glitches, *steady*, or *pulse*) at up to 1024 px, and opens it in the frame editor for a GIF. The same effects work on video frames: make an animation **From selected video**, then apply effects in the frame editor. The GIF encoder (one shared palette per animation so colours do not flicker, real transparency, LZW) and the effects are dependency-free TypeScript.

## Assistant, voice, music and transcription

**Improve (✦ next to every prompt):** rewrites a short idea into a detailed prompt for an image, an AI edit, a video or a song. **Undo** next to it brings your text back. It runs Qwen3-VL-2B on your engine, or DeepSeek's API (V4 Flash family) when the Colab secret `DEEPSEEK_API_KEY` is set. DeepSeek V4 Flash itself is about 167 GB of weights, too large to run on one Colab GPU.

**Describe (Edit → AI edit card):** **→ Image prompt** writes a prompt that would recreate the selected layer into Create; **→ Video prompt** writes an animation prompt into Animate (tick “Start from the selected image” to animate that layer). Description always runs on your engine.

**Audio tab:**
- **Voice** — English text to speech (Chatterbox Turbo, MIT). Tags such as `[laugh]` or `[sigh]` add expression. Pick or upload a clean sample of about 10 seconds (it must be over 5 s) to clone a voice. Only clone voices you have permission to use; every clip carries Resemble's inaudible watermark.
- **Music** — songs with vocals up to five minutes (MiniMax Music 3). Describe the sound (name the vocal: “warm female vocal”), add lyrics with `[verse]`, `[chorus]`, `[bridge]` on their own lines, or tick Instrumental. Its licence asks you to show “MiniMax-Music3” in commercial products and to disclose AI-generated music when you publish it.
- **Transcribe** — speech to text with timed subtitles (faster-whisper base) from a clip, a video layer or a file (up to 32 MB). **Copy text**, **Download .srt** or **Add as note** on the canvas. A clip's transcript is saved with it.
- **Your sounds** — every voice clip, song and added file, with a player, Use as voice, Transcribe, Download and Delete. Sounds are embedded in `.zero` projects (MP3 from the engine, about 1.4 MB per minute) and follow Undo like layers.

## Upscale and pose

**Upscale (Edit → Upscale ×2 / ×4):** Real-ESRGAN x4plus (BSD-3) on your engine, run in tiles so large images fit in memory. The result is a new layer above the source at the same size on the canvas, with 2× or 4× the pixels (up to 8192 px per side and 48 MP). Transparent images keep their transparency.

**Pose:**
- **Pose editor** — drag the 18 joints of an OpenPose skeleton, start from a preset (standing, walking, running, arms up, T-pose, waving, sitting), mirror it, or **Detect from image** (DWPose on your engine).
- **Create → Pose** — tick “Use this pose” and new images follow it. The skeleton is sent as the last reference image, with an instruction naming it, so it uses one of the three reference slots.
- **Edit → AI edit → Change the pose** — opens the editor over the layer and detects the person's current pose; drag it to the new one. Identity, clothing and background are kept.
- Qwen-Image 2.1 follows a pose reference closely but not exactly. A strict pose ControlNet for Qwen-Image 2.1 exists (`alibaba-pai/Qwen-Image-2.1-Fun-Controlnet-Union`, 7.5 GB, non-commercial), but it is not in the pinned diffusers and is not wired in yet.

## Real Qwen on Google Colab

Open `colab/Studio_Zero_Colab.ipynb` in Google Colab using **File → Upload notebook**. It contains the service source, so no repository publication or separate ZIP upload is needed.

1. The notebook asks for an **A100 with High-RAM** (verified: 4-step edits in 3 s, inpainting in 5 s, background removal on the GPU in about 2 s). Pick another GPU in **Runtime → Change runtime type** to use fewer compute units: an L4 with High-RAM still gets the fast engine, a T4 uses stable-diffusion.cpp. Allow 25 GB or more free disk.
2. Tick the features you want in the **Settings** form (and optionally **Advanced settings**), then **Runtime → Run all**. The code is hidden behind six titled steps (*Show code* reveals it): 1 prepare the GPU, packages and Drive; 2 install the API; 3 get the models; 4 start the engine; 5 connect; 6 check. Weights and the engine come from the Google Drive cache (`MyDrive/StudioZero`). Only the first session downloads weights from Hugging Face (in parallel with building the engine for this GPU) and saves both to Drive in the background; every later session downloads nothing. Run the **Stop and save** cell at the end of the first session so Drive finishes saving.
3. Step 4 starts the API, which loads the model into memory once. Step 5 starts the HTTPS tunnel and shows **Studio Zero is ready** with an **Open Studio Zero** button (opens `http://localhost:5173` with the address and key in the URL fragment, which the browser never sends anywhere, and connects) plus copy buttons for the address and key.
4. Step 6 checks the engine. `CHECKS = quick` (default) makes one image; `full` tries every ticked feature (images, transparency, inpaint, references, background removal, Improve/Describe, voice and cloning, transcription, music, upscale, pose, video) and shows one ✓/✗ line per feature and a gallery of the results. If a check fails, see `service.log` and `outputs/engine.log`.
5. Generate from the studio. Keep Colab alive while working. Download the `.zero` project before ending the session.
6. Run the final stop cell when finished. Clear notebook outputs before sharing it; connection output contains a session key and tunnel address.

The notebook uses a Cloudflare Quick Tunnel as HTTPS transport, with bearer authentication on **every API route**, including outputs. Cloudflare terminates TLS and carries API traffic; it is not end-to-end encrypted through the tunnel provider. Use your own tunnel/VPN if preferred. CORS allows exact local studio origins, not `*`. A hosted frontend must be added explicitly to `ZERO_ALLOWED_ORIGINS`.

### Weights and compatibility

| Purpose         | Repository / file                                                           | Approximate download |
| --------------- | --------------------------------------------------------------------------- | -------------------- |
| Diffusion model | `abenzerps/Qwen-Image-2.1-GGUF` / `qwen-image-2.1-UC-Q4_K_M.gguf`           | 4.60 GB              |
| Text encoder    | `Qwen/Qwen3-VL-8B-Instruct-GGUF` / `Qwen3VL-8B-Instruct-Q4_K_M.gguf`        | 5.03 GB              |
| VAE             | `abenzerps/Qwen-Image-2.1-GGUF` / `vae/qwen_image_2.1_vae_bf16.safetensors` | 676 MB               |
| Background removal (optional) | `onnx-community/BiRefNet-ONNX` / `onnx/model.onnx` (MIT)      | 973 MB               |
| Video model (optional) | `vantagewithai/LTX-2.5-GGUF` / `distilled/ltx-2.5-22b-distilled-transformer-Q4_K_M.gguf` | 15.7 GB |
| Video text encoder (optional, gated) | `Lightricks/LTX-2.5` / `text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16.safetensors` | 26.3 GB |
| Video + audio VAEs (optional, gated) | `Lightricks/LTX-2.5` / `vae/ltx-2.5-video-vae-conv-bf16.safetensors`, `vae/ltx-2.5-audio-vae-bf16.safetensors` | 1.8 GB |
| Fast engine companion (≥ 22 GB GPU) | `Qwen/Qwen-Image-2.1` (text encoder, VAE, configs) + `alibaba-pai/Qwen-Image-2.1-Fun-Acc-LoRAs` (4-step adapter) | 19 GB |
| Assistant (optional, default on) | `Qwen/Qwen3-VL-2B-Instruct` (Apache-2.0) | 4.3 GB |
| Transcription (optional, default on) | `Systran/faster-whisper-base` (MIT) | 145 MB |
| Voice (optional, default on) | `ResembleAI/chatterbox-turbo` (MIT; `s3gen.safetensors` is skipped) | 3.0 GB |
| Upscale (optional, default on) | `Comfy-Org/Real-ESRGAN_repackaged` / `RealESRGAN_x4plus.safetensors` (BSD-3) | 67 MB |
| Pose detection (optional, default on) | `yzd-v/DWPose` / `dw-ll_ucoco_384.onnx` + `hr16/yolox-onnx` / `yolox_m.onnx` (Apache-2.0) | 236 MB |
| Music (optional, default off) | `MiniMaxAI/MiniMax-Music3` diffusers folders only (MiniMax-Music3 Community License) | 28 GB |

Larger image models are a one-line change: `DIFFUSION_FILE` can be any UC file in the repository (Q5_K_M, Q6_K, Q8_0 7.6 GB, BF16 14.2 GB). The pinned engine documents LTX-2.5 with the conv video VAE (the default `ltx-2.5-video-vae-bf16` diffusion decoder is not supported) and euler sampling; the distilled model is used with about 8 steps and guidance 1. Accept the LTX-2.5 licence on Hugging Face, then paste a read token into **HF_TOKEN** in the notebook Settings (or add it as the Colab secret `HF_TOKEN`) before enabling video. A token typed into Settings is saved in the notebook, so clear it before sharing; the step that gets the models checks the token and drops a rejected one so public downloads still work.

The diffusion model is the uncensored `UC-Q4_K_M` build; it and the model-specific VAE come from the `main` branch of the [abenzerps model repository](https://huggingface.co/abenzerps/Qwen-Image-2.1-GGUF) (renamed upstream to `Qwen-Image-2.1-Uncensored-GGUF`; the old name redirects). The UC files were converted with stable-diffusion.cpp `1330ceb`; the pinned runner revision below must still load them, which the notebook's smoke test verifies. The smaller official [GGUF text encoder](https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-GGUF/tree/main) follows the runner's [Qwen 2.1 instructions](https://github.com/leejet/stable-diffusion.cpp/blob/2bb72947cb129962f350452148658a32f4d3c057/docs/qwen_image_2.1.md). Earlier Qwen/Wan VAEs are not interchangeable with the 2.1 VAE. Check upstream model licenses; owning the studio code does not change model-weight terms.

The runner is pinned to `2bb72947cb129962f350452148658a32f4d3c057`. **Model cache:** `backend/model_cache.py` keeps every weight file once in a persistent store (`<store>/models/<repo>/<file>` plus `manifest.json` with revision and size). Later sessions load cached weights straight from Drive (`COPY_WEIGHTS_TO_LOCAL = True` copies them to local disk first instead). Cached files stay pinned to the revision first downloaded and are reused without any network request; `UPDATE_MODELS = True` checks `main` and replaces only changed files. `REDOWNLOAD_MODELS = True` ignores the cache and downloads every file again (same pinned revision unless `UPDATE_MODELS` is on), replacing the Drive copies; `REBUILD_ENGINE = True` recompiles the engine and replaces its Drive copy. A stored copy with the wrong size (cut short by a reset) is fetched again; a full Drive only means that file downloads again next session. Files from the earlier optional `CACHE_WEIGHTS_ON_DRIVE` layout are adopted without downloading. Needs about 12.5 GB of Drive space. The resolved revisions are also written to a runtime manifest. The service starts the engine with an explicit argument list and no shell. By default it runs the pinned `sd-server` as a private child process bound to `127.0.0.1`, built without its web frontend and never tunneled; the authenticated Studio Zero API is the only public surface. The engine keeps the model loaded between images. `ZERO_RUNNER=qwen-cli` switches to one `sd-cli` process per image (slower: weights reload each time).

**Verified on a Colab A100 80 GB (October 2026):** the fast engine (diffusers + Fun-Acc 4-step) loads the UC GGUF and passes generation, transparent output, inpainting and reference edits. A fresh runtime loads every model from Drive with no downloads, and BiRefNet runs on CUDA. The assistant (Improve 8.7 s, Describe 6.5 s), voice, voice cloning (4.7 s) and transcription (CUDA, 0.6 s for a 6-second clip) were then verified on the same GPU, after two fixes the real run exposed (NumPy 2 in Chatterbox, a removed PyAV option in faster-whisper). A full Run all on a fresh A100 then passed every smoke test end to end through the API: voice (92 s including the first voice-model load from Drive), cloning (5.0 s), transcription on CUDA (10.7 s including load, word-perfect), upscale ×2 (3.0 s, 512 → 1024 px), pose detection on CUDA (3.0 s, one person found) and a posed knight generation that follows the detected skeleton (4.0 s). Music (MiniMax Music 3) is off by default and has not yet had a GPU run; its smoke test runs when ENABLE_MUSIC is ticked.

**Validation boundary (edits, transparency, video):** edit payloads, RGBA prompting, masks, the video endpoint, AVI→MP4/WebM conversion with audio, and image↔video engine swapping are tested against stand-in engines that speak the pinned `sd-server` API (including a fake `vid_gen` that returns a real AVI with sound). The studio flows (transparent generation, all edit modes, pixel art, video layers, sprites from layers and from video, sheet export, save/reopen) pass in a headless browser against the demo engine. Real Qwen edit quality, real LTX-2.5 output and their memory needs have not been run here; the notebook's smoke tests are the acceptance check.

**Validation boundary:** the frontend, portable project model and job API have been tested locally, including demo image generation, subprocess cancellation, and the resident-engine lifecycle (background load, reuse across images, cancellation, crash reporting, shutdown) against a stand-in engine that speaks the pinned `sd-server` job API. The engine's flags, job API and model instructions were checked against the pinned source. The large model weights have not been downloaded here, and actual CUDA generation / Colab execution has not been verified in this workspace. The notebook's GPU smoke test is the acceptance check for that last step.

## Run Qwen on a local or other GPU host

Build `sd-server` (or `sd-cli` for the per-image fallback) following [the upstream build guide](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/build.md), then set these environment variables for the service process:

| Variable               | Meaning                                                 |
| ---------------------- | ------------------------------------------------------- |
| `ZERO_API_TOKEN`       | Random access key, at least 24 characters               |
| `ZERO_SD_SERVER`       | Absolute path to `sd-server` (default resident engine)  |
| `ZERO_SD_CLI`          | Absolute path to `sd-cli` (only for `qwen-cli`)          |
| `ZERO_ENGINE_PORT`     | Private loopback port for the engine (default 18431)    |
| `ZERO_FLASH_ATTENTION` | `1` (default) enables flash attention; `0` disables it  |
| `ZERO_ENGINE_LOAD_TIMEOUT` | Seconds allowed for the one-time model load (default 1800) |
| `ZERO_DIFFUSION`       | Absolute path to the requested diffusion GGUF           |
| `ZERO_TEXT_ENCODER`    | Absolute path to the Qwen3-VL text encoder              |
| `ZERO_VISION_ENCODER`  | Vision projection GGUF; enables references on the resident Qwen engine |
| `ZERO_VAE`             | Absolute path to the Qwen 2.1 VAE                       |
| `ZERO_SD_REVISION`     | Actual build revision (defaults to the pinned revision) |
| `ZERO_OUTPUT_DIR`      | Output and metadata directory (default `outputs`)       |
| `ZERO_ALLOWED_ORIGINS` | Comma-separated exact frontend origins                  |
| `ZERO_JOB_TIMEOUT`     | Per-job timeout in seconds (default 3600)               |
| `ZERO_MATTING_MODEL`   | BiRefNet ONNX file; enables background removal          |
| `ZERO_MATTING_DEVICE`  | `auto` (default: CUDA if available), `cuda`, or `cpu`   |
| `ZERO_MATTING_SIZE`    | Model input size in pixels (default 1024, fixed by the ONNX file) |
| `ZERO_RUNNER`          | `qwen` (resident engine, default), `qwen-cli`, or `demo` for testing |
| `ZERO_MODEL_ID`        | Model label recorded in metadata (the notebook sets repo/file@revision) |
| `ZERO_OFFLOAD`         | `auto` (default: offload weights to RAM only when they do not fit in GPU memory), `on`, `off` |
| `ZERO_VRAM_HEADROOM_GIB` | GPU memory kept free for activations when deciding `auto` offload (default 6) |
| `ZERO_SAGE_ATTENTION`  | `1` adds `--sage-attn` (faster attention on recent NVIDIA GPUs) |
| `ZERO_VAE_TILING`      | `auto` (default: tiles above ~2.4 MP), `on`, `off`      |
| `ZERO_VIDEO_DIFFUSION`, `ZERO_VIDEO_TEXT_ENCODER`, `ZERO_VIDEO_VAE`, `ZERO_VIDEO_AUDIO_VAE` | LTX-2.5 weights; setting `ZERO_VIDEO_DIFFUSION` enables video (`ZERO_VIDEO_CONNECTORS` for LTX-2.3) |
| `ZERO_VIDEO_ENGINE_PORT` | Private loopback port of the video engine (default 18432) |
| `ZERO_VIDEO_FORMAT`    | `mp4` (H.264 + AAC, default) or `webm` (VP9 + Opus)     |
| `ZERO_ENGINE_SWAP`     | `1` (default): one resident model in GPU memory at a time; `0` keeps image and video engines loaded together |
| `ZERO_FFMPEG`          | ffmpeg path for video conversion (default: `ffmpeg` on PATH, or `imageio-ffmpeg`) |

Start from the repository root, using the virtual environment:

```sh
python -m uvicorn backend.app:create_app --factory --host 127.0.0.1 --port 8000 --workers 1
```

Use **one worker**: this personal service has one serial GPU queue. A service move only changes its address/key in the studio. Bind to loopback behind a private HTTPS tunnel when running remotely.

## Workspace controls

- **V / H / N / T**: select, hand, note, editable text. **Space + drag** pans; scroll zooms at the cursor.
- **Shift + click** or drag a blank region for multiple selection. Drag any selected unlocked layer to move the selection.
- **Layers**: rename, show/hide, lock, group, move one step backward/forward, duplicate, delete, adjust bounds, export. Layer array order is the stacking order; group membership supplies visibility/lock and selection, not nested transforms.
- **Ctrl/⌘ + Z**, **Ctrl/⌘ + Shift + Z**: undo and redo. Text inputs retain native text undo while focused.
- **Ctrl/⌘ + S**: download `.zero`. Autosave is separate and stores the current project in IndexedDB.
- **Fit** frames visible layers; the percent button returns to 100%. **Grid** toggles the grid.
- On narrow screens, use the **☷** tool to show or hide creative panels.

The project remembers positions, sizes, view, groups, assets, prompts, settings, seeds, generation history and reserved mask data. A selected image's generation details can repopulate the Create panel. History keeps output assets even after their canvas layers are deleted.

## Scope and extension points

Implemented: AI edits (instruction, inpaint, outpaint, re-imagine, variations) as aligned new layers, transparent (RGBA) generation, pixel art with shared palettes, animations with a frame editor, animated GIF and sheet + JSON export, glitch effects and glitch animations, LTX-2.5 video with sound and video layers, engine swapping between image and video models, automatic GPU offload decisions, AI background removal on the engine (as a layer mask), soft brushes, feathered selections, nondestructive per-layer adjustments, live mask feather/density, text-to-image job flow, image/note/prompt layers, pan/zoom, marquee and multiple selection, proportional drag scaling, layer controls, basic groups, undo/redo, embedded `.zero` files, browser autosave, history, transparent PNG composition/selection export, authenticated serial jobs, cancellation, errors and persistent service metadata.

Control conditioning (pose/depth), AI upscale and batch scheduling remain planned (see `src/tools.ts`). The 4-step Qwen-Image 2.1 Fun-Acc speed-up is not used: it needs Alibaba's custom diffusers code (parallel decoding distillation), not a plain LoRA, so it cannot run in the stable-diffusion.cpp engine; a diffusers runner behind the same `Runner` protocol is the way to add it on a large GPU.

Current limits: no collaboration, nested groups, adjustment layers that affect every layer below (adjustments are per image layer), curves, pressure-sensitive brushes or Photoshop file import; one current browser autosave; one frontend job at a time; 40 undo states; PNG export up to 64 megapixels and 16,384 pixels per side. PNG exports preserve relative layer geometry, default to full image resolution on transparency, and exclude hidden and placeholder mask layers. Images in a `.zero` file are base64, so large projects cost memory; image imports are capped at 40 MB each and project imports at 250 MB. Browser storage can be cleared or run out of space: portable saves are your durable copy. The resident engine loads weights once per start; `/health` reports `engine: loading` and `ready: false` until then, and `loaded_in_seconds` afterwards. Running progress is indeterminate rather than an invented percentage. Cancelling a queued job removes it; cancelling the image already on the GPU returns at once but the engine finishes that image and discards it. Jobs interrupted by a service restart become failed; completed outputs remain available. A lost browser session does not automatically recover an in-flight job; service PNG/JSON files remain available on the engine.

## Development

```sh
npm run build
npm test
python -m pytest tests -q
python scripts/build_notebook.py
```

Use the virtual environment's Python for backend tests. `npm test` uses Node's built-in TypeScript stripping (Node 22.18+). Regenerate the notebook after changing backend modules. The lockfile pins frontend packages; Python dependencies have bounded compatible ranges.

With the development server running, open `/tests/editor-browser.html` for pixel-level browser checks (soft brushes, feathering, adjustments vs. a reference implementation, mask refinements, export and editor views) and an isolated editor test image. This page does not touch saved projects.

See [ARCHITECTURE.md](ARCHITECTURE.md) for data structures, ownership boundaries and the API contract. No external fonts, analytics, accounts or creative UI frameworks are required. Model files, outputs, runtime credentials and local environment files are excluded from source control.
