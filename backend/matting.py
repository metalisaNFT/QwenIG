"""Background removal. Only this module knows the matting model and how it is run.

A matter turns one image into a same-sized grayscale mask: white is the subject (kept), black is
background (hidden). The studio stores that as an ordinary layer mask, so no pixels are erased.
"""
import os
import time
from pathlib import Path
from threading import RLock, Thread
from typing import Protocol
from PIL import Image, ImageChops, ImageFilter, ImageStat

MATTING_MODEL = "onnx-community/BiRefNet-ONNX/onnx/model.onnx"
MEAN = (0.485, 0.456, 0.406)
STD = (0.229, 0.224, 0.225)


class Matter(Protocol):
    """Required: mode, model, readiness(), matte(). Optional: start(), stop(), state()."""
    mode: str
    model: str
    def readiness(self) -> tuple[bool, str]: ...
    def matte(self, image: Image.Image) -> Image.Image: ...


class BiRefNetMatter:
    """BiRefNet (MIT) through ONNX Runtime; CUDA when available, CPU otherwise.

    The session loads once in the background at service start, like the image engine, and is
    reused for every request. Requests run on the service's single GPU worker, so matting never
    competes with an image generation for GPU memory.
    """
    mode = "birefnet"

    def __init__(self):
        self.path = os.environ.get("ZERO_MATTING_MODEL", "")
        self.model = os.environ.get("ZERO_MATTING_MODEL_ID", MATTING_MODEL)
        self.size = int(os.environ.get("ZERO_MATTING_SIZE", "1024"))
        self.device_preference = os.environ.get("ZERO_MATTING_DEVICE", "auto")  # auto | cuda | cpu
        self.lock = RLock()
        self.session = None
        self.status = "stopped"  # stopped | loading | ready | failed
        self.detail = ""
        self.device = None
        self.loaded_in = None

    def start(self):
        with self.lock:
            if self.status in ("loading", "ready") or not Path(self.path).is_file():
                return
            self.status, self.detail = "loading", ""
        Thread(target=self._load, daemon=True, name="studio-zero-matting").start()

    def _providers(self, cpu_only=False):
        import onnxruntime as ort
        available = ort.get_available_providers()
        if not cpu_only and self.device_preference != "cpu" and "CUDAExecutionProvider" in available:
            return ["CUDAExecutionProvider", "CPUExecutionProvider"]
        if self.device_preference == "cuda" and not cpu_only:
            raise RuntimeError("CUDA was requested for background removal but ONNX Runtime has no CUDA provider.")
        return ["CPUExecutionProvider"]

    def _session(self, cpu_only=False):
        import onnxruntime as ort
        if not cpu_only and hasattr(ort, "preload_dlls"):
            try:
                ort.preload_dlls()  # find CUDA/cuDNN from pip-installed NVIDIA packages (e.g. on Colab)
            except Exception:
                pass
        options = ort.SessionOptions()
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        session = ort.InferenceSession(self.path, sess_options=options, providers=self._providers(cpu_only))
        device = "cuda" if "CUDAExecutionProvider" in session.get_providers() else "cpu"
        return session, device

    def _load(self):
        started = time.monotonic()
        try:
            session, device = self._session()
            with self.lock:
                self.session, self.device = session, device
                self.status, self.loaded_in = "ready", round(time.monotonic() - started, 1)
        except Exception as exc:  # reported through /health; the image engine keeps working
            with self.lock:
                self.status, self.detail = "failed", f"Background removal could not load: {exc}"

    def stop(self):
        with self.lock:
            self.session, self.status = None, "stopped"

    def state(self):
        with self.lock:
            return {"matting": self.status, "matting_device": self.device}

    def readiness(self):
        if not self.path or not Path(self.path).is_file():
            return False, "Background removal needs its model. Enable it in the Colab notebook and restart the API."
        with self.lock:
            status = self.status
        if status == "stopped":
            self.start()
            status = "loading"
        if status == "ready":
            return True, f"Background removal ready ({self.device})"
        if status == "loading":
            return False, "Loading the background removal model. Try again in a moment."
        return False, self.detail or "Background removal is unavailable."

    def _tensor(self, image: Image.Image, dtype):
        import numpy as np
        rgb = image.convert("RGB").resize((self.size, self.size), Image.Resampling.BILINEAR)
        array = (np.asarray(rgb, dtype=np.float32) / 255.0 - np.array(MEAN, dtype=np.float32)) / np.array(STD, dtype=np.float32)
        return array.transpose(2, 0, 1)[None].astype(dtype)

    def matte(self, image: Image.Image) -> Image.Image:
        import numpy as np
        ready, message = self.readiness()
        if not ready:
            raise RuntimeError(message)
        with self.lock:
            session = self.session
        source = session.get_inputs()[0]
        dtype = np.float16 if "float16" in source.type else np.float32
        feed = {source.name: self._tensor(image, dtype)}
        try:
            logits = session.run([session.get_outputs()[0].name], feed)[0]
        except Exception:
            if self.device != "cuda":
                raise
            # Usually GPU memory pressure next to the image engine: fall back to the CPU once.
            session, device = self._session(cpu_only=True)
            with self.lock:
                self.session, self.device = session, device
            logits = session.run([session.get_outputs()[0].name], feed)[0]
        logits = np.asarray(logits, dtype=np.float32).reshape(logits.shape[-2:])
        alpha = 1.0 / (1.0 + np.exp(-np.clip(logits, -40, 40)))
        mask = Image.fromarray(np.round(alpha * 255).astype(np.uint8), "L")
        return mask.resize(image.size, Image.Resampling.BILINEAR)


class DemoMatter:
    """Offline stand-in for tests and the demo service: separates colours that differ from the
    image border. Clearly labelled; it is not AI background removal."""
    mode = "demo"
    model = "studio-zero/border-colour-demo"

    def readiness(self):
        return True, "Demo background removal — border colour key, not AI"

    def matte(self, image: Image.Image) -> Image.Image:
        rgb = image.convert("RGB")
        w, h = rgb.size
        strips = [rgb.crop(box) for box in ((0, 0, w, 1), (0, h - 1, w, h), (0, 0, 1, h), (w - 1, 0, w, h))]
        border = Image.new("RGB", (w * 2 + h * 2, 1))
        x = 0
        for strip in strips:
            flat = strip.resize((strip.width * strip.height, 1))
            border.paste(flat, (x, 0))
            x += flat.width
        background = tuple(int(v) for v in ImageStat.Stat(border).median)
        difference = ImageChops.difference(rgb, Image.new("RGB", rgb.size, background))
        channels = difference.split()
        distance = ImageChops.lighter(ImageChops.lighter(channels[0], channels[1]), channels[2])
        mask = distance.point(lambda v: 0 if v < 24 else 255 if v > 56 else round((v - 24) * 255 / 32))
        if image.mode in ("RGBA", "LA") or "transparency" in image.info:
            mask = ImageChops.multiply(mask, image.convert("RGBA").getchannel("A"))
        return mask.filter(ImageFilter.GaussianBlur(1))


def default_matter(runner_mode: str):
    """Demo services get the demo matter; real engines need ZERO_MATTING_MODEL."""
    if runner_mode == "demo":
        return DemoMatter()
    if os.environ.get("ZERO_MATTING_MODEL"):
        return BiRefNetMatter()
    return None
