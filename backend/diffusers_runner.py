"""Fast image engine: Qwen-Image 2.1 in diffusers with the Fun-Acc 4-step adapter.

Why a second image engine: Alibaba's Fun-Acc speed-up is Parallel Decoding Distillation (PDD), which
needs its own loader and scheduler (`qwenimage21_pdd.py`, `lora_utils_pdd.py`, downloaded at run time
from alibaba-pai/Qwen-Image-2.1-Fun-Acc-LoRAs) on top of the native diffusers pipeline — it is not a
plain LoRA that stable-diffusion.cpp could apply. 4 steps instead of ~40.

Weights: the uncensored UC GGUF (the same file the stable-diffusion.cpp engine uses) is dequantized to
BF16 and loaded as the transformer; Qwen/Qwen-Image-2.1 supplies only the text encoder, VAE, processor
and configs ("companion" directory). Without ZERO_DIFFUSION the companion's own transformer is used.

Edits: the pipeline has no mask/strength inputs, so inpaint, outpaint and image-to-image blend the
source's latents back in at every step boundary (flow matching: x_σ = (1 − σ)·x₀ + σ·ε). Masked areas
(white) are generated; the rest follows the source exactly. Image-to-image starts from the first step
boundary at or below `strength`. Instruction edits condition on the source as reference image 1.

All torch calls go through `TorchOps`, so the scheduling logic is testable without torch.
"""
import gc
import os
import secrets
import sys
import time
from contextlib import nullcontext
from pathlib import Path
from threading import RLock, Thread

import numpy as np
from PIL import Image

from .runner import Cancelled, gpu_memory_gib, transparent_prompt
from .schema import decode_image_data

DIFFUSERS_REVISION = "9f1246971270c84dcbe71233edb7a519596a5d02"
FAST_STEPS = 4


class TorchOps:
    """The few tensor operations the runner needs, on torch."""

    def __init__(self):
        import torch
        self.torch = torch

    def inference(self):
        return self.torch.inference_mode()

    def generator(self, seed):
        return self.torch.Generator("cpu").manual_seed(int(seed))

    def randn_like(self, like, generator):
        noise = self.torch.randn(tuple(like.shape), generator=generator, dtype=self.torch.float32)
        return noise.to(device=like.device, dtype=like.dtype)

    def vae_input(self, pipe, image, width, height):
        tensor = pipe.image_processor.preprocess(image, width=width, height=height).unsqueeze(2)
        return tensor.to(device=pipe._execution_device, dtype=pipe.vae.dtype)

    def from_numpy(self, array, like):
        return self.torch.from_numpy(np.ascontiguousarray(array)).to(device=like.device, dtype=like.dtype)

    def free(self):
        gc.collect()
        if self.torch.cuda.is_available():
            self.torch.cuda.empty_cache()


def latent_mask(mask: Image.Image, width: int, height: int):
    """Engine mask (white = regenerate) → (1, width·height, 1) float array on the latent grid.
    A latent cell regenerates if any pixel inside it is marked (like stable-diffusion.cpp's NearestMax)."""
    grey = np.asarray(mask.convert("L"), dtype=np.float32) / 255.0
    rows = np.array_split(np.arange(grey.shape[0]), height)
    cols = np.array_split(np.arange(grey.shape[1]), width)
    cells = np.zeros((height, width), dtype=np.float32)
    for y, r in enumerate(rows):
        block = grey[r[0]:r[-1] + 1]
        for x, c in enumerate(cols):
            cells[y, x] = 1.0 if block[:, c[0]:c[-1] + 1].max() > 0.5 else 0.0
    return cells.reshape(1, height * width, 1)


def start_index(sigmas, strength):
    """First step boundary at or below `strength` (at least one real step remains)."""
    values = [float(s) for s in sigmas]
    if strength >= 0.999:
        return 0
    for k, s in enumerate(values):
        if s <= strength:
            return max(1, min(k, len(values) - 2))
    return len(values) - 2


class LatentBlend:
    """Keeps the source's latents where the mask is 0, at the noise level of each step boundary."""

    def __init__(self, x0, noise, mask=None, strength=1.0):
        self.x0, self.noise, self.mask, self.strength = x0, noise, mask, strength
        self.start = None

    def known(self, sigma):
        return self.x0 * (1 - sigma) + self.noise * sigma

    def __call__(self, pipe, i, t, kwargs):
        sigmas = pipe.scheduler.sigmas
        if self.start is None:
            self.start = start_index(sigmas, self.strength)
        sigma = float(sigmas[i + 1])
        latents = kwargs["latents"]
        known = self.known(sigma)
        if i + 1 <= self.start:
            blended = known                       # still before the chosen starting noise level
        elif self.mask is None:
            return {}
        else:
            blended = self.mask * latents + (1 - self.mask) * known
        return {"latents": blended}


class DiffusersQwenRunner:
    mode = "qwen"
    runner_name = "diffusers"
    runner_revision = DIFFUSERS_REVISION
    label = "image"
    supports_edit = True
    supports_transparency = True
    supports_references = True

    def __init__(self, loader=None, ops=None):
        self.model = os.environ.get("ZERO_MODEL_ID", "Qwen-Image-2.1 (diffusers)")
        self.gguf = os.environ.get("ZERO_DIFFUSION", "")
        self.companion = os.environ.get("ZERO_DIFFUSERS_COMPANION", "")
        self.fast_lora = os.environ.get("ZERO_FAST_LORA", "")
        self.fast_code = os.environ.get("ZERO_FAST_CODE", "") or (str(Path(self.fast_lora).parent.parent) if self.fast_lora else "")
        self.fast = bool(self.fast_lora)
        self.load_timeout = int(os.environ.get("ZERO_ENGINE_LOAD_TIMEOUT", "1800"))
        self.loader = loader or self._load
        self._ops = ops
        self.lock = RLock()
        self.pipe = None
        self.pdd = None
        self.status, self.detail, self.loaded_in, self.last_start = "stopped", "", None, 0.0
        self.placement = None
        self._generation = 0

    @property
    def ops(self):
        if self._ops is None:
            self._ops = TorchOps()
        return self._ops

    @property
    def ready_message(self):
        return ("Fast Qwen engine ready — 4 steps per image, model kept in memory" if self.fast
                else "Qwen engine (diffusers) ready — model kept in memory")

    # Configuration -------------------------------------------------------------
    def missing(self):
        problems = []
        if not self.companion or not (Path(self.companion) / "model_index.json").is_file():
            problems.append("companion model folder (text encoder, VAE)")
        if self.gguf and not Path(self.gguf).is_file():
            problems.append("diffusion weights")
        if self.fast:
            if not Path(self.fast_lora).is_file() or not (Path(self.fast_lora).parent / "pdd_config.json").is_file():
                problems.append("Fun-Acc 4-step adapter")
            for name in ("qwenimage21_pdd.py", "lora_utils_pdd.py"):
                if not (Path(self.fast_code) / name).is_file():
                    problems.append(name)
        return problems

    def weight_bytes(self):
        """Approximate resident size in BF16: text encoder + transformer + VAE."""
        total = 0
        root = Path(self.companion) if self.companion else None
        for folder in ("text_encoder", "vae"):
            if root and (root / folder).is_dir():
                total += sum(f.stat().st_size for f in (root / folder).glob("*.safetensors"))
        if self.gguf and Path(self.gguf).is_file():
            total += 14.3e9  # the transformer is dequantized to BF16
        elif root and (root / "transformer").is_dir():
            total += sum(f.stat().st_size for f in (root / "transformer").glob("*.safetensors"))
        return total

    def choose_placement(self):
        """cuda (all on the GPU) · model (one component at a time) · sequential (smallest GPUs)."""
        mode = os.environ.get("ZERO_OFFLOAD", "auto").strip().lower()
        if mode in ("0", "off", "false", "no"):
            return "cuda"
        vram = gpu_memory_gib()
        if mode in ("1", "on", "true", "yes"):
            return "model" if vram is None or vram >= 20 else "sequential"
        if vram is None:
            return "model"
        headroom = float(os.environ.get("ZERO_VRAM_HEADROOM_GIB", "6"))
        if self.weight_bytes() / 2**30 + headroom <= vram:
            return "cuda"
        return "model" if vram >= 20 else "sequential"

    @property
    def offload(self):
        return self.placement not in (None, "cuda")

    # Lifecycle ---------------------------------------------------------------------
    def start(self):
        with self.lock:
            if self.status in ("loading", "ready") or self.missing():
                return
            self.status, self.detail, self.loaded_in = "loading", "", None
            self.last_start = time.monotonic()
            self._generation += 1
            generation = self._generation
        Thread(target=self._load_thread, args=(generation,), daemon=True, name="studio-zero-diffusers").start()

    def _load_thread(self, generation):
        started = time.monotonic()
        try:
            pipe, pdd = self.loader()
        except Exception as exc:  # report, never crash the API
            with self.lock:
                if generation == self._generation:
                    self.status, self.detail = "failed", f"The fast engine could not load: {type(exc).__name__}: {exc}"[:600]
            return
        with self.lock:
            if generation != self._generation:  # stopped meanwhile
                return
            self.pipe, self.pdd = pipe, pdd
            self.status, self.loaded_in = "ready", round(time.monotonic() - started, 1)

    def _load(self):
        import torch
        from diffusers import QwenImage21Pipeline, QwenImage21Transformer2DModel
        transformer = None
        if self.gguf:
            from accelerate import init_empty_weights
            from diffusers.models.model_loading_utils import load_gguf_checkpoint
            from diffusers.quantizers.gguf.utils import dequantize_gguf_tensor
            weights = load_gguf_checkpoint(self.gguf)
            for name in list(weights):
                weights[name] = dequantize_gguf_tensor(weights[name]).to(torch.bfloat16)
            config = QwenImage21Transformer2DModel.load_config(self.companion, subfolder="transformer")
            with init_empty_weights():
                transformer = QwenImage21Transformer2DModel.from_config(config)
            transformer.load_state_dict(weights, strict=True, assign=True)
            transformer.eval().requires_grad_(False)
            del weights
        kwargs = {"torch_dtype": torch.bfloat16}
        if transformer is not None:
            kwargs["transformer"] = transformer
        pipe = QwenImage21Pipeline.from_pretrained(self.companion, **kwargs)
        pdd = None
        if self.fast:
            if self.fast_code not in sys.path:
                sys.path.insert(0, self.fast_code)
            import qwenimage21_pdd as module
            config = module.load_pdd_lora(pipe.transformer, self.fast_lora)
            pipe.transformer.eval()
            pipe.scheduler = module.QwenImage21PDDScheduler.from_config(pipe.scheduler.config)
            pipe.scheduler.register_to_config(**config)
            pdd = {"module": module, "config": config, "sigmas": torch.tensor(config["pdd_sigmas"], dtype=torch.float32)}
        self.placement = self.choose_placement()
        if self.placement == "cuda":
            pipe.to("cuda")
        elif self.placement == "model":
            pipe.enable_model_cpu_offload()
        else:
            pipe.enable_sequential_cpu_offload()
        return pipe, pdd

    def stop(self):
        with self.lock:
            self._generation += 1
            pipe, self.pipe, self.pdd = self.pipe, None, None
            self.status = "stopped"
        if pipe is not None:
            del pipe
            if self._ops is not None or "torch" in sys.modules:
                self.ops.free()

    def state(self):
        with self.lock:
            return {"engine": self.status, "loaded_in_seconds": self.loaded_in}

    def readiness(self):
        missing = self.missing()
        if missing:
            return False, "Configure missing " + ", ".join(missing)
        status = self.state()["engine"]
        if status == "stopped" or (status == "failed" and time.monotonic() - self.last_start > 60):
            self.start()
            status = self.state()["engine"]
        if status == "ready":
            return True, self.ready_message
        if status == "loading":
            return False, "Loading the fast image model into memory. This happens once per engine start."
        return False, self.detail or "The fast image engine is not running."

    # Generation ---------------------------------------------------------------------
    def _encode(self, image, width, height, generator):
        pipe = self.pipe
        encoded = pipe._encode_vae_image(self.ops.vae_input(pipe, image, width, height), generator)
        channels, h, w = encoded.shape[1], encoded.shape[3], encoded.shape[4]
        return pipe._pack_latents(encoded, 1, channels, h, w), h, w

    def _run(self, prompt, request, cancelled, progress, images=None, source=None, mask=None, strength=1.0):
        ready, message = self.readiness()
        if not ready:
            raise RuntimeError(message)
        pipe, pdd, ops = self.pipe, self.pdd, self.ops
        seed = request.seed if request.seed >= 0 else secrets.randbelow(2147483647)
        steps = FAST_STEPS if pdd else request.steps
        callbacks = []
        if pdd:
            callbacks.append(pdd["module"].pdd_step_callback(pipe.transformer, pdd["sigmas"], pdd["config"]["pdd_block_size"]))
        kwargs = {"prompt": prompt, "height": request.height, "width": request.width, "num_inference_steps": steps,
                  "generator": ops.generator(seed), "output_type": "pil",
                  "callback_on_step_end_tensor_inputs": ["latents"]}
        if pdd:
            kwargs.update(true_cfg_scale=1.0, use_kv_cache=False)
        elif request.negative_prompt.strip() and request.guidance > 1:
            kwargs.update(true_cfg_scale=float(request.guidance), negative_prompt=request.negative_prompt)
        if images:
            kwargs.update(image=images, output_resolution=1024)
        with ops.inference():
            if source is not None:
                x0, h, w = self._encode(source, request.width, request.height, ops.generator(seed))
                noise = ops.randn_like(x0, ops.generator(seed + 1))
                blend_mask = ops.from_numpy(latent_mask(mask, w, h), x0) if mask is not None else None
                callbacks.append(LatentBlend(x0, noise, blend_mask, strength))
                kwargs["latents"] = noise
            def on_step(p, i, t, values):
                out = {}
                for callback in callbacks:
                    out.update(callback(p, i, t, {**values, **out}) or {})
                progress(round((i + 1) * 100 / steps), f"Step {i + 1} of {steps}…")
                if cancelled.is_set():
                    p._interrupt = True
                return out
            kwargs["callback_on_step_end"] = on_step
            image = pipe(**kwargs).images[0]
        if cancelled.is_set():
            raise Cancelled()
        return image

    @staticmethod
    def _images(values):
        return [decode_image_data(v).convert("RGBA") for v in values]

    def generate(self, request, output, cancelled, progress):
        prompt = transparent_prompt(request.prompt) if request.transparent else request.prompt
        image = self._run(prompt, request, cancelled, progress, images=self._images(request.reference_images) or None)
        image.save(output)

    def edit(self, request, output, cancelled, progress):
        prompt = transparent_prompt(request.prompt) if request.transparent else request.prompt
        source = decode_image_data(request.image).convert("RGBA")
        references = self._images(request.reference_images)
        if request.operation == "edit":
            image = self._run(prompt, request, cancelled, progress, images=[source, *references])
        elif request.operation in ("inpaint", "outpaint"):
            mask = decode_image_data(request.mask)
            image = self._run(prompt, request, cancelled, progress, images=[source, *references], source=source, mask=mask)
        else:
            image = self._run(prompt, request, cancelled, progress, images=references or None, source=source,
                              strength=request.effective_strength)
        image.save(output)
