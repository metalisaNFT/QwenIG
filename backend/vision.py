"""Upscaling and pose detection.

Upscaler      Real-ESRGAN x4plus (BSD-3) through spandrel, tiled so any image size fits in memory.
              ×2 runs the ×4 model and downsamples with Lanczos (sharper than a native ×2 model).
PoseDetector  DWPose whole-body (Apache-2.0) with a YOLOX person detector through rtmlib on ONNX Runtime;
              returns OpenPose-18 body keypoints that the studio's pose editor understands.

Both load on first use (small: 67 MB and ~240 MB) and follow ZERO_HELPERS_RESIDENT. Demo twins need
no weights so the studio and its tests run anywhere.
"""
import os
from pathlib import Path
from threading import RLock

from PIL import Image, ImageDraw

from .audio import free_torch, helpers_resident
from .runner import Cancelled

UPSCALE_MODEL = "Comfy-Org/Real-ESRGAN_repackaged/RealESRGAN_x4plus"
POSE_MODEL = "yzd-v/DWPose/dw-ll_ucoco_384 + hr16/yolox-onnx/yolox_m"
MAX_OUTPUT_EDGE = 8192
MAX_OUTPUT_PIXELS = 48_000_000

# OpenPose-18 body: 0 nose, 1 neck, 2-4 right arm, 5-7 left arm, 8-10 right leg, 11-13 left leg, 14-17 eyes/ears.
LIMBS = [(1, 2), (1, 5), (2, 3), (3, 4), (5, 6), (6, 7), (1, 8), (8, 9), (9, 10), (1, 11), (11, 12), (12, 13),
         (1, 0), (0, 14), (14, 16), (0, 15), (15, 17)]
COLORS = [(255, 0, 0), (255, 85, 0), (255, 170, 0), (255, 255, 0), (170, 255, 0), (85, 255, 0), (0, 255, 0),
          (0, 255, 85), (0, 255, 170), (0, 255, 255), (0, 170, 255), (0, 85, 255), (0, 0, 255), (85, 0, 255),
          (170, 0, 255), (255, 0, 255), (255, 0, 170), (255, 0, 85)]


def upscaled_size(width: int, height: int, scale: int):
    return width * scale, height * scale


def check_upscale_size(width: int, height: int, scale: int):
    w, h = upscaled_size(width, height, scale)
    if max(w, h) > MAX_OUTPUT_EDGE or w * h > MAX_OUTPUT_PIXELS:
        raise ValueError(f"×{scale} would make {w} × {h} pixels; the limit is {MAX_OUTPUT_EDGE} pixels per side "
                         f"and {MAX_OUTPUT_PIXELS // 1_000_000} megapixels. Use ×2 or a smaller image.")


def split_alpha(image: Image.Image):
    """RGB for the model; the alpha channel (if any) is resized separately so cut-outs stay cut out."""
    if image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info):
        rgba = image.convert("RGBA")
        alpha = rgba.getchannel("A")
        return rgba.convert("RGB"), (alpha if alpha.getextrema() != (255, 255) else None)
    return image.convert("RGB"), None


class Upscaler:
    mode = "qwen"
    label = "upscale"
    runner_name = "spandrel"

    def __init__(self, path=None):
        self.path = path or os.environ.get("ZERO_UPSCALER", "")
        self.model = os.environ.get("ZERO_UPSCALER_ID", UPSCALE_MODEL)
        self.lock = RLock()
        self.net = None

    def missing(self):
        return [] if self.path and Path(self.path).is_file() else ["upscaling model"]

    def _load(self):
        import torch
        from spandrel import ImageModelDescriptor, ModelLoader
        net = ModelLoader().load_from_file(self.path)
        if not isinstance(net, ImageModelDescriptor):
            raise RuntimeError("The upscaling file is not an image model.")
        device = "cuda" if torch.cuda.is_available() else "cpu"
        net.to(device).eval()
        if device == "cuda":
            net.half() if net.supports_half else net.bfloat16()
        return net

    def _tiled(self, net, image, cancelled, progress, tile=512, overlap=32):
        """Run the model in overlapping tiles with linear blending (seamless, bounded memory)."""
        import numpy as np
        import torch
        s = net.scale
        param = next(net.model.parameters())
        x = torch.from_numpy(np.asarray(image, dtype=np.uint8).copy()).permute(2, 0, 1)[None].to(param.device, param.dtype) / 255
        _, _, H, W = x.shape
        out = torch.zeros((1, 3, H * s, W * s), device=param.device)
        weight = torch.zeros_like(out[:, :1])
        step = tile - overlap
        ys = list(range(0, max(H - overlap, 1), step))
        xs = list(range(0, max(W - overlap, 1), step))
        done, total = 0, len(ys) * len(xs)
        with torch.inference_mode():
            for y0 in ys:
                for x0 in xs:
                    if cancelled.is_set():
                        raise Cancelled()
                    y1, x1 = min(y0 + tile, H), min(x0 + tile, W)
                    y0_, x0_ = max(y1 - tile, 0), max(x1 - tile, 0)
                    t = net(x[:, :, y0_:y1, x0_:x1]).float()
                    th, tw = t.shape[-2:]
                    ry = torch.ones(th, device=param.device)
                    rx = torch.ones(tw, device=param.device)
                    f = overlap * s
                    ramp = torch.linspace(0, 1, f + 2, device=param.device)[1:-1]
                    if y0_ > 0: ry[:f] = ramp
                    if y1 < H: ry[-f:] = ramp.flip(0)
                    if x0_ > 0: rx[:f] = ramp
                    if x1 < W: rx[-f:] = ramp.flip(0)
                    m = (ry[:, None] * rx[None])[None, None]
                    out[:, :, y0_ * s:y1 * s, x0_ * s:x1 * s] += t * m
                    weight[:, :, y0_ * s:y1 * s, x0_ * s:x1 * s] += m
                    done += 1
                    progress(round(done * 100 / total), f"Upscaling tile {done} of {total}…")
        result = (out / weight.clamp_min(1e-6)).clamp(0, 1)[0].permute(1, 2, 0).cpu().numpy()
        return Image.fromarray((result * 255).round().astype("uint8"))

    def upscale(self, request, image: Image.Image, output: Path, cancelled, progress):
        check_upscale_size(image.width, image.height, request.scale)
        rgb, alpha = split_alpha(image)
        with self.lock:
            if self.net is None:
                progress(None, "Loading the upscaling model…")
                self.net = self._load()
            big = self._tiled(self.net, rgb, cancelled, progress)
            if not helpers_resident():
                self.net = None
                free_torch()
        size = upscaled_size(image.width, image.height, request.scale)
        if big.size != size:
            big = big.resize(size, Image.LANCZOS)
        if alpha is not None:
            big = big.convert("RGBA")
            big.putalpha(alpha.resize(size, Image.LANCZOS))
        big.save(output)


class DemoUpscaler:
    mode = "demo"
    label = "upscale"
    model = "studio-zero/demo-upscale"
    runner_name = "procedural"

    def missing(self):
        return []

    def upscale(self, request, image: Image.Image, output: Path, cancelled, progress):
        check_upscale_size(image.width, image.height, request.scale)
        big = image.convert("RGBA").resize(upscaled_size(image.width, image.height, request.scale), Image.LANCZOS)
        ImageDraw.Draw(big).text((8, 8), "DEMO UPSCALE - NOT AI", fill=(255, 64, 64, 255))
        big.save(output)


# Pose -------------------------------------------------------------------------------------
def draw_pose(people, width: int, height: int, threshold=0.3) -> Image.Image:
    """The standard OpenPose-18 skeleton picture (black background) for a list of keypoint lists."""
    canvas = Image.new("RGB", (width, height), (0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    stick = max(2, round(min(width, height) / 160))
    for person in people:
        for i, (a, b) in enumerate(LIMBS):
            pa, pb = person[a], person[b]
            if pa[2] < threshold or pb[2] < threshold:
                continue
            color = tuple(int(c * 0.6) for c in COLORS[i])
            draw.line([(pa[0], pa[1]), (pb[0], pb[1])], fill=color, width=stick * 2)
        for i, (x, y, c) in enumerate(person[:18]):
            if c >= threshold:
                draw.ellipse([x - stick, y - stick, x + stick, y + stick], fill=COLORS[i])
    return canvas


class PoseDetector:
    mode = "qwen"
    label = "pose"

    def __init__(self, pose_path=None, detector_path=None):
        self.pose_path = pose_path or os.environ.get("ZERO_POSE_MODEL", "")
        self.detector_path = detector_path or os.environ.get("ZERO_POSE_DETECTOR", "")
        self.model = os.environ.get("ZERO_POSE_MODEL_ID", POSE_MODEL)
        self.lock = RLock()
        self.models = None
        self.device = None

    def missing(self):
        ok = all(p and Path(p).is_file() for p in (self.pose_path, self.detector_path))
        return [] if ok else ["pose model"]

    def _load(self):
        import onnxruntime as ort
        from rtmlib import YOLOX, RTMPose
        if hasattr(ort, "preload_dlls"):
            try:
                ort.preload_dlls()
            except Exception:
                pass
        device = "cuda" if "CUDAExecutionProvider" in ort.get_available_providers() else "cpu"
        # det_mode="multiclass" returns class ids too: the COCO detector would otherwise put skeletons on chairs.
        detector = YOLOX(self.detector_path, model_input_size=(640, 640), det_mode="multiclass", score_thr=0.5,
                         backend="onnxruntime", device=device)
        pose = RTMPose(self.pose_path, model_input_size=(288, 384), to_openpose=True, backend="onnxruntime", device=device)
        return (detector, pose), device

    def detect(self, image: Image.Image) -> dict:
        import numpy as np
        rgb = image.convert("RGB")
        bgr = np.ascontiguousarray(np.asarray(rgb)[:, :, ::-1])
        with self.lock:
            if self.models is None:
                self.models, self.device = self._load()
            detector, pose = self.models
            found = detector(bgr)
            boxes, classes = (found if isinstance(found, tuple) else (found, None))
            boxes = np.asarray(boxes).reshape(-1, 4)
            if classes is not None:
                boxes = boxes[np.asarray(classes).reshape(-1) == 0]  # people only (COCO class 0)
            people = []
            if len(boxes):
                keypoints, scores = pose(bgr, bboxes=boxes)
                for k, s in zip(np.asarray(keypoints)[:, :18], np.asarray(scores)[:, :18]):
                    people.append([[round(float(x), 1), round(float(y), 1), round(float(c), 3)] for (x, y), c in zip(k, s)])
            if not helpers_resident():
                self.models = None
        people.sort(key=lambda p: -sum(c for _, _, c in p))
        return {"width": rgb.width, "height": rgb.height, "people": people[:6], "model": self.model, "device": self.device}


# A standing figure in a 1 × 2 box (x, y as fractions), used by the demo detector and the studio's presets.
STANDING = [(0.5, 0.11), (0.5, 0.2), (0.38, 0.21), (0.33, 0.36), (0.31, 0.5), (0.62, 0.21), (0.67, 0.36),
            (0.69, 0.5), (0.43, 0.5), (0.43, 0.7), (0.43, 0.9), (0.57, 0.5), (0.57, 0.7), (0.57, 0.9),
            (0.48, 0.095), (0.52, 0.095), (0.45, 0.105), (0.55, 0.105)]


class DemoPoseDetector:
    mode = "demo"
    label = "pose"
    model = "studio-zero/demo-pose"
    device = "cpu"

    def missing(self):
        return []

    def detect(self, image: Image.Image) -> dict:
        w, h = image.size
        box_h = h * 0.9
        box_w = box_h / 2
        left, top = (w - box_w) / 2, h * 0.05
        person = [[round(left + x * box_w, 1), round(top + y * box_h, 1), 0.9] for x, y in STANDING]
        return {"width": w, "height": h, "people": [person], "model": self.model, "device": self.device}
