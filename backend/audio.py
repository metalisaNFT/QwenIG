"""Speech-to-text, voice cloning and music.

Transcriber   faster-whisper (CTranslate2). GPU when the CUDA 12 libraries load, otherwise CPU int8.
Speaker       Chatterbox Turbo (English, voice cloning from a reference clip over 5 seconds, 24 kHz).
MusicRunner   MiniMax Music 3 (diffusers modular pipeline): songs with vocals up to five minutes.

The small helpers load on first use and stay loaded when the GPU is large; the music model is a
resident engine managed by EngineSet like the image and video engines. Each has a Demo twin that
needs no weights, so the studio and its tests run anywhere.
"""
import ctypes
import glob
import io
import json
import math
import os
import re
import secrets
import shutil
import site
import struct
import subprocess
import sys
import tempfile
import time
import wave
from pathlib import Path
from threading import RLock, Thread

from .runner import Cancelled, find_ffmpeg, gpu_memory_gib

MUSIC_MODEL = "MiniMaxAI/MiniMax-Music3"
TTS_MODEL = "ResembleAI/chatterbox-turbo"
WHISPER_MODEL = "Systran/faster-whisper-base"


# Audio files ------------------------------------------------------------------------------
def to_wav(data: bytes, output: Path, rate=16000, channels=1, max_seconds=None):
    """Decode any audio (or a video's sound track) to PCM WAV with ffmpeg."""
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise RuntimeError("ffmpeg is needed to read audio. Install it on the engine host.")
    with tempfile.NamedTemporaryFile(suffix=".bin", delete=False) as source:
        source.write(data)
    try:
        command = [ffmpeg, "-v", "error", "-y", "-i", source.name, "-vn", "-ac", str(channels), "-ar", str(rate)]
        if max_seconds:
            command += ["-t", str(max_seconds)]
        result = subprocess.run(command + ["-c:a", "pcm_s16le", str(output)], capture_output=True, text=True, timeout=600)
        if result.returncode or not output.is_file() or output.stat().st_size <= 44:
            raise RuntimeError("Could not read this audio. Use WAV, MP3, M4A, OGG, WebM, FLAC or a video with sound.")
    finally:
        os.unlink(source.name)
    return output


def audio_format():
    """mp3 keeps projects small; wav when ffmpeg is missing or ZERO_AUDIO_FORMAT=wav."""
    wanted = os.environ.get("ZERO_AUDIO_FORMAT", "mp3").lower()
    return "mp3" if wanted == "mp3" and find_ffmpeg() else "wav"


def finish_audio(raw: Path, output: Path, fmt: str):
    """Move the engine's WAV into place, encoding it to MP3 when asked."""
    if fmt == "wav":
        raw.replace(output)
        return
    result = subprocess.run([find_ffmpeg(), "-v", "error", "-y", "-i", str(raw), "-c:a", "libmp3lame", "-b:a", "192k", str(output)],
                            capture_output=True, text=True, timeout=600)
    raw.unlink(missing_ok=True)
    if result.returncode or not output.is_file():
        raise RuntimeError("Could not encode the audio as MP3.")


def read_pcm(path: Path):
    """A 16-bit mono WAV as float32 samples in [-1, 1]."""
    import numpy as np
    with wave.open(str(path), "rb") as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768


def wav_seconds(path: Path) -> float:
    with wave.open(str(path), "rb") as w:
        return w.getnframes() / float(w.getframerate())


def write_wav(path: Path, samples, rate: int):
    """Write float samples in [-1, 1]: a list (mono) or a list of per-channel lists."""
    channels = samples if samples and isinstance(samples[0], (list, tuple)) else [samples]
    frames = bytearray()
    for i in range(len(channels[0])):
        for channel in channels:
            frames += struct.pack("<h", int(max(-1.0, min(1.0, channel[i])) * 32767))
    with wave.open(str(path), "wb") as w:
        w.setnchannels(len(channels)); w.setsampwidth(2); w.setframerate(rate)
        w.writeframes(bytes(frames))


def write_array_wav(path: Path, audio, rate: int):
    """Write a numpy array shaped (samples,) or (channels, samples) as 16-bit WAV."""
    import numpy as np
    audio = np.asarray(audio, dtype=np.float32)
    if audio.ndim == 1:
        audio = audio[None, :]
    if audio.shape[0] > audio.shape[-1]:  # (samples, channels)
        audio = audio.T
    pcm = (np.clip(audio, -1, 1) * 32767).astype("<i2").T.copy()
    with wave.open(str(path), "wb") as w:
        w.setnchannels(pcm.shape[1]); w.setsampwidth(2); w.setframerate(int(rate))
        w.writeframes(pcm.tobytes())


def srt(segments) -> str:
    def stamp(t):
        ms = int(round(t * 1000))
        return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"
    return "\n".join(f"{i}\n{stamp(s['start'])} --> {stamp(s['end'])}\n{s['text'].strip()}\n"
                     for i, s in enumerate(segments, 1))


def split_sentences(text: str, limit=280):
    """Chunks under `limit` characters, cut at sentence ends where possible (TTS handles short inputs best)."""
    parts, current = [], ""
    for sentence in re.split(r"(?<=[.!?…])\s+|\n+", text.strip()):
        sentence = sentence.strip()
        while len(sentence) > limit:
            cut = sentence.rfind(" ", 0, limit)
            cut = cut if cut > limit // 2 else limit
            if current:
                parts.append(current); current = ""
            parts.append(sentence[:cut].strip()); sentence = sentence[cut:].strip()
        if not sentence:
            continue
        if current and len(current) + 1 + len(sentence) > limit:
            parts.append(current); current = sentence
        else:
            current = f"{current} {sentence}".strip()
    if current:
        parts.append(current)
    return parts


def helpers_resident():
    """Keep small helper models loaded on big GPUs; unload after each use on small ones."""
    mode = os.environ.get("ZERO_HELPERS_RESIDENT", "auto").lower()
    if mode in ("1", "on", "true", "yes"):
        return True
    if mode in ("0", "off", "false", "no"):
        return False
    vram = gpu_memory_gib()
    return vram is not None and vram >= 40


def free_torch():
    if "torch" in sys.modules:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()


_cuda12 = []


def preload_cuda12():
    """CTranslate2 needs cuBLAS 12 and cuDNN 9; on Colab they come from pip NVIDIA packages torch installed."""
    if _cuda12:
        return _cuda12[0]
    ok = False
    try:
        roots = [p for p in site.getsitepackages() + [site.getusersitepackages()] if p]
        names = ["cublas/lib/libcublasLt.so.12", "cublas/lib/libcublas.so.12", "cudnn/lib/libcudnn.so.9"]
        for name in names:
            for root in roots:
                hits = glob.glob(os.path.join(root, "nvidia", name))
                if hits:
                    ctypes.CDLL(hits[0], mode=ctypes.RTLD_GLOBAL)
                    break
        for extra in ("cudnn/lib/libcudnn_ops.so.9", "cudnn/lib/libcudnn_cnn.so.9"):
            for root in roots:
                hits = glob.glob(os.path.join(root, "nvidia", extra))
                if hits:
                    ctypes.CDLL(hits[0], mode=ctypes.RTLD_GLOBAL)
                    break
        ok = True
    except OSError:
        ok = False
    _cuda12.append(ok)
    return ok


# Transcription ----------------------------------------------------------------------------
class Transcriber:
    mode = "qwen"
    label = "transcription"

    def __init__(self, model_dir=None):
        self.path = model_dir or os.environ.get("ZERO_WHISPER", "")
        self.model = os.environ.get("ZERO_WHISPER_ID", WHISPER_MODEL)
        self.lock = RLock()
        self.whisper = None
        self.device = None

    def missing(self):
        return [] if self.path and (Path(self.path) / "model.bin").is_file() else ["speech-to-text model"]

    def _load(self):
        from faster_whisper import WhisperModel
        preference = os.environ.get("ZERO_WHISPER_DEVICE", "auto")
        if preference != "cpu":
            try:
                preload_cuda12()
                model = WhisperModel(self.path, device="cuda", compute_type="float16")
                return model, "cuda"
            except Exception:
                if preference == "cuda":
                    raise
        return WhisperModel(self.path, device="cpu", compute_type="int8"), "cpu"

    def transcribe(self, data: bytes, language, cancelled, progress=lambda *a: None):
        with self.lock:
            if self.whisper is None:
                progress(None, "Loading the speech-to-text model…")
                self.whisper, self.device = self._load()
            with tempfile.TemporaryDirectory() as tmp:
                audio = to_wav(data, Path(tmp) / "audio.wav")
                total = max(wav_seconds(audio), 0.01)
                # Pass samples, not a path: faster-whisper's own PyAV decoding breaks on current PyAV
                # (it passes an option PyAV removed), and ffmpeg has already decoded the audio anyway.
                segments, info = self.whisper.transcribe(read_pcm(audio), language=language, beam_size=5, vad_filter=True)
                out = []
                for segment in segments:  # a lazy generator: the work happens while iterating
                    if cancelled.is_set():
                        raise Cancelled()
                    out.append({"start": round(segment.start, 2), "end": round(segment.end, 2), "text": segment.text.strip()})
                    progress(min(99, round(segment.end * 100 / total)), "Transcribing…")
            if not helpers_resident():
                self.whisper = None
                free_torch()
        text = " ".join(s["text"] for s in out).strip()
        return {"text": text, "language": info.language, "duration": round(total, 2), "segments": out,
                "srt": srt(out), "model": self.model, "device": self.device}


class DemoTranscriber:
    mode = "demo"
    label = "transcription"
    model = "studio-zero/demo-transcriber"
    device = "cpu"

    def missing(self):
        return []

    def transcribe(self, data: bytes, language, cancelled, progress=lambda *a: None):
        try:
            with wave.open(io.BytesIO(data), "rb") as w:
                total = w.getnframes() / float(w.getframerate())
        except (wave.Error, EOFError):
            total = max(1.0, len(data) / 16000)
        segments, t = [], 0.0
        while t < total and len(segments) < 200:
            end = min(total, t + 4)
            segments.append({"start": round(t, 2), "end": round(end, 2), "text": f"DEMO TRANSCRIPT - NOT AI ({len(segments) + 1})"})
            t = end
        return {"text": " ".join(s["text"] for s in segments), "language": language or "en", "duration": round(total, 2),
                "segments": segments, "srt": srt(segments), "model": self.model, "device": self.device}


# Voice --------------------------------------------------------------------------------------
def float32_loudness(tts):
    """Chatterbox expects NumPy < 2: there, loudness normalisation keeps float32 samples. Under NumPy 2
    (Colab's Python 3.13) a float64 gain promotes the clip to float64 and voice cloning fails in the
    speech tokenizer ("expected scalar type Float but found Double"). Cast the result back."""
    import numpy as np
    original = tts.norm_loudness
    tts.norm_loudness = lambda wav, sr, target_lufs=-27: np.asarray(original(wav, sr, target_lufs), dtype=np.float32)
    return tts


class Speaker:
    mode = "qwen"
    label = "voice"
    rate = 24000

    def __init__(self, model_dir=None):
        self.path = model_dir or os.environ.get("ZERO_TTS", "")
        self.model = os.environ.get("ZERO_TTS_ID", TTS_MODEL)
        self.lock = RLock()
        self.tts = None

    def missing(self):
        need = ("t3_turbo_v1.safetensors", "s3gen_meanflow.safetensors", "ve.safetensors", "conds.pt")
        if not self.path or not all((Path(self.path) / f).is_file() for f in need):
            return ["voice model"]
        return []

    def _load(self):
        import torch
        from chatterbox.tts_turbo import ChatterboxTurboTTS
        tts = ChatterboxTurboTTS.from_local(self.path, "cuda" if torch.cuda.is_available() else "cpu")
        return float32_loudness(tts)

    def speak(self, request, voice: bytes | None, output: Path, cancelled, progress=lambda *a: None):
        import numpy as np
        import torch
        with self.lock:
            if self.tts is None:
                progress(None, "Loading the voice model…")
                self.tts = self._load()
            with tempfile.TemporaryDirectory() as tmp:
                reference = None
                if voice is not None:
                    reference = to_wav(voice, Path(tmp) / "voice.wav", rate=self.rate, max_seconds=30)
                    if wav_seconds(reference) <= 5.0:
                        raise RuntimeError("The voice sample must be longer than 5 seconds (about 10 seconds works best).")
                seed = request.seed if request.seed >= 0 else secrets.randbelow(2147483647)
                torch.manual_seed(seed)
                chunks = split_sentences(request.text)
                pieces = []
                for i, chunk in enumerate(chunks):
                    if cancelled.is_set():
                        raise Cancelled()
                    progress(round(i * 100 / len(chunks)), f"Speaking part {i + 1} of {len(chunks)}…")
                    wav = self.tts.generate(chunk, audio_prompt_path=str(reference) if reference and i == 0 else None,
                                            temperature=request.temperature)
                    pieces.append(wav.squeeze(0).cpu().numpy())
                    pieces.append(np.zeros(int(self.rate * 0.18), dtype=np.float32))
                write_array_wav(output, np.concatenate(pieces[:-1]), self.tts.sr)
            if not helpers_resident():
                self.tts = None
                free_torch()


class DemoSpeaker:
    mode = "demo"
    label = "voice"
    model = "studio-zero/demo-voice"
    rate = 24000

    def missing(self):
        return []

    def speak(self, request, voice, output: Path, cancelled, progress=lambda *a: None):
        """A short beep per word: clearly synthetic, shaped like speech timing."""
        samples = []
        words = request.text.split()[:400]
        for i, word in enumerate(words):
            if cancelled.is_set():
                raise Cancelled()
            freq = 330 + (hash(word) % 7) * 40
            length = int(self.rate * min(0.45, 0.08 + 0.03 * len(word)))
            samples += [0.25 * math.sin(2 * math.pi * freq * n / self.rate) * math.sin(math.pi * n / length) for n in range(length)]
            samples += [0.0] * int(self.rate * 0.07)
        write_wav(output, samples or [0.0] * self.rate, self.rate)


# Music --------------------------------------------------------------------------------------
class MusicRunner:
    """MiniMax Music 3 kept in memory between songs; swapped with the image/video engines when needed."""
    mode = "qwen"
    label = "music"
    vram_gib = 24

    def __init__(self, model_dir=None, loader=None):
        self.path = model_dir or os.environ.get("ZERO_MUSIC", "")
        self.model = os.environ.get("ZERO_MUSIC_ID", MUSIC_MODEL)
        self.loader = loader or self._load
        self.lock = RLock()
        self.pipe = None
        self.status, self.detail, self.loaded_in, self.last_start = "stopped", "", None, 0.0
        self._generation = 0

    def missing(self):
        root = Path(self.path) if self.path else None
        if not root or not (root / "modular_model_index.json").is_file():
            return ["music model"]
        gone = [d for d in ("language_model", "transformer", "rvq_depth_decoder", "vocoder", "condition_encoder", "tokenizer")
                if not (root / d).is_dir()]
        return [f"music model ({', '.join(gone)})"] if gone else []

    def local_index(self):
        """The published index names the Hub repo for every component; point it at this folder instead."""
        index = Path(self.path) / "modular_model_index.json"
        config = json.loads(index.read_text(encoding="utf-8"))
        changed = False
        for name, value in config.items():
            if isinstance(value, list) and len(value) == 3 and isinstance(value[2], dict):
                if value[2].get("pretrained_model_name_or_path") != str(self.path):
                    value[2]["pretrained_model_name_or_path"] = str(self.path)
                    changed = True
        if changed:
            text = json.dumps(config, indent=2)
            if index.is_symlink():
                index.unlink()
            index.write_text(text, encoding="utf-8")
        return config

    def start(self):
        with self.lock:
            if self.status in ("loading", "ready") or self.missing():
                return
            self.status, self.detail, self.loaded_in = "loading", "", None
            self.last_start = time.monotonic()
            self._generation += 1
            generation = self._generation
        Thread(target=self._load_thread, args=(generation,), daemon=True, name="studio-zero-music").start()

    def _load_thread(self, generation):
        started = time.monotonic()
        try:
            pipe = self.loader()
        except Exception as exc:
            with self.lock:
                if generation == self._generation:
                    self.status, self.detail = "failed", f"The music model could not load: {type(exc).__name__}: {exc}"[:600]
            return
        with self.lock:
            if generation != self._generation:
                return
            self.pipe = pipe
            self.status, self.loaded_in = "ready", round(time.monotonic() - started, 1)

    def _load(self):
        import torch
        from diffusers import ModularPipeline
        self.local_index()
        pipe = ModularPipeline.from_pretrained(self.path)
        pipe.load_components(dtype=torch.bfloat16)
        vram = gpu_memory_gib()
        if vram is not None and vram < 30:
            from diffusers.hooks.group_offloading import apply_group_offloading
            apply_group_offloading(pipe.language_model, onload_device=torch.device("cuda"),
                                   offload_type="leaf_level", use_stream=True)
            for name in ("transformer", "rvq_depth_decoder", "vocoder", "condition_encoder"):
                component = getattr(pipe, name, None)
                if component is not None:
                    component.to("cuda")
        else:
            pipe.to("cuda")
        return pipe

    def stop(self):
        with self.lock:
            self._generation += 1
            pipe, self.pipe = self.pipe, None
            self.status = "stopped"
        if pipe is not None:
            del pipe
            free_torch()

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
            return True, "Music model ready"
        if status == "loading":
            return False, "Loading the music model into memory…"
        return False, self.detail or "The music model is not running."

    def compose(self, request, output: Path, cancelled, progress):
        import torch
        ready, message = self.readiness()
        if not ready:
            raise RuntimeError(message)
        pipe = self.pipe
        seed = request.seed if request.seed >= 0 else secrets.randbelow(2147483647)
        lyrics = "[instrumental]" if request.instrumental else request.lyrics.strip()
        style = request.style.strip()
        if request.instrumental and "instrumental" not in style.lower():
            style += " Instrumental, no vocals."
        done = []

        def ticker():  # the autoregressive stage has no step callback; show elapsed time instead
            started = time.monotonic()
            while not done:
                elapsed = int(time.monotonic() - started)
                progress(None, f"Composing ({elapsed} s)… a {request.duration}-second song takes a while.")
                time.sleep(2)
        Thread(target=ticker, daemon=True).start()
        try:
            audio = pipe(prompt=style, lyrics=lyrics, audio_duration=float(request.duration),
                         generator=torch.Generator("cuda").manual_seed(seed), output="audios")[0]
        finally:
            done.append(True)
        if cancelled.is_set():
            raise Cancelled()
        if hasattr(audio, "detach"):
            audio = audio.detach().float().cpu().numpy()
        write_array_wav(output, audio, pipe.sampling_rate)


class DemoMusicRunner:
    mode = "demo"
    label = "music"
    model = "studio-zero/demo-music"
    rate = 22050

    def missing(self):
        return []

    def readiness(self):
        return True, "Demo music (synthesized) - not AI"

    def compose(self, request, output: Path, cancelled, progress):
        """A simple arpeggio in stereo, as long as requested (capped at 30 s for speed)."""
        seconds = min(request.duration, 30)
        notes = [261.63, 329.63, 392.0, 523.25, 392.0, 329.63]
        left, right = [], []
        step = int(self.rate * 0.25)
        for i in range(int(seconds * 4)):
            if cancelled.is_set():
                raise Cancelled()
            freq = notes[(i + (request.seed % 3 if request.seed > 0 else 0)) % len(notes)]
            for n in range(step):
                envelope = math.exp(-3 * n / step)
                value = 0.2 * envelope * math.sin(2 * math.pi * freq * n / self.rate)
                left.append(value); right.append(value * (0.6 + 0.4 * math.sin(i / 3)))
            if i % 16 == 0:
                progress(round(i * 100 / (seconds * 4)), "Composing (demo)…")
        write_wav(output, [left, right], self.rate)
