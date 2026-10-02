"""Which engine serves which kind of job, and swapping them on a single GPU.

Resident engines serve images, video or music. On one GPU (the default, ZERO_ENGINE_SWAP=1) a job
for another kind stops the loaded engines and starts the one it needs, inside the single worker
thread, so jobs never race - unless the incoming engine declares its size (`vram_gib`) and fits in
the GPU memory that is free right now, in which case everything stays loaded.
With ZERO_ENGINE_SWAP=0 (enough memory for all) engines stay loaded side by side.
Demo and command-line runners have no lifecycle and are used as they are.
"""
import os
import subprocess
import time
from threading import RLock

from .runner import Cancelled


def _resident(runner):
    return runner is not None and hasattr(runner, "start") and hasattr(runner, "state")


def gpu_free_gib():
    try:
        text = subprocess.run(["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits"],
                              capture_output=True, text=True, timeout=20, check=True).stdout
        return float(text.split()[0]) / 1024
    except (OSError, subprocess.SubprocessError, ValueError, IndexError):
        return None


class EngineSet:
    def __init__(self, image, video=None, swap=None, music=None, free_memory=gpu_free_gib):
        self.runners = {"image": image, **({"video": video} if video is not None else {}),
                        **({"music": music} if music is not None else {})}
        self.free_memory = free_memory
        self.swap = (os.environ.get("ZERO_ENGINE_SWAP", "1") != "0") if swap is None else swap
        self.active = "image"
        self.lock = RLock()

    def runner(self, kind):
        return self.runners.get(kind)

    def has(self, kind):
        runner = self.runner(kind)
        if runner is None:
            return False
        return not (hasattr(runner, "missing") and runner.missing())

    def start(self):
        if _resident(self.runners["image"]):
            self.runners["image"].start()

    def stop(self):
        for runner in self.runners.values():
            if _resident(runner):
                runner.stop()

    def readiness(self, kind):
        runner = self.runner(kind)
        if runner is None:
            return False, f"This engine has no {kind} model. Update the Colab notebook and restart the API."
        with self.lock:
            inactive = self.swap and self.active != kind
        if _resident(runner) and inactive:
            missing = runner.missing()
            if missing:
                return False, "Configure missing " + ", ".join(missing)
            return True, f"The {kind} model loads when it is first needed (the other model is unloaded to make room)."
        return runner.readiness()

    def state(self, kind):
        runner = self.runner(kind)
        if not _resident(runner):
            ready = runner is not None and runner.readiness()[0]
            return {"engine": "ready" if ready else "unavailable", "loaded_in_seconds": None}
        return runner.state()

    def fits(self, runner):
        """True when `runner` is already loaded, or declares its size and that much GPU memory is free."""
        if _resident(runner) and runner.state()["engine"] in ("ready", "loading"):
            return True
        need = getattr(runner, "vram_gib", None)
        if not need:
            return False
        free = self.free_memory()
        return free is not None and free >= need + 2

    def acquire(self, kind, cancelled, progress):
        """Make the engine for `kind` resident (swapping if needed) and return its runner."""
        runner = self.runner(kind)
        if runner is None:
            raise RuntimeError(f"This engine has no {kind} model.")
        with self.lock:
            # Mark the switch first: readiness() of the outgoing kind must not restart it meanwhile.
            self.active = kind
            if self.swap and not self.fits(runner):
                for other in self.runners.values():
                    if other is not runner and _resident(other) and other.state()["engine"] != "stopped":
                        progress(None, f"Unloading the {getattr(other, 'label', 'other')} model to make room…")
                        other.stop()
            if not _resident(runner):
                return runner  # command-line and demo runners load per job
            if runner.state()["engine"] in ("stopped", "failed"):
                runner.start()
        started = time.monotonic()
        while runner.state()["engine"] == "loading":
            if cancelled.wait(.5):
                raise Cancelled()
            progress(None, f"Loading the {kind} model ({int(time.monotonic() - started)} s)… this happens after switching models.")
        ready, message = runner.readiness()
        if not ready:
            raise RuntimeError(message)
        return runner
