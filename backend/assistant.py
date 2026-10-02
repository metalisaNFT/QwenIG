"""Prompt helper: turn a short idea into a detailed prompt, and describe an image as a prompt.

Local model: Qwen3-VL-2B-Instruct (vision + text, Apache-2.0), loaded on first use.
Optional: with DEEPSEEK_API_KEY set, prompt rewriting uses DeepSeek's API (V4 Flash family) instead;
image description always stays local. Nothing else leaves the engine.
"""
import os
import re
from pathlib import Path
from threading import RLock

from PIL import Image, ImageStat

from .audio import free_torch, helpers_resident

VL_MODEL = "Qwen/Qwen3-VL-2B-Instruct"

REWRITE = {
    "image": ("You write prompts for a text-to-image model. Expand the user's idea into one vivid, concrete paragraph "
              "of 60 to 120 words: subject, setting, composition, lighting, colour palette, style or medium, and camera "
              "or lens when it fits. Keep every detail the user gave and do not contradict it. Add no text or lettering "
              "unless asked. Reply with the prompt only."),
    "edit": ("You write instructions for an AI image editor. Rewrite the user's request as one or two clear sentences "
             "that say exactly what to change and what must stay the same. Reply with the instruction only."),
    "video": ("You write prompts for a text/image-to-video model that also generates sound. Expand the user's idea into "
              "60 to 120 words describing the subject, the motion over time, camera movement, pacing, lighting, and the "
              "ambient sound or dialogue. Reply with the prompt only."),
    "music": ("You write descriptions for a song generator. Turn the user's idea into at most 60 words covering genre, "
              "BPM, key, mood and how it develops, the vocals (gender, timbre, delivery) and the arrangement. "
              "Reply with the description only."),
}

DESCRIBE = {
    "image": ("Describe this image as a text-to-image prompt that would recreate it: subject, setting, composition, "
              "lighting, colours, and style or medium. One paragraph, no preamble."),
    "video": ("Write a short image-to-video prompt that brings this image to life: what moves and how, the camera "
              "movement, and the ambient sound. Two or three sentences, no preamble."),
    "caption": "Describe this image in one or two plain sentences.",
}


def clean(text: str) -> str:
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()
    text = re.sub(r"^(prompt|instruction|description|rewritten prompt)\s*:\s*", "", text, flags=re.I).strip()
    if len(text) > 1 and text[0] == text[-1] and text[0] in "\"'“”":
        text = text[1:-1].strip()
    return text.strip("“”").strip()


class PromptHelper:
    mode = "qwen"
    label = "assistant"

    def __init__(self, model_dir=None, api_key=None, client=None):
        self.path = model_dir or os.environ.get("ZERO_VL", "")
        self.model = os.environ.get("ZERO_VL_ID", VL_MODEL)
        self.api_key = api_key if api_key is not None else os.environ.get("DEEPSEEK_API_KEY", "")
        self.api_model = os.environ.get("ZERO_DEEPSEEK_MODEL", "deepseek-flash")
        self.api_base = os.environ.get("ZERO_DEEPSEEK_BASE", "https://api.deepseek.com")
        self.client = client
        self.lock = RLock()
        self.vl = None

    def missing(self):
        if self.path and (Path(self.path) / "config.json").is_file():
            return []
        return ["vision-language model"]

    @property
    def rewriter(self):
        return f"DeepSeek API ({self.api_model})" if self.api_key else self.model

    # Local model ---------------------------------------------------------------------
    def _load(self):
        import torch
        from transformers import AutoProcessor, Qwen3VLForConditionalGeneration
        model = Qwen3VLForConditionalGeneration.from_pretrained(
            self.path, dtype=torch.bfloat16, device_map="cuda" if torch.cuda.is_available() else "cpu")
        return model, AutoProcessor.from_pretrained(self.path)

    def _local(self, system, content, max_new_tokens=320):
        import torch
        with self.lock:
            if self.vl is None:
                self.vl = self._load()
            model, processor = self.vl
            messages = [{"role": "system", "content": [{"type": "text", "text": system}]},
                        {"role": "user", "content": content}]
            inputs = processor.apply_chat_template(messages, tokenize=True, add_generation_prompt=True,
                                                   return_dict=True, return_tensors="pt").to(model.device)
            with torch.inference_mode():
                ids = model.generate(**inputs, max_new_tokens=max_new_tokens, do_sample=True, temperature=0.7,
                                     top_p=0.8, top_k=20)
            text = processor.batch_decode(ids[:, inputs["input_ids"].shape[1]:], skip_special_tokens=True)[0]
            if not helpers_resident():
                self.vl = None
                free_torch()
        return clean(text)

    def _api(self, system, prompt):
        import httpx
        client = self.client or httpx.Client(timeout=90)
        response = client.post(f"{self.api_base}/chat/completions",
                               headers={"Authorization": f"Bearer {self.api_key}"},
                               json={"model": self.api_model, "temperature": 0.7, "max_tokens": 600,
                                     "thinking": {"type": "disabled"},
                                     "messages": [{"role": "system", "content": system},
                                                  {"role": "user", "content": prompt}]})
        if response.status_code >= 400:
            raise RuntimeError(f"DeepSeek API returned {response.status_code}. Check the DEEPSEEK_API_KEY secret.")
        return clean(response.json()["choices"][0]["message"]["content"])

    # Public --------------------------------------------------------------------------
    def enhance(self, prompt: str, target: str) -> dict:
        system = REWRITE[target]
        if self.api_key:
            try:
                return {"prompt": self._api(system, prompt), "model": self.rewriter}
            except Exception as exc:
                if self.missing():
                    raise RuntimeError(str(exc)) from None
        if self.missing():
            raise RuntimeError("The prompt helper needs its model. Turn on ENABLE_ASSISTANT in the notebook.")
        return {"prompt": self._local(system, [{"type": "text", "text": prompt}]), "model": self.model}

    def describe(self, image: Image.Image, purpose: str) -> dict:
        if self.missing():
            raise RuntimeError("Describing images needs the vision model. Turn on ENABLE_ASSISTANT in the notebook.")
        image = image.convert("RGB")
        image.thumbnail((1024, 1024))
        text = self._local(DESCRIBE[purpose], [{"type": "image", "image": image},
                                               {"type": "text", "text": DESCRIBE[purpose]}])
        return {"prompt": text, "model": self.model}


class DemoPromptHelper:
    mode = "demo"
    label = "assistant"
    model = "studio-zero/demo-assistant"
    rewriter = model

    def missing(self):
        return []

    def enhance(self, prompt: str, target: str) -> dict:
        extra = {"image": "detailed, soft natural light, balanced composition",
                 "edit": "keep everything else unchanged",
                 "video": "slow camera push-in, gentle ambient sound",
                 "music": "mid-tempo, warm vocals, building chorus"}[target]
        return {"prompt": f"{prompt.strip().rstrip('.')}, {extra} (DEMO - NOT AI)", "model": self.model}

    def describe(self, image: Image.Image, purpose: str) -> dict:
        r, g, b = [int(v) for v in ImageStat.Stat(image.convert("RGB")).mean]
        tone = max((("red", r), ("green", g), ("blue", b)), key=lambda x: x[1])[0]
        light = "bright" if (r + g + b) / 3 > 140 else "dark"
        return {"prompt": f"A {light} {image.width}x{image.height} image with mostly {tone} tones (DEMO DESCRIPTION - NOT AI)",
                "model": self.model}
