"""Single-user, authenticated job API. Run with one uvicorn worker."""
import hmac
import json
import os
import secrets
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from threading import Event, RLock
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from PIL import Image, PngImagePlugin
from .assistant import DemoPromptHelper, PromptHelper
from .audio import (DemoMusicRunner, DemoSpeaker, DemoTranscriber, MusicRunner, Speaker, Transcriber, audio_format,
                    finish_audio)
from .engines import EngineSet
from .vision import DemoPoseDetector, DemoUpscaler, PoseDetector, Upscaler, check_upscale_size
from .matting import default_matter
from .runner import Cancelled, DemoRunner, DemoVideoRunner, QwenRunner, ResidentQwenRunner, ResidentVideoRunner, SD_REVISION
from .schema import (DescribeRequest, DetectPoseRequest, EditRequest, EnhancePromptRequest, GenerateRequest, MusicRequest,
                     RemoveBackgroundRequest, SpeechRequest, TranscribeRequest, UpscaleRequest, VideoRequest, decode_audio_data,
                     decode_image_data)

TERMINAL = {"succeeded", "failed", "cancelled"}
def _diffusers_runner():
    from .diffusers_runner import DiffusersQwenRunner
    return DiffusersQwenRunner()


RUNNERS = {"qwen": ResidentQwenRunner, "qwen-cli": QwenRunner, "diffusers": _diffusers_runner, "demo": DemoRunner}


def default_video_runner(runner):
    """Demo video for the demo engine; LTX video only when the notebook configured its weights."""
    if runner.mode == "demo":
        return DemoVideoRunner()
    return ResidentVideoRunner() if os.environ.get("ZERO_VIDEO_DIFFUSION") else None


def default_helpers(runner):
    """Audio and language helpers the notebook configured (all of them, as demos, for the demo engine)."""
    if runner.mode == "demo":
        return DemoPromptHelper(), DemoTranscriber(), DemoSpeaker(), DemoMusicRunner()
    env = os.environ.get
    return (PromptHelper() if env("ZERO_VL") or env("DEEPSEEK_API_KEY") else None,
            Transcriber() if env("ZERO_WHISPER") else None,
            Speaker() if env("ZERO_TTS") else None,
            MusicRunner() if env("ZERO_MUSIC") else None)


def default_vision(runner):
    """Upscaler and pose detector the notebook configured (demos for the demo engine)."""
    if runner.mode == "demo":
        return DemoUpscaler(), DemoPoseDetector()
    return (Upscaler() if os.environ.get("ZERO_UPSCALER") else None,
            PoseDetector() if os.environ.get("ZERO_POSE_MODEL") else None)


AUDIO_KINDS = ("speech", "music")
DIRECT_KINDS = ("speech", "upscale")  # served by a helper, not by a swappable engine


def create_app(runner=None, token=None, output_dir=None, matter="auto", video_runner="auto", engine_swap=None,
               helpers="auto", vision="auto"):
    choice = os.environ.get("ZERO_RUNNER", "qwen")
    if runner is None and choice not in RUNNERS:
        raise RuntimeError("ZERO_RUNNER must be one of: " + ", ".join(RUNNERS))
    runner = runner or RUNNERS[choice]()
    video_runner = default_video_runner(runner) if video_runner == "auto" else video_runner
    assistant, transcriber, speaker, music_runner = default_helpers(runner) if helpers == "auto" else helpers
    upscaler, pose_detector = default_vision(runner) if vision == "auto" else vision
    engines = EngineSet(runner, video_runner, swap=engine_swap, music=music_runner)
    # Background removal is optional and separate from the image model; None disables it.
    matter = default_matter(runner.mode) if matter == "auto" else matter
    token = token or os.environ.get("ZERO_API_TOKEN", "")
    if len(token) < 24:
        raise RuntimeError("Set ZERO_API_TOKEN to a random secret of at least 24 characters.")
    outputs = Path(output_dir or os.environ.get("ZERO_OUTPUT_DIR", "outputs")).resolve()
    outputs.mkdir(parents=True, exist_ok=True)
    task_dir = outputs / "tasks"
    task_dir.mkdir(exist_ok=True)
    for stale in [*task_dir.glob("*.png"), *task_dir.glob("*.json")]:
        stale.unlink(missing_ok=True)  # tasks are ephemeral; results are fetched once by the studio
    jobs, cancellation = {}, {}
    tasks, task_flags = {}, {}
    lock = RLock()
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="studio-zero")
    # Recover completed outputs; interrupted jobs are explicitly marked failed.
    for path in outputs.glob("*.json"):
        try:
            job = json.loads(path.read_text(encoding="utf-8"))
            if str(uuid.UUID(job["id"])) != job["id"]:
                continue
            if job["status"] not in TERMINAL:
                job.update(status="failed", message="The service restarted before this generation finished.", progress=None)
            jobs[job["id"]] = job
        except (ValueError, KeyError, TypeError):
            continue

    @asynccontextmanager
    async def lifespan(app):
        # A resident engine begins loading its weights in the background; the API is usable at once.
        engines.start()
        if matter is not None and hasattr(matter, "start"):
            matter.start()
        yield
        with lock:
            for flag in [*cancellation.values(), *task_flags.values()]:
                flag.set()
        executor.shutdown(wait=True, cancel_futures=True)
        engines.stop()
        if matter is not None and hasattr(matter, "stop"):
            matter.stop()

    app = FastAPI(title="Studio Zero private engine", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    origins = [x.strip() for x in os.environ.get("ZERO_ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173").split(",") if x.strip()]
    if "*" in origins:
        raise RuntimeError("Use exact Studio Zero origins, not a wildcard.")

    @app.middleware("http")
    async def body_limit(request: Request, call_next):
        if request.method == "POST":
            # Authenticate before buffering image-bearing requests.
            if not hmac.compare_digest(request.headers.get("authorization", "").encode(), f"Bearer {token}".encode()):
                from fastapi.responses import JSONResponse
                return JSONResponse({"detail": "A valid access key is required."}, status_code=401)
            large = ("/generate", "/remove-background", "/edit", "/video", "/describe", "/transcribe", "/speech", "/upscale",
                     "/detect-pose")
            limit = 48 * 1024 * 1024 if request.url.path in large else 128 * 1024
            size = 0
            chunks = []
            async for chunk in request.stream():
                size += len(chunk)
                if size > limit:
                    from fastapi.responses import JSONResponse
                    return JSONResponse({"detail": "Request too large"}, status_code=413)
                chunks.append(chunk)
            request._body = b"".join(chunks)
        return await call_next(request)

    # Wrap body/auth rejections too, so the browser can read their error messages.
    app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["GET", "POST"], allow_headers=["Authorization", "Content-Type"], allow_credentials=False)

    def authorized(authorization: str = Header(default="")):
        if not hmac.compare_digest(authorization.encode(), f"Bearer {token}".encode()):
            raise HTTPException(401, "A valid access key is required.")

    auth = [Depends(authorized)]

    def persist(job):
        tmp = outputs / f"{job['id']}.json.tmp"
        tmp.write_text(json.dumps(job, indent=2), encoding="utf-8")
        tmp.replace(outputs / f"{job['id']}.json")

    def find(id):
        if id not in jobs:
            raise HTTPException(404, "Job not found.")
        return jobs[id]

    def snapshot(job):
        return json.loads(json.dumps(job))

    def output_path(id, kind, fmt=None):
        if kind in AUDIO_KINDS:
            return outputs / f"{id}.{fmt or 'wav'}"
        return outputs / f"{id}.{(fmt or 'mp4') if kind == 'video' else 'png'}"

    def run(id, kind, request):
        flag = cancellation[id]
        output = output_path(id, kind, jobs[id]["metadata"].get("format"))
        def progress(value, message):
            with lock:
                if jobs[id]["status"] not in TERMINAL:
                    jobs[id].update(progress=value, message=message)
        working = {"video": "Creating your video…", "edit": "Editing your image…", "speech": "Recording the voice…",
                   "music": "Composing your song…", "upscale": "Upscaling…"}.get(kind, "Creating your image…")
        with lock:
            if flag.is_set():
                cancellation.pop(id, None)
                return
            jobs[id].update(status="running", message=working, progress=None)
            persist(jobs[id])
        try:
            if kind == "speech":
                engine = speaker
            elif kind == "upscale":
                engine = upscaler
            else:
                engine = engines.acquire({"video": "video", "music": "music"}.get(kind, "image"), flag, progress)
            progress(None, working)
            if kind in AUDIO_KINDS:
                raw = output.with_suffix(".raw.wav")
                if kind == "speech":
                    voice = decode_audio_data(request.voice) if request.voice else None
                    engine.speak(request, voice, raw, flag, progress)
                else:
                    engine.compose(request, raw, flag, progress)
                if flag.is_set():
                    raise Cancelled()
                finish_audio(raw, output, jobs[id]["metadata"].get("format", "wav"))
            elif kind == "upscale":
                engine.upscale(request, decode_image_data(request.image), output, flag, progress)
            elif kind == "video":
                engine.generate_video(request, output, flag, progress)
            elif kind == "edit":
                engine.edit(request, output, flag, progress)
            else:
                engine.generate(request, output, flag, progress)
            if flag.is_set():
                raise Cancelled()
            if kind in AUDIO_KINDS:
                if not output.is_file() or output.stat().st_size <= 44:
                    raise RuntimeError("The audio engine finished without producing sound.")
            elif kind == "video":
                if not output.is_file() or output.stat().st_size < 64:
                    raise RuntimeError("The video engine finished without producing a video.")
            else:
                # Validate and embed the same metadata carried by the API and project file.
                with Image.open(output) as image:
                    image.load()
                    expected = (jobs[id]["metadata"]["width"], jobs[id]["metadata"]["height"])
                    if image.size != expected:
                        raise RuntimeError("The engine returned unexpected image dimensions.")
                    info = PngImagePlugin.PngInfo()
                    info.add_text("studio_zero", json.dumps(jobs[id]["metadata"]))
                    image.save(output.with_suffix(".tmp.png"), pnginfo=info)
                output.with_suffix(".tmp.png").replace(output)
            with lock:
                if flag.is_set():
                    raise Cancelled()
                ready = {"video": "Your video is ready.", "edit": "Your edit is ready.", "speech": "Your voice clip is ready.",
                         "music": "Your song is ready.", "upscale": "Your upscaled image is ready."}.get(kind, "Your image is ready.")
                jobs[id].update(status="succeeded", progress=100, message=ready, output_id=id)
        except Cancelled:
            with lock:
                jobs[id].update(status="cancelled", progress=None, message="Generation cancelled.")
            output.unlink(missing_ok=True)
            output.with_suffix(".raw.wav").unlink(missing_ok=True)
        except Exception as exc:
            with lock:
                jobs[id].update(status="failed", progress=None, message=str(exc) if isinstance(exc, RuntimeError) else "The engine could not finish this job. Check the private service logs.")
        finally:
            with lock:
                persist(jobs[id])
                cancellation.pop(id, None)

    def capabilities():
        caps = ["text-to-image"]
        if getattr(runner, "supports_references", False):
            caps.append("reference")
        if getattr(runner, "supports_transparency", False):
            caps.append("transparent")
        if getattr(runner, "supports_edit", False):
            caps += ["inpaint", "outpaint", "image-to-image", "variations"]
            if getattr(runner, "supports_references", False) or runner.mode == "demo":
                caps.append("edit")
        if engines.has("video"):
            caps.append("video")
        if matter is not None:
            caps.append("remove-background")
        if assistant is not None:
            if not assistant.missing():
                caps += ["describe", "enhance-prompt"]
            elif getattr(assistant, "api_key", ""):
                caps.append("enhance-prompt")
        for name, helper in (("transcribe", transcriber), ("speech", speaker)):
            if helper is not None and not helper.missing():
                caps.append(name)
        if engines.has("music"):
            caps.append("music")
        for name, helper in (("upscale", upscaler), ("detect-pose", pose_detector)):
            if helper is not None and not helper.missing():
                caps.append(name)
        return caps

    @app.get("/health", dependencies=auth)
    def health():
        ready, message = engines.readiness("image")
        state = engines.state("image")
        if hasattr(runner, "offload") and not (hasattr(runner, "missing") and runner.missing()):
            state = {**state, "offload": runner.offload}
        caps = capabilities()
        if "video" in caps:
            video_state = engines.state("video")
            state = {**state, "video_engine": video_state["engine"], "video_loaded_in_seconds": video_state["loaded_in_seconds"],
                     "video_model": engines.runner("video").model, "engine_swap": engines.swap}
        if matter is not None:
            matting_state = matter.state() if hasattr(matter, "state") else {"matting": "ready"}
            state = {**state, **matting_state, "matting_mode": matter.mode}
        models = {}
        if assistant is not None:
            models.update(assistant=assistant.model, prompt_rewriter=assistant.rewriter)
        for name, helper in (("transcribe", transcriber), ("speech", speaker), ("music", music_runner),
                             ("upscale", upscaler), ("pose", pose_detector)):
            if helper is not None:
                models[name] = helper.model
        if "music" in caps:
            state = {**state, "music_engine": engines.state("music")["engine"]}
        if models:
            state = {**state, "helper_models": models}
        return {"ready": ready, "mode": runner.mode, "message": message, "capabilities": caps, "api_version": 1, **state}

    def enqueue(kind, request, metadata):
        if kind in DIRECT_KINDS:
            engine, (ready, message) = (speaker if kind == "speech" else upscaler), (True, "")
        else:
            engine_kind = {"video": "video", "music": "music"}.get(kind, "image")
            ready, message = engines.readiness(engine_kind)
        if not ready:
            raise HTTPException(503, message)
        with lock:
            if sum(j["status"] not in TERMINAL for j in jobs.values()) >= 4:
                raise HTTPException(429, "Your engine is busy. Wait for a job to finish.")
            id = str(uuid.uuid4())
            if getattr(request, "seed", None) == -1:
                request = request.model_copy(update={"seed": secrets.randbelow(2147483648)})
            if kind not in DIRECT_KINDS:
                engine = engines.runner(engine_kind)
            metadata = {**metadata, "seed": getattr(request, "seed", None), "kind": kind, "model": engine.model, "jobId": id,
                        "createdAt": datetime.now(timezone.utc).isoformat(), "demo": runner.mode == "demo",
                        "runner": "procedural" if runner.mode == "demo" else getattr(engine, "runner_name", "diffusers" if kind in AUDIO_KINDS else "stable-diffusion.cpp"),
                        "runnerRevision": getattr(engine, "runner_revision", None) or os.environ.get("ZERO_SD_REVISION", SD_REVISION)}
            jobs[id] = {"id": id, "status": "queued", "progress": 0, "message": "Waiting for your engine…", "metadata": metadata}
            cancellation[id] = Event()
            persist(jobs[id])
            executor.submit(run, id, kind, request)
            return snapshot(jobs[id])

    @app.post("/generate", dependencies=auth, status_code=202)
    def generate(request: GenerateRequest):
        if request.reference_images and not getattr(runner, "supports_references", False):
            raise HTTPException(422, "This engine needs the vision encoder for reference images. Update the Colab notebook and restart the API.")
        if request.transparent and "transparent" not in capabilities():
            raise HTTPException(422, "This engine cannot create transparent images.")
        metadata = {**request.model_dump(exclude={"reference_images"}), "reference_count": len(request.reference_images)}
        return enqueue("image", request, metadata)

    @app.post("/edit", dependencies=auth, status_code=202)
    def edit(request: EditRequest):
        caps = capabilities()
        if request.operation not in caps:
            extra = " Instruction edits need the vision encoder (ENABLE_REFERENCES in the notebook)." if request.operation == "edit" else ""
            raise HTTPException(422, f"This engine does not offer {request.operation}.{extra}")
        if request.reference_images and "reference" not in caps:
            raise HTTPException(422, "This engine needs the vision encoder for reference images.")
        if request.transparent and "transparent" not in caps:
            raise HTTPException(422, "This engine cannot create transparent images.")
        metadata = {**request.model_dump(exclude={"reference_images", "image", "mask", "strength"}),
                    "reference_count": len(request.reference_images), "strength": request.effective_strength}
        return enqueue("edit", request, metadata)

    @app.post("/video", dependencies=auth, status_code=202)
    def video(request: VideoRequest):
        if "video" not in capabilities():
            raise HTTPException(501, "This engine has no video model. Turn on ENABLE_VIDEO in the Colab notebook and restart the API.")
        metadata = {**request.model_dump(exclude={"image", "end_image"}), "start_image": request.image is not None,
                    "end_image": request.end_image is not None, "format": getattr(engines.runner("video"), "format", "mp4")}
        return enqueue("video", request, metadata)

    @app.get("/jobs", dependencies=auth)
    def history():
        with lock:
            return [snapshot(j) for j in sorted(jobs.values(), key=lambda j: j['metadata']['createdAt'], reverse=True)[:50]]

    @app.get("/jobs/{id}", dependencies=auth)
    def job(id: str):
        with lock:
            return snapshot(find(id))

    @app.post("/jobs/{id}/cancel", dependencies=auth)
    def cancel(id: str):
        with lock:
            j = find(id)
            if j["status"] not in TERMINAL:
                cancellation[id].set()
                j.update(status="cancelled", progress=None, message="Generation cancelled.")
                persist(j)
            return snapshot(j)

    @app.get("/outputs/{id}", dependencies=auth)
    def output(id: str):
        with lock:
            j = find(id)
            if j["status"] != "succeeded":
                raise HTTPException(409, "This output is not ready.")
            kind, fmt = j["metadata"].get("kind", "image"), j["metadata"].get("format", "mp4")
            path = output_path(id, kind, fmt)
            if not path.is_file():
                raise HTTPException(404, "Output no longer exists on this engine.")
        media = ("audio/mpeg" if fmt == "mp3" else "audio/wav") if kind in AUDIO_KINDS else f"video/{fmt}" if kind == "video" else "image/png"
        return FileResponse(path, media_type=media, headers={"Cache-Control": "private, no-store"})

    @app.post("/speech", dependencies=auth, status_code=202)
    def speech(request: SpeechRequest):
        if "speech" not in capabilities():
            raise HTTPException(501, "This engine has no voice model. Turn on ENABLE_VOICE in the Colab notebook and restart the API.")
        metadata = {**request.model_dump(exclude={"voice"}), "cloned_voice": request.voice is not None, "format": audio_format()}
        return enqueue("speech", request, metadata)

    @app.post("/music", dependencies=auth, status_code=202)
    def music(request: MusicRequest):
        if "music" not in capabilities():
            raise HTTPException(501, "This engine has no music model. Turn on ENABLE_MUSIC in the Colab notebook and restart the API.")
        return enqueue("music", request, {**request.model_dump(), "format": audio_format()})

    @app.post("/upscale", dependencies=auth, status_code=202)
    def upscale(request: UpscaleRequest):
        if "upscale" not in capabilities():
            raise HTTPException(501, "This engine has no upscaling model. Turn on ENABLE_UPSCALE in the Colab notebook and restart the API.")
        width, height = request.source_size
        try:
            check_upscale_size(width, height, request.scale)
        except ValueError as exc:
            raise HTTPException(422, str(exc))
        metadata = {"scale": request.scale, "source_width": width, "source_height": height,
                    "width": width * request.scale, "height": height * request.scale}
        return enqueue("upscale", request, metadata)

    # Short tasks: background removal, transcription, prompts ----------------------------
    # Ephemeral (not persisted, not in /jobs history); they share the single GPU worker.
    def run_task(id, work):
        flag = task_flags[id]
        with lock:
            if flag.is_set():
                task_flags.pop(id, None)
                return
            tasks[id].update(status="running", message=tasks[id]["working"])

        def progress(value, message):
            with lock:
                if tasks[id]["status"] not in TERMINAL:
                    tasks[id].update(progress=value, message=message)
        try:
            result = work(flag, progress, id)
            if flag.is_set():
                raise Cancelled()
            with lock:
                if flag.is_set():
                    raise Cancelled()
                tasks[id].update(status="succeeded", message=tasks[id]["done"], progress=100,
                                 **({"result": result} if result is not None else {}))
        except Cancelled:
            with lock:
                tasks[id].update(status="cancelled", message="Cancelled.")
            (task_dir / f"{id}.png").unlink(missing_ok=True)
        except Exception as exc:
            with lock:
                tasks[id].update(status="failed", message=str(exc) if isinstance(exc, RuntimeError) else f"{tasks[id]['kind']} failed. Check the private service log.")
        finally:
            with lock:
                task_flags.pop(id, None)

    def find_task(id):
        if id not in tasks:
            raise HTTPException(404, "Task not found. The engine may have restarted; try again.")
        return tasks[id]

    def submit_task(kind, work, working, done, **info):
        with lock:
            if sum(t["status"] not in TERMINAL for t in tasks.values()) >= 4:
                raise HTTPException(429, "The engine is busy with other tasks. Wait for one to finish.")
            id = str(uuid.uuid4())
            tasks[id] = {"id": id, "kind": kind, "status": "queued", "message": "Waiting for your engine…", "progress": None,
                         "working": working, "done": done, "createdAt": datetime.now(timezone.utc).isoformat(), **info}
            task_flags[id] = Event()
            # Keep only recent tasks and their masks.
            for old in sorted(tasks.values(), key=lambda t: t["createdAt"])[:-20]:
                if old["status"] in TERMINAL:
                    tasks.pop(old["id"], None)
                    (task_dir / f"{old['id']}.png").unlink(missing_ok=True)
            executor.submit(run_task, id, work)
            return public_task(tasks[id])

    def public_task(t):
        return {k: v for k, v in t.items() if k not in ("working", "done")}

    @app.post("/remove-background", dependencies=auth, status_code=202)
    def remove_background(request: RemoveBackgroundRequest):
        if matter is None:
            raise HTTPException(501, "This engine has no background removal. Update the Colab notebook and restart the API.")
        ready, message = matter.readiness()
        if not ready:
            raise HTTPException(503, message)
        width, height = decode_image_data(request.image).size

        def work(flag, progress, id):
            image = decode_image_data(request.image)
            mask = matter.matte(image)
            if flag.is_set():
                raise Cancelled()
            if mask.size != image.size:
                raise RuntimeError("Background removal returned a mask of the wrong size.")
            mask.convert("L").save(task_dir / f"{id}.png")
        return submit_task("remove-background", work, "Finding the subject…", "Subject found.",
                           width=width, height=height, model=matter.model, demo=matter.mode == "demo")

    def need(name, helper, setting):
        if name not in capabilities():
            raise HTTPException(501, f"This engine does not offer {name}. Turn on {setting} in the Colab notebook and restart the API.")
        return helper

    @app.post("/transcribe", dependencies=auth, status_code=202)
    def transcribe(request: TranscribeRequest):
        helper = need("transcribe", transcriber, "ENABLE_TRANSCRIBE")
        data = decode_audio_data(request.audio)
        return submit_task("transcribe", lambda flag, progress, _id: helper.transcribe(data, request.language, flag, progress),
                           "Transcribing…", "Transcript ready.", model=helper.model, demo=helper.mode == "demo")

    @app.post("/describe", dependencies=auth, status_code=202)
    def describe(request: DescribeRequest):
        helper = need("describe", assistant, "ENABLE_ASSISTANT")
        return submit_task("describe", lambda flag, progress, _id: helper.describe(decode_image_data(request.image), request.purpose),
                           "Looking at the image…", "Description ready.", model=helper.model, demo=helper.mode == "demo")

    @app.post("/detect-pose", dependencies=auth, status_code=202)
    def detect_pose(request: DetectPoseRequest):
        helper = need("detect-pose", pose_detector, "ENABLE_POSE")
        return submit_task("detect-pose", lambda flag, progress, _id: helper.detect(decode_image_data(request.image)),
                           "Finding people and their pose…", "Pose found.", model=helper.model, demo=helper.mode == "demo")

    @app.post("/enhance-prompt", dependencies=auth, status_code=202)
    def enhance_prompt(request: EnhancePromptRequest):
        helper = need("enhance-prompt", assistant, "ENABLE_ASSISTANT (or add a DEEPSEEK_API_KEY secret)")
        return submit_task("enhance-prompt", lambda flag, progress, _id: helper.enhance(request.prompt, request.target),
                           "Improving the prompt…", "Prompt ready.", model=helper.rewriter, demo=helper.mode == "demo")

    @app.get("/tasks/{id}", dependencies=auth)
    def task(id: str):
        with lock:
            return public_task(find_task(id))

    @app.post("/tasks/{id}/cancel", dependencies=auth)
    def cancel_task(id: str):
        with lock:
            t = find_task(id)
            if t["status"] not in TERMINAL:
                task_flags[id].set()
                t.update(status="cancelled", message="Cancelled.")
            return public_task(t)

    @app.get("/tasks/{id}/mask", dependencies=auth)
    def task_mask(id: str):
        with lock:
            t = find_task(id)
            if t["status"] != "succeeded":
                raise HTTPException(409, "This mask is not ready.")
            path = task_dir / f"{id}.png"
            if not path.is_file():
                raise HTTPException(404, "This mask no longer exists on the engine.")
        return FileResponse(path, media_type="image/png", headers={"Cache-Control": "private, no-store"})

    return app
