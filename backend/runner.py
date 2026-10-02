"""Only this module knows the model runner's command-line and local engine interfaces."""
import base64
import io
import json
import math
import os
import random
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from threading import Event, RLock, Thread
from typing import Callable, Protocol
from PIL import Image, ImageChops, ImageDraw, ImageFilter, PngImagePlugin
from .schema import EditRequest, GenerateRequest, VideoRequest, decode_image_data

MODEL = "abenzerps/Qwen-Image-2.1-GGUF/qwen-image-2.1-UC-Q4_K_M"
VIDEO_MODEL = "vantagewithai/LTX-2.5-GGUF/ltx-2.5-22b-distilled-transformer-Q4_K_M"
SD_REVISION = "2bb72947cb129962f350452148658a32f4d3c057"


class Cancelled(Exception):
    pass


class Runner(Protocol):
    """Required: mode, model, readiness(), generate(). Optional: edit(), start(), stop(), state()."""
    mode: str
    model: str
    def readiness(self) -> tuple[bool, str]: ...
    def generate(self, request: GenerateRequest, output: Path, cancelled: Event, progress: Callable) -> None: ...


def transparent_prompt(prompt: str) -> str:
    """The documented Qwen-Image 2.1 phrasing for RGBA output with a transparent background."""
    return ("This is an RGBA image with transparency. " + prompt.strip().rstrip(".") +
            ". The image has alpha channel and the background is transparent.")


_gpu_memory: list = []


def gpu_memory_gib():
    """Total memory of the first GPU in GiB, or None if it cannot be read (cached)."""
    if not _gpu_memory:
        try:
            text = subprocess.run(["nvidia-smi", "--query-gpu=memory.total", "--format=csv,noheader,nounits"],
                                  capture_output=True, text=True, timeout=20, check=True).stdout
            _gpu_memory.append(float(text.split()[0]) / 1024)
        except (OSError, subprocess.SubprocessError, ValueError, IndexError):
            _gpu_memory.append(None)
    return _gpu_memory[0]


def offload_wanted(weight_paths, env="ZERO_OFFLOAD"):
    """on/off force CPU offload; auto (default) offloads only when the weights plus headroom exceed GPU memory."""
    mode = os.environ.get(env, "auto").strip().lower()
    if mode in ("1", "on", "true", "yes"):
        return True
    if mode in ("0", "off", "false", "no"):
        return False
    vram = gpu_memory_gib()
    if vram is None:
        return True
    total = 0
    for path in weight_paths:
        try:
            total += Path(path).stat().st_size
        except OSError:
            return True
    headroom = float(os.environ.get("ZERO_VRAM_HEADROOM_GIB", "6"))
    return total / 2**30 + headroom > vram


def find_ffmpeg():
    """ffmpeg converts the engine's AVI (MJPEG + PCM audio) into browser-playable MP4."""
    configured = os.environ.get("ZERO_FFMPEG")
    if configured and Path(configured).is_file():
        return configured
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg  # optional fallback
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def video_format():
    """mp4 (H.264 + AAC, plays everywhere, default) or webm (VP9 + Opus, royalty-free)."""
    return "webm" if os.environ.get("ZERO_VIDEO_FORMAT", "mp4").lower() == "webm" else "mp4"


def encoder_args(fmt):
    if fmt == "webm":
        return ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "30", "-row-mt", "1", "-deadline", "realtime", "-cpu-used", "8",
                "-pix_fmt", "yuv420p", "-c:a", "libopus", "-b:a", "128k"]
    return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k",
            "-movflags", "+faststart"]


def to_browser_video(source: Path, output: Path, cancelled: Event, fmt=None):
    """Convert the engine's AVI (MJPEG + PCM audio) into a browser-playable MP4 or WebM."""
    fmt = fmt or video_format()
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise RuntimeError("Video needs ffmpeg on the engine to convert the result. Install ffmpeg and restart the API.")
    temporary = output.with_name(output.stem + ".tmp." + fmt)
    process = subprocess.Popen([ffmpeg, "-y", "-loglevel", "error", "-i", str(source), *encoder_args(fmt), str(temporary)],
                               stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, shell=False)
    while process.poll() is None:
        if cancelled.wait(.2):
            process.kill(); process.wait(); temporary.unlink(missing_ok=True)
            raise Cancelled()
    if process.returncode or not temporary.is_file():
        temporary.unlink(missing_ok=True)
        raise RuntimeError("Could not convert the video for the browser: " + (process.stderr.read().decode(errors="replace")[-300:] if process.stderr else ""))
    temporary.replace(output)


def video_info(path: Path):
    """(width, height, decoded frame count, fps) of a video, parsed from ffmpeg's own output (no ffprobe needed)."""
    ffmpeg = find_ffmpeg()
    result = subprocess.run([ffmpeg, "-hide_banner", "-i", str(path), "-map", "0:v:0", "-f", "null", "-"],
                            capture_output=True, text=True, timeout=120)
    text = result.stderr
    import re
    size = re.search(r"Video: [^\n]*?(\d{2,5})x(\d{2,5})", text)
    fps = re.search(r"(\d+(?:\.\d+)?) fps", text)
    frames = re.findall(r"frame=\s*(\d+)", text)
    if not size:
        raise RuntimeError("The engine produced an unreadable video.")
    return int(size.group(1)), int(size.group(2)), int(frames[-1]) if frames else 0, float(fps.group(1)) if fps else 0.0


# Command-line runner ------------------------------------------------------------------------------

class _QwenWeights:
    """Weight paths shared by every Qwen runner; configured only through the environment."""
    mode = "qwen"
    model = MODEL
    binary_env = "ZERO_SD_CLI"
    binary_label = "runner"

    def __init__(self):
        self.binary = os.environ.get(self.binary_env, "")
        self.diffusion = os.environ.get("ZERO_DIFFUSION", "")
        self.encoder = os.environ.get("ZERO_TEXT_ENCODER", "")
        self.vae = os.environ.get("ZERO_VAE", "")
        self.model = os.environ.get("ZERO_MODEL_ID", MODEL)

    def weights(self):
        return [("diffusion weights", self.diffusion, "--diffusion-model"), ("text encoder", self.encoder, "--llm"), ("VAE", self.vae, "--vae")]

    def missing(self):
        items = [(self.binary_label, self.binary), *[(label, path) for label, path, _ in self.weights()]]
        return [name for name, value in items if not value or not Path(value).is_file()]

    def weight_args(self):
        return [part for _, path, flag in self.weights() for part in (flag, path)]


class QwenRunner(_QwenWeights):
    """One sd-cli process per image. Simple and robust, but reloads ~10 GB of weights every time."""

    def readiness(self):
        missing = self.missing()
        return (False, "Configure missing " + ", ".join(missing)) if missing else (True, "Qwen engine ready")

    def command(self, r: GenerateRequest, output: Path):
        # Explicit argv, never a shell. Prompts cannot become options or commands.
        prompt = transparent_prompt(r.prompt) if r.transparent else r.prompt
        return [self.binary, *self.weight_args(), "-p", prompt, "-n", r.negative_prompt,
                "-W", str(r.width), "-H", str(r.height), "--steps", str(r.steps),
                "--cfg-scale", str(r.guidance), "--seed", str(r.seed),
                "--sampling-method", "euler", "--offload-to-cpu", "-o", str(output)]

    def generate(self, request, output, cancelled, progress):
        ready, message = self.readiness()
        if not ready:
            raise RuntimeError(message)
        progress(None, "Creating your image…")
        log_path = output.with_suffix(".log")
        # Write logs to a private file rather than a pipe that can deadlock on verbose output.
        with log_path.open("wb") as log:
            process = subprocess.Popen(self.command(request, output), stdout=log, stderr=subprocess.STDOUT, shell=False)
            try:
                deadline = time.monotonic() + int(os.environ.get("ZERO_JOB_TIMEOUT", "3600"))
                while process.poll() is None:
                    if cancelled.wait(.2):
                        raise Cancelled()
                    if time.monotonic() > deadline:
                        raise RuntimeError("Generation timed out. Try a smaller image or more GPU memory.")
                if cancelled.is_set():
                    raise Cancelled()
                if process.returncode:
                    raise RuntimeError("The image engine failed. Check the private service log for memory or model compatibility errors.")
            finally:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
        if not output.is_file():
            # Some sd-cli versions suffix the single result with _1.
            alternative = output.with_name(output.stem + "_1.png")
            if alternative.is_file():
                alternative.replace(output)
            else:
                raise RuntimeError("Engine finished without producing an image.")


# Resident engines (sd-server child processes) -----------------------------------------------------

class ResidentEngine:
    """Loads weights once into a private sd-server child process and reuses them for every job.

    The child listens only on 127.0.0.1 and is never exposed: the authenticated Studio Zero API
    remains the single public surface. Loading starts in the background, so the API answers
    immediately and reports "loading" until the model is resident. Subclasses supply weights.
    """
    binary_env = "ZERO_SD_SERVER"
    binary_label = "engine server"
    port_env, default_port = "ZERO_ENGINE_PORT", 18431
    log_name = "engine.log"
    label = "image"

    def _init_engine(self):
        self.binary = os.environ.get(self.binary_env, "")
        self.port = int(os.environ.get(self.port_env, str(self.default_port)))
        self.base = f"http://127.0.0.1:{self.port}"
        self.flash_attention = os.environ.get("ZERO_FLASH_ATTENTION", "1") != "0"
        self.sage_attention = os.environ.get("ZERO_SAGE_ATTENTION", "0") == "1"
        self.load_timeout = int(os.environ.get("ZERO_ENGINE_LOAD_TIMEOUT", "1800"))
        log_dir = Path(os.environ.get("ZERO_OUTPUT_DIR", "outputs"))
        default_log = os.environ.get("ZERO_ENGINE_LOG") if self.log_name == "engine.log" else None
        self.log_path = Path(default_log or log_dir / self.log_name)
        self.lock = RLock()
        self.process = None
        self.status = "stopped"  # stopped | loading | ready | failed
        self.detail = ""
        self.loaded_in = None
        self.last_start = 0.0

    # Configuration ---------------------------------------------------------
    def weights(self):  # [(label, path, flag)]
        raise NotImplementedError

    def extra_args(self):
        return []

    def missing(self):
        items = [(self.binary_label, self.binary), *[(label, path) for label, path, _ in self.weights()]]
        return [name for name, value in items if not value or not Path(value).is_file()]

    def weight_args(self):
        return [part for _, path, flag in self.weights() for part in (flag, path)]

    @property
    def offload(self):
        return offload_wanted([path for _, path, _ in self.weights()])

    def command(self):
        argv = [self.binary, *self.weight_args(), *self.extra_args()]
        if self.offload:
            argv.append("--offload-to-cpu")
        argv += ["--listen-ip", "127.0.0.1", "--listen-port", str(self.port)]
        if self.flash_attention:
            argv.append("--diffusion-fa")
        if self.sage_attention:
            argv.append("--sage-attn")
        return argv

    # Lifecycle ---------------------------------------------------------------
    def start(self):
        with self.lock:
            if self.process is not None and self.process.poll() is None:
                return
            if self.missing():
                return
            self.log_path.parent.mkdir(parents=True, exist_ok=True)
            log = self.log_path.open("ab")
            self.process = subprocess.Popen(self.command(), stdout=log, stderr=subprocess.STDOUT, shell=False)
            log.close()
            self.status, self.detail, self.loaded_in = "loading", "", None
            self.last_start = time.monotonic()
            Thread(target=self._await_ready, args=(self.process,), daemon=True, name=f"studio-zero-{self.label}-engine").start()

    def _await_ready(self, process):
        started = time.monotonic()
        while time.monotonic() - started < self.load_timeout:
            if process.poll() is not None:
                with self.lock:
                    if self.process is process:
                        self.status, self.detail = "failed", f"The {self.label} engine stopped while loading (exit {process.returncode}). Check {self.log_path.name}."
                return
            try:
                self._request("GET", "/sdcpp/v1/capabilities", timeout=2)
                with self.lock:
                    if self.process is process:
                        self.status, self.loaded_in = "ready", round(time.monotonic() - started, 1)
                return
            except (OSError, ValueError):
                time.sleep(1)
        with self.lock:
            if self.process is not process:
                return
            self.status, self.detail = "failed", f"The {self.label} engine did not finish loading in time. Check {self.log_path.name}."
        self._terminate(process)

    def stop(self):
        with self.lock:
            process, self.process = self.process, None
            self.status = "stopped"
        self._terminate(process)

    @staticmethod
    def _terminate(process):
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()

    def state(self):
        with self.lock:
            if self.status == "ready" and (self.process is None or self.process.poll() is not None):
                code = self.process.returncode if self.process is not None else "?"
                self.status, self.detail = "failed", f"The {self.label} engine stopped unexpectedly (exit {code}). Check {self.log_path.name}."
            return {"engine": self.status, "loaded_in_seconds": self.loaded_in}

    def readiness(self):
        missing = self.missing()
        if missing:
            return False, "Configure missing " + ", ".join(missing)
        status = self.state()["engine"]
        # Start lazily, and restart a stopped/crashed engine at most once every 60 seconds.
        if status == "stopped" or (status == "failed" and time.monotonic() - self.last_start > 60):
            self.start()
            status = self.state()["engine"]
        if status == "ready":
            return True, self.ready_message
        if status == "loading":
            return False, f"Loading the {self.label} model into memory. This happens once per engine start."
        return False, self.detail or f"The {self.label} engine is not running."

    ready_message = "Engine ready"

    # Jobs ----------------------------------------------------------------------
    def _request(self, method, path, body=None, timeout=30):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, method=method, headers={"Content-Type": "application/json"} if data else {})
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return json.loads(response.read() or b"{}")

    def _run(self, endpoint, payload, cancelled, progress, working, timeout_message):
        ready, message = self.readiness()
        if not ready:
            raise RuntimeError(message)
        try:
            job = self._request("POST", endpoint, payload, timeout=120)
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = json.loads(exc.read() or b"{}").get("error", {}).get("message", "")
            except (ValueError, AttributeError):
                pass
            raise RuntimeError(f"The engine rejected this request ({exc.code}{': ' + detail if detail else ''}). Check {self.log_path.name}.") from None
        except OSError:
            raise RuntimeError(f"The engine is not reachable. Check {self.log_path.name}.") from None
        job_id = job["id"]
        deadline = time.monotonic() + int(os.environ.get("ZERO_JOB_TIMEOUT", "3600"))
        while True:
            if cancelled.wait(.5):
                # Queued engine jobs are removed; one already on the GPU finishes and is discarded.
                try:
                    self._request("POST", f"/sdcpp/v1/jobs/{job_id}/cancel", {}, timeout=5)
                except (OSError, ValueError):
                    pass
                raise Cancelled()
            if time.monotonic() > deadline:
                raise RuntimeError(timeout_message)
            if self.state()["engine"] != "ready":
                raise RuntimeError(self.detail or f"The engine stopped during generation. Check {self.log_path.name}.")
            try:
                job = self._request("GET", f"/sdcpp/v1/jobs/{job_id}", timeout=10)
            except (OSError, ValueError):
                continue
            status = job.get("status")
            if status == "completed":
                return job.get("result") or {}
            if status == "failed":
                raise RuntimeError(f"The {self.label} engine failed: " + str((job.get("error") or {}).get("message", "unknown error")))
            if status == "cancelled":
                raise Cancelled()
            position = job.get("queue_position") or 0
            progress(None, working if status == "generating" or position == 0 else "Waiting for the engine…")


class ResidentQwenRunner(_QwenWeights, ResidentEngine):
    """Qwen-Image 2.1 text-to-image, reference editing, inpainting and image-to-image."""
    binary_env = "ZERO_SD_SERVER"
    binary_label = "engine server"
    ready_message = "Qwen engine ready — model loaded and kept in memory"

    def __init__(self):
        _QwenWeights.__init__(self)
        self._init_engine()
        self.vision = os.environ.get("ZERO_VISION_ENCODER", "")

    @property
    def supports_references(self):
        return bool(self.vision and Path(self.vision).is_file())

    supports_edit = True
    supports_transparency = True

    def extra_args(self):
        return ["--llm_vision", self.vision] if self.supports_references else []

    def vae_tiling(self, width, height):
        mode = os.environ.get("ZERO_VAE_TILING", "auto").lower()
        if mode in ("1", "on"):
            return True
        if mode in ("0", "off"):
            return False
        return width * height > int(os.environ.get("ZERO_VAE_TILING_PIXELS", str(1536 * 1536)))

    def payload(self, r: GenerateRequest):
        body = {"prompt": transparent_prompt(r.prompt) if r.transparent else r.prompt,
                "negative_prompt": r.negative_prompt, "width": r.width, "height": r.height,
                "ref_images": r.reference_images, "auto_resize_ref_image": False,
                "seed": r.seed, "batch_count": 1, "embed_image_metadata": False, "output_format": "png",
                "sample_params": {"sample_method": "euler", "sample_steps": r.steps, "guidance": {"txt_cfg": float(r.guidance)}}}
        if self.vae_tiling(r.width, r.height):
            body["vae_tiling_params"] = {"enabled": True}
        return body

    def edit_payload(self, r: EditRequest):
        """Map a studio edit onto the engine's native fields (mask: white = regenerate, black = keep)."""
        body = self.payload(r)
        references = list(r.reference_images)
        if r.operation == "edit":
            body["ref_images"] = [r.image, *references]
        else:
            body["init_image"] = r.image
            body["strength"] = r.effective_strength
            if r.operation in ("inpaint", "outpaint"):
                body["mask_image"] = r.mask
            # With the vision encoder, the source also conditions the edit so new content matches it.
            body["ref_images"] = ([r.image] if self.supports_references and r.operation != "image-to-image" else []) + references
        return body

    def _image(self, payload, output, cancelled, progress, working):
        result = self._run("/sdcpp/v1/img_gen", payload, cancelled, progress, working,
                           "Generation timed out. Try a smaller image or more GPU memory.")
        images = result.get("images") or []
        if not images:
            raise RuntimeError("Engine finished without producing an image.")
        output.write_bytes(base64.b64decode(images[0]["b64_json"]))

    def generate(self, request, output, cancelled, progress):
        self._image(self.payload(request), output, cancelled, progress, "Creating your image…")

    def edit(self, request, output, cancelled, progress):
        self._image(self.edit_payload(request), output, cancelled, progress, "Editing your image…")


class ResidentVideoRunner(ResidentEngine):
    """LTX-2.5 text/image-to-video with audio through a second sd-server (vid_gen)."""
    mode = "qwen"
    label = "video"
    port_env, default_port = "ZERO_VIDEO_ENGINE_PORT", 18432

    @property
    def format(self):
        return video_format()
    log_name = "video-engine.log"
    ready_message = "Video engine ready — model loaded and kept in memory"

    def __init__(self):
        self.model = os.environ.get("ZERO_VIDEO_MODEL_ID", VIDEO_MODEL)
        self.diffusion = os.environ.get("ZERO_VIDEO_DIFFUSION", "")
        self.encoder = os.environ.get("ZERO_VIDEO_TEXT_ENCODER", "")
        self.vae = os.environ.get("ZERO_VIDEO_VAE", "")
        self.audio_vae = os.environ.get("ZERO_VIDEO_AUDIO_VAE", "")
        self.connectors = os.environ.get("ZERO_VIDEO_CONNECTORS", "")
        self._init_engine()

    @property
    def configured(self):
        return bool(self.diffusion)

    def weights(self):
        items = [("video diffusion weights", self.diffusion, "--diffusion-model"), ("video text encoder", self.encoder, "--llm"),
                 ("video VAE", self.vae, "--vae"), ("audio VAE", self.audio_vae, "--audio-vae")]
        if self.connectors:
            items.append(("embeddings connectors", self.connectors, "--embeddings-connectors"))
        return items

    def missing(self):
        missing = super().missing()
        return missing + ([] if find_ffmpeg() else ["ffmpeg"])

    def payload(self, r: VideoRequest):
        body = {"prompt": r.prompt, "negative_prompt": r.negative_prompt, "width": r.width, "height": r.height,
                "seed": r.seed, "video_frames": r.frames, "fps": r.fps, "output_format": "avi", "output_compression": 95,
                "embed_image_metadata": False,
                "sample_params": {"sample_method": "euler", "sample_steps": r.steps, "guidance": {"txt_cfg": float(r.guidance)}},
                "vae_tiling_params": {"enabled": True, "temporal_tiling": True}}
        if r.image:
            body["init_image"] = r.image
        if r.end_image:
            body["end_image"] = r.end_image
        return body

    def generate_video(self, request, output, cancelled, progress):
        result = self._run("/sdcpp/v1/vid_gen", self.payload(request), cancelled, progress, "Creating your video…",
                           "Video generation timed out. Try fewer frames, a smaller size or more GPU memory.")
        data = result.get("b64_json")
        if not data:
            raise RuntimeError("The video engine finished without producing a video.")
        progress(None, "Preparing the video for the browser…")
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "engine.avi"
            source.write_bytes(base64.b64decode(data))
            to_browser_video(source, output, cancelled, self.format)


# Demo engines --------------------------------------------------------------------------------------

class DemoRunner:
    """Procedural graphics for offline integration testing. Never presented as AI."""
    mode = "demo"
    model = "studio-zero/procedural-demo"
    supports_edit = True
    supports_transparency = True

    supports_references = False

    def __init__(self, references=None):
        # Off by default: a text-only demo must reject references, not ignore them. With references on
        # (ZERO_DEMO_REFERENCES=1, for testing reference and pose flows) each reference is visibly stamped in.
        if references is None and os.environ.get("ZERO_DEMO_REFERENCES") == "1":
            references = True
        if references is not None:
            self.supports_references = references

    def readiness(self):
        return True, "Demo engine ready — procedural artwork, not AI generation"

    @staticmethod
    def _stamp_references(image, references):
        """Paste each reference as a labelled thumbnail along the top edge, so it is visibly used."""
        size = max(32, min(image.size) // 5)
        for i, value in enumerate(references):
            thumb = decode_image_data(value).convert("RGB")
            ratio = size / max(thumb.size)
            thumb = thumb.resize((max(1, round(thumb.width * ratio)), max(1, round(thumb.height * ratio))))
            x = image.width - (i + 1) * (size + 8)
            image.paste(thumb, (x, 8))
            ImageDraw.Draw(image).text((x + 4, 10 + thumb.height), f"REF {i + 1}", fill="#ffffff")
        return image

    def _wait(self, cancelled, progress, message):
        for i in range(8):
            if cancelled.wait(.15):
                raise Cancelled()
            progress(i * 12, message)

    @staticmethod
    def _label(image, text):
        draw = ImageDraw.Draw(image)
        w, h = image.size
        draw.text((int(w * .04), int(h * .92)), text, fill="#d2e6b4", font_size=max(12, w // 45))

    @staticmethod
    def _save(image, output):
        info = PngImagePlugin.PngInfo(); info.add_text("Studio Zero", "Procedural demo. Not an AI-generated image.")
        image.save(output, pnginfo=info)

    def artwork(self, request):
        rng = random.Random(request.seed)
        w, h = request.width, request.height
        if request.transparent:
            im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
            draw = ImageDraw.Draw(im)
            r = int(min(w, h) * .32)
            cx, cy = w // 2, h // 2
            draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(88, 121, 96, 255))
            draw.ellipse((cx - r // 3, cy - r // 2, cx + r // 6, cy - r // 6), fill=(228, 236, 182, 255))
            for _ in range(5):
                x, y = rng.randint(cx - r, cx + r), rng.randint(cy - r, cy + r)
                draw.ellipse((x - 6, y - 6, x + 6, y + 6), fill=(53, 91, 73, 255))
            return im
        im = Image.new("RGB", (w, h), "#d4dbbf")
        draw = ImageDraw.Draw(im)
        for y in range(h):
            t = y / h
            draw.line((0, y, w, y), fill=(int(201 - 48 * t), int(217 - 42 * t), int(192 - 41 * t)))
        sun_x, sun_y, radius = int(w * .7), int(h * .28), int(min(w, h) * .14)
        draw.ellipse((sun_x - radius, sun_y - radius, sun_x + radius, sun_y + radius), fill="#e4ecb6")
        for index, color in enumerate(["#879c7e", "#587960", "#355b49", "#20463d"]):
            points = [(0, h), (0, h * (.52 + index * .1))]
            points += [(x, h * (.52 + index * .1) + rng.randint(-int(h * .1), int(h * .1))) for x in range(0, w + 1, max(1, w // 6))]
            points += [(w, h)]
            draw.polygon(points, fill=color)
        self._label(im, "STUDIO ZERO / DEMO ARTWORK")
        return im

    def generate(self, request, output, cancelled, progress):
        self._wait(cancelled, progress, "Composing demo artwork…")
        self._save(self._stamp_references(self.artwork(request), request.reference_images), output)

    def edit(self, request, output, cancelled, progress):
        """Visibly procedural: masked areas get a hatched demo fill; edits/variations are tinted."""
        self._wait(cancelled, progress, "Applying demo edit…")
        source = decode_image_data(request.image).convert("RGBA").resize((request.width, request.height))
        tint = Image.new("RGBA", source.size, (120, 170, 220, 255) if request.operation in ("edit", "image-to-image", "variations") else (220, 140, 90, 255))
        if request.operation in ("inpaint", "outpaint"):
            mask = decode_image_data(request.mask).convert("L").resize(source.size)
            fill = Image.new("RGBA", source.size, (220, 140, 90, 255))
            draw = ImageDraw.Draw(fill)
            for x in range(-source.height, source.width, 18):
                draw.line((x, 0, x + source.height, source.height), fill=(240, 196, 120, 255), width=6)
            result = Image.composite(fill, source, mask)
        else:
            result = Image.blend(source, tint, request.effective_strength * .45)
            if request.transparent:
                result.putalpha(source.getchannel("A"))
        if not request.transparent:
            result = result.convert("RGB")
        self._label(result, "DEMO EDIT - NOT AI")
        self._save(self._stamp_references(result, request.reference_images), output)


class DemoVideoRunner:
    """Procedural moving shapes encoded to MP4 with ffmpeg. Never presented as AI."""
    mode = "demo"
    label = "video"
    model = "studio-zero/procedural-demo-video"

    @property
    def format(self):
        return video_format()

    def readiness(self):
        return (True, "Demo video engine ready — procedural animation, not AI") if find_ffmpeg() else (False, "Demo video needs ffmpeg.")

    def missing(self):
        return [] if find_ffmpeg() else ["ffmpeg"]

    def generate_video(self, request, output, cancelled, progress):
        ffmpeg = find_ffmpeg()
        if not ffmpeg:
            raise RuntimeError("Demo video needs ffmpeg.")
        start = decode_image_data(request.image).convert("RGB").resize((request.width, request.height)) if request.image else None
        w, h = request.width, request.height
        temporary = output.with_name(output.stem + ".tmp." + self.format)
        video_args = [a for a in encoder_args(self.format)]
        # No audio track in the demo: drop the audio encoder options.
        for flag in ("-c:a", "-b:a"):
            i = video_args.index(flag)
            del video_args[i:i + 2]
        process = subprocess.Popen([ffmpeg, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}",
                                    "-r", str(request.fps), "-i", "-", *video_args, str(temporary)], stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            for i in range(request.frames):
                if cancelled.is_set():
                    raise Cancelled()
                if i % 8 == 0:
                    progress(round(i * 100 / request.frames), "Animating demo video…")
                t = i / max(1, request.frames - 1)
                frame = start.copy() if start else Image.new("RGB", (w, h), (int(40 + 60 * t), 70, 90))
                draw = ImageDraw.Draw(frame)
                r = int(min(w, h) * .12)
                x = int(r + (w - 2 * r) * t); y = int(h / 2 + math.sin(t * math.pi * 4) * h * .2)
                draw.ellipse((x - r, y - r, x + r, y + r), fill=(228, 236, 182))
                draw.text((int(w * .04), int(h * .9)), "DEMO VIDEO - NOT AI", fill="#d2e6b4", font_size=max(12, w // 40))
                process.stdin.write(frame.tobytes())
            process.stdin.close()
            if process.wait(timeout=120) or not temporary.is_file():
                raise RuntimeError("Demo video encoding failed.")
            temporary.replace(output)
        finally:
            if process.poll() is None:
                process.kill(); process.wait()
            temporary.unlink(missing_ok=True)
