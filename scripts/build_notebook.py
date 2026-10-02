"""Regenerate the self-contained Colab notebook from the actual backend sources.

Layout: a short how-to, two settings forms, six titled steps whose code is hidden (Colab "form" cells),
a stop cell and a reference section. Every Python cell is syntax-checked here.
"""
import ast
import json
import textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
cells = []


def md(text):
    cells.append({'cell_type': 'markdown', 'metadata': {}, 'source': textwrap.dedent(text).strip().splitlines(True)})


def code(text, form=True):
    source = textwrap.dedent(text).strip() + '\n'
    ast.parse(source)
    metadata = {'cellView': 'form'} if form else {}
    cells.append({'cell_type': 'code', 'execution_count': None, 'metadata': metadata, 'outputs': [],
                  'source': source.splitlines(True)})


md('''
    # Studio Zero · private engine
    Runs the AI behind your Studio Zero canvas: images and AI edits, transparent images, background removal,
    prompt help, upscaling, poses, voice, transcription, and optionally music and video. The canvas stays on your computer.

    **How to use**
    1. **Runtime → Run all.** The notebook asks for an A100 with High-RAM (change it in *Runtime → Change runtime type*).
    2. Allow Google Drive when asked. Models are saved there once, so later sessions download nothing.
    3. When step 5 shows **Studio Zero is ready**, click **Open Studio Zero** or paste the address and key into the studio.
    4. When you finish, run **Stop and save**.

    The first session takes about 30 minutes (downloads). Later sessions are ready in about 5 minutes.
    Everything below is optional. Details, sizes and model licences are under **Reference** at the end.
''')

md('## Settings')
code('''
    #@title ⚙️ Settings: tick what you need { display-mode: "form" }
    #@markdown **Features** (each model downloads once, to Drive)
    ENABLE_REFERENCES = True  #@param {type:"boolean"}
    #@markdown ↳ Reference images: guide new images with up to three pictures, and change poses
    ENABLE_BACKGROUND_REMOVAL = True  #@param {type:"boolean"}
    #@markdown ↳ Remove background on any layer (BiRefNet, 1 GB)
    ENABLE_ASSISTANT = True  #@param {type:"boolean"}
    #@markdown ↳ Improve prompt and Describe image (Qwen3-VL-2B, 4 GB)
    ENABLE_UPSCALE = True  #@param {type:"boolean"}
    #@markdown ↳ Upscale layers ×2 or ×4 (Real-ESRGAN, 67 MB)
    ENABLE_POSE = True  #@param {type:"boolean"}
    #@markdown ↳ Detect a body pose in the pose editor (DWPose, 240 MB)
    ENABLE_VOICE = True  #@param {type:"boolean"}
    #@markdown ↳ Text to speech and voice cloning, English (Chatterbox Turbo, 3 GB)
    ENABLE_TRANSCRIBE = True  #@param {type:"boolean"}
    #@markdown ↳ Speech to text and subtitles (faster-whisper, 145 MB)
    ENABLE_MUSIC = False  #@param {type:"boolean"}
    #@markdown ↳ Songs with vocals (MiniMax Music 3, 28 GB, needs a 24 GB GPU)
    ENABLE_VIDEO = False  #@param {type:"boolean"}
    #@markdown ↳ Video with sound (LTX-2.5, 44 GB, needs an A100/H100 and a Hugging Face token below)

    #@markdown ---
    #@markdown **Hugging Face token** (needed for video: the LTX-2.5 files are gated)
    HF_TOKEN = ""  #@param {type:"string"}
    #@markdown ↳ A *read* token from huggingface.co/settings/tokens, after accepting the licence on huggingface.co/Lightricks/LTX-2.5.
    #@markdown Leave empty to use the Colab secret `HF_TOKEN` (🔑 in the left bar) instead. A token typed here is saved
    #@markdown in this notebook, so clear it before sharing the notebook. It is never printed.

    #@markdown ---
    #@markdown **Speed and quality**
    ENGINE = "auto"  #@param ["auto", "fast", "sdcpp"]
    #@markdown ↳ auto: the 4-step fast engine on GPUs with 22 GB+ and 45 GB+ RAM, otherwise stable-diffusion.cpp
    MODEL_SIZE = "Q4_K_M"  #@param ["Q4_K_M", "Q5_K_M", "Q6_K", "Q8_0", "BF16"]
    #@markdown ↳ Image model file: Q4_K_M 4.6 GB · Q5_K_M 5.2 · Q6_K 5.9 · Q8_0 7.6 · BF16 14.2 (bigger = finer detail)
    OFFLOAD = "auto"  #@param ["auto", "on", "off"]
    #@markdown ↳ auto: keep weights on the GPU whenever they fit
    CHECKS = "quick"  #@param ["quick", "full", "off"]
    #@markdown ↳ Step 6 checks: quick = one image · full = every feature you ticked (a few minutes)

    #@markdown ---
    #@markdown **Google Drive cache**
    CACHE_ON_DRIVE = True  #@param {type:"boolean"}
    #@markdown ↳ Keep models in *My Drive/StudioZero* and reuse them every session
    COPY_WEIGHTS_TO_LOCAL = False  #@param {type:"boolean"}
    #@markdown ↳ Copy models to the local disk first (only if loading from Drive stalls)
    UPDATE_MODELS = False  #@param {type:"boolean"}
    #@markdown ↳ Check Hugging Face for newer model versions
    REDOWNLOAD_MODELS = False  #@param {type:"boolean"}
    #@markdown ↳ Download every model again (a damaged file). Untick afterwards
    REBUILD_ENGINE = False  #@param {type:"boolean"}
    #@markdown ↳ Recompile stable-diffusion.cpp. Untick afterwards
''')
code('''
    #@title 🔧 Advanced settings (model sources, rarely changed) { display-mode: "form" }
    FLASH_ATTENTION = True  #@param {type:"boolean"}
    SAGE_ATTENTION = False  #@param {type:"boolean"}
    ENGINE_SWAP = True  #@param {type:"boolean"}
    #@markdown ↳ Engine swap: unload a model when the next one does not fit (untick only with memory for all of them)
    VIDEO_FORMAT = "mp4"  #@param ["mp4", "webm"]
    DRIVE_DIR = '/content/drive/MyDrive/StudioZero'
    DIFFUSION_REPO = 'abenzerps/Qwen-Image-2.1-GGUF'
    DIFFUSION_FILE = f'qwen-image-2.1-UC-{MODEL_SIZE}.gguf'  # any file on the repo's main branch
    COMPANION_REPO = 'Qwen/Qwen-Image-2.1'                  # text encoder, VAE and configs for the fast engine
    FAST_REPO = 'alibaba-pai/Qwen-Image-2.1-Fun-Acc-LoRAs'  # 4-step adapter + its loader code
    FAST_FILE = 'models/Qwen-Image-2.1-Fun-Acc-4Step.safetensors'
    MATTING_REPO = 'onnx-community/BiRefNet-ONNX'
    MATTING_FILE = 'onnx/model.onnx'  # 'onnx/model_fp16.onnx' halves the download (less tested)
    ASSISTANT_REPO = 'Qwen/Qwen3-VL-2B-Instruct'
    WHISPER_REPO = 'Systran/faster-whisper-base'
    VOICE_REPO = 'ResembleAI/chatterbox-turbo'
    MUSIC_REPO = 'MiniMaxAI/MiniMax-Music3'
    UPSCALE_MODEL = ('Comfy-Org/Real-ESRGAN_repackaged', 'RealESRGAN_x4plus.safetensors')
    POSE_MODEL = ('yzd-v/DWPose', 'dw-ll_ucoco_384.onnx')
    POSE_DETECTOR = ('hr16/yolox-onnx', 'yolox_m.onnx')
    VIDEO_DIFFUSION = ('vantagewithai/LTX-2.5-GGUF', 'distilled/ltx-2.5-22b-distilled-transformer-Q4_K_M.gguf')
    VIDEO_STEPS, VIDEO_GUIDANCE = 8, 1.0   # distilled model; for a 'dev/...' file use about 30 steps and guidance 3
    VIDEO_TEXT_ENCODER = ('Lightricks/LTX-2.5', 'text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16.safetensors')
    VIDEO_VAE = ('Lightricks/LTX-2.5', 'vae/ltx-2.5-video-vae-conv-bf16.safetensors')   # the conv VAE is required
    VIDEO_AUDIO_VAE = ('Lightricks/LTX-2.5', 'vae/ltx-2.5-audio-vae-bf16.safetensors')
''')

md('## Start')
code('''
    #@title 1 · Prepare the GPU, packages and Drive { display-mode: "form" }
    import os, sys, subprocess, shutil, time, json, secrets, threading
    from pathlib import Path

    def ok(message):
        print('✓', message)

    def pip(*packages, flags=()):
        result = subprocess.run([sys.executable, '-m', 'pip', 'install', '-q', *flags, *packages], capture_output=True, text=True)
        if result.returncode:
            print(result.stdout[-3000:], result.stderr[-3000:])
            raise RuntimeError('Installing ' + ' '.join(packages) + ' failed (pip output above).')

    t0 = time.monotonic()
    def gpu_query(field):
        return subprocess.run(['nvidia-smi', f'--query-gpu={field}', '--format=csv,noheader,nounits'],
                              capture_output=True, text=True, check=True).stdout.splitlines()[0].strip()
    GPU_NAME = gpu_query('name')
    GPU_GIB = float(gpu_query('memory.total')) / 1024
    GPU_ARCH = gpu_query('compute_cap').replace('.', '')
    RAM_GIB = int(open('/proc/meminfo').read().split('MemTotal:')[1].split()[0]) / 2**20
    FAST = ENGINE == 'fast' or (ENGINE == 'auto' and GPU_GIB >= 22 and RAM_GIB >= 45)
    ok(f"{GPU_NAME} · {GPU_GIB:.0f} GB GPU · {RAM_GIB:.0f} GB RAM → "
       f"{'fast engine (4 steps per image)' if FAST else 'stable-diffusion.cpp engine'}")

    pip('fastapi>=0.115,<1', 'uvicorn>=0.34,<1', 'pillow>=11,<13', 'httpx>=0.28,<1', 'huggingface_hub>=0.30,<2', 'hf_xet')
    if ENABLE_BACKGROUND_REMOVAL or ENABLE_TRANSCRIBE or ENABLE_POSE:
        # ONNX Runtime 1.27+ is built for CUDA 13, 1.21-1.26 for CUDA 12; match the CUDA that torch brings.
        TORCH_CUDA = subprocess.run([sys.executable, '-c', 'import torch; print(torch.version.cuda or "")'],
                                    capture_output=True, text=True).stdout.strip()
        pip('onnxruntime-gpu>=1.21,<1.27' if TORCH_CUDA.startswith('12') else 'onnxruntime-gpu>=1.27,<2', 'numpy')
    if FAST or ENABLE_ASSISTANT or ENABLE_VOICE or ENABLE_MUSIC:
        # Same pins as a public Space that runs the UC GGUF with Fun-Acc in diffusers.
        pip('diffusers @ git+https://github.com/huggingface/diffusers.git@9f1246971270c84dcbe71233edb7a519596a5d02',
            'transformers==5.17.0', 'accelerate', 'peft', 'gguf==0.19.0', 'sentencepiece')
        # Colab's preinstalled torchao is older than current peft expects and breaks the diffusers LoRA loader.
        subprocess.run([sys.executable, '-m', 'pip', 'uninstall', '-y', '-q', 'torchao'], capture_output=True)
    if ENABLE_TRANSCRIBE:
        # --no-deps: faster-whisper would pull the CPU onnxruntime over the GPU build installed above.
        pip('faster-whisper==1.2.1', flags=['--no-deps'])
        pip('ctranslate2>=4.6,<5', 'av>=11')
    if ENABLE_UPSCALE:
        pip('spandrel==0.4.2')
    if ENABLE_POSE:
        # --no-deps: rtmlib would pull the CPU onnxruntime over the GPU build; Colab already has OpenCV.
        pip('rtmlib==0.0.16', flags=['--no-deps'])
    if ENABLE_VOICE:
        # --no-deps: chatterbox-tts pins torch 2.6, transformers 5.2 and safetensors 0.5, which would break the stack.
        pip('chatterbox-tts==0.1.7', flags=['--no-deps'])
        pip('resemble-perth>=1.0.1', 's3tokenizer', 'conformer==0.3.2', 'pyloudnorm', 'omegaconf', 'librosa', 'einops')
    ok(f'Packages installed ({time.monotonic() - t0:.0f}s)')

    ROOT = Path('/content/studio-zero')
    ROOT.mkdir(exist_ok=True)
    CACHE = None
    if CACHE_ON_DRIVE:
        from google.colab import drive
        drive.mount('/content/drive')
        CACHE = Path(DRIVE_DIR); CACHE.mkdir(parents=True, exist_ok=True)
        ok(f'Google Drive connected · models are kept in {CACHE}')
    else:
        print('• Drive cache is off: models download again every session.')
''')
sources = {f'backend/{p.name}': p.read_text(encoding='utf-8') for p in sorted((ROOT / 'backend').glob('*.py'))}
code('#@title 2 · Install the Studio Zero API (bundled source) { display-mode: "form" }\n'
     'from pathlib import Path\nimport sys\nSOURCES = ' + repr(sources) + '\n'
     'for name, content in SOURCES.items():\n    target = ROOT / name\n    target.parent.mkdir(parents=True, exist_ok=True)\n'
     '    target.write_text(content, encoding="utf-8")\nsys.path.insert(0, str(ROOT))\n'
     'ok(f"Studio Zero API installed ({len(SOURCES)} files)")\n')
code('''
    #@title 3 · Get the models (from Drive; downloads only what is missing) { display-mode: "form" }
    from huggingface_hub import HfApi, hf_hub_download
    from backend.runner import SD_REVISION
    from backend.model_cache import ModelFile, ModelStore, RepoSnapshot, link_view
    os.environ['HF_XET_HIGH_PERFORMANCE'] = '1'
    def colab_secret(name):
        """Optional Colab secrets (HF_TOKEN, DEEPSEEK_API_KEY) stay on this runtime."""
        if not os.environ.get(name):
            try:
                from google.colab import userdata
                os.environ[name] = userdata.get(name)
            except Exception:
                os.environ.pop(name, None)
    # Hugging Face token for gated repositories (LTX-2.5): the Settings field wins over the Colab secret.
    os.environ.pop('HF_TOKEN', None)
    if HF_TOKEN.strip():
        os.environ['HF_TOKEN'] = HF_TOKEN.strip()
    else:
        colab_secret('HF_TOKEN')
    if os.environ.get('HF_TOKEN'):
        try:
            account = HfApi().whoami(token=os.environ['HF_TOKEN'])
            ok(f"Hugging Face token accepted ({account.get('name', 'your account')})")
        except Exception as exc:
            if getattr(getattr(exc, 'response', None), 'status_code', None) == 401:
                os.environ.pop('HF_TOKEN')  # a bad token would also block public downloads
                print('• The Hugging Face token was rejected, so it is not used. Check HF_TOKEN in Settings.')
            else:
                print(f'• Could not check the Hugging Face token right now ({type(exc).__name__}); using it anyway.')
    colab_secret('DEEPSEEK_API_KEY')  # Improve prompt with DeepSeek's API instead of the local model

    # Which files are needed -----------------------------------------------------------------
    ENCODER_REPO = 'Qwen/Qwen3-VL-8B-Instruct-GGUF'
    hub = HfApi()
    def resolve(repo, revision):
        info = hub.model_info(repo, revision=revision, files_metadata=True)
        return RepoSnapshot(info.sha, {s.rfilename: s.size for s in info.siblings})
    def repo_files(repo, keep):
        """A repository's file list, remembered on Drive so later sessions need no network."""
        listing = (CACHE / 'models' / repo / '.studio-zero-files.json') if CACHE else None
        if listing and listing.is_file() and not (UPDATE_MODELS or REDOWNLOAD_MODELS):
            names = json.loads(listing.read_text())
        else:
            names = sorted(resolve(repo, 'main').sizes)
            if listing:
                listing.parent.mkdir(parents=True, exist_ok=True); listing.write_text(json.dumps(names))
        return [name for name in names if keep(name)]
    files = [ModelFile('ZERO_DIFFUSION', DIFFUSION_REPO, DIFFUSION_FILE)]
    for env in ('ZERO_VAE', 'ZERO_TEXT_ENCODER', 'ZERO_VISION_ENCODER', 'ZERO_MATTING_MODEL'):
        os.environ.pop(env, None)
    if FAST:
        # The UC GGUF is the transformer; the companion supplies text encoder, VAE, processor and configs.
        files += [ModelFile('', COMPANION_REPO, name) for name in repo_files(
            COMPANION_REPO, lambda n: not n.startswith(('assets/', '.')) and not (n.startswith('transformer/') and n.endswith('.safetensors')))]
        files += [ModelFile('', FAST_REPO, name) for name in (FAST_FILE, FAST_FILE.rsplit('/', 1)[0] + '/pdd_config.json',
                                                               'qwenimage21_pdd.py', 'lora_utils_pdd.py')]
    else:
        files += [ModelFile('ZERO_VAE', DIFFUSION_REPO, 'vae/qwen_image_2.1_vae_bf16.safetensors'),
                  ModelFile('ZERO_TEXT_ENCODER', ENCODER_REPO, 'Qwen3VL-8B-Instruct-Q4_K_M.gguf')]
        if ENABLE_REFERENCES:
            files.append(ModelFile('ZERO_VISION_ENCODER', ENCODER_REPO, 'mmproj-Qwen3VL-8B-Instruct-F16.gguf'))
    if ENABLE_BACKGROUND_REMOVAL:
        files.append(ModelFile('ZERO_MATTING_MODEL', MATTING_REPO, MATTING_FILE))
    video_env = {'ZERO_VIDEO_DIFFUSION': VIDEO_DIFFUSION, 'ZERO_VIDEO_TEXT_ENCODER': VIDEO_TEXT_ENCODER,
                 'ZERO_VIDEO_VAE': VIDEO_VAE, 'ZERO_VIDEO_AUDIO_VAE': VIDEO_AUDIO_VAE}
    for env in video_env:
        os.environ.pop(env, None)
    if ENABLE_VIDEO:
        gated = VIDEO_TEXT_ENCODER[0]
        if not os.environ.get('HF_TOKEN'):
            print('• No Hugging Face token: set HF_TOKEN in Settings (or the Colab secret) or the gated video files will not download.')
        else:
            try:
                from huggingface_hub import auth_check
                auth_check(gated, token=os.environ['HF_TOKEN'])
            except ImportError:
                pass
            except Exception:
                print(f'• Your token cannot open {gated} yet: accept the licence at https://huggingface.co/{gated}, then run this step again.')
        files += [ModelFile(env, repo, filename) for env, (repo, filename) in video_env.items()]
    MUSIC_PARTS = ('language_model/', 'transformer/', 'rvq_depth_decoder/', 'vocoder/', 'condition_encoder/', 'tokenizer/', 'scheduler/')
    helper_repos = {  # env: (enabled, repo, files to keep)
        'ZERO_VL': (ENABLE_ASSISTANT, ASSISTANT_REPO, lambda n: not n.startswith('.') and n != 'README.md'),
        'ZERO_WHISPER': (ENABLE_TRANSCRIBE, WHISPER_REPO, lambda n: not n.startswith('.') and n != 'README.md'),
        'ZERO_TTS': (ENABLE_VOICE, VOICE_REPO, lambda n: not n.startswith('.') and n not in ('README.md', 's3gen.safetensors')),
        'ZERO_MUSIC': (ENABLE_MUSIC, MUSIC_REPO, lambda n: n.startswith(MUSIC_PARTS) or n in ('modular_model_index.json', 'config.json', 'LICENSE')),
    }
    for env, (enabled, repo, keep) in helper_repos.items():
        os.environ.pop(env, None)
        if enabled:
            files += [ModelFile('', repo, name) for name in repo_files(repo, keep)]
    vision_env = {'ZERO_UPSCALER': (ENABLE_UPSCALE, UPSCALE_MODEL), 'ZERO_POSE_MODEL': (ENABLE_POSE, POSE_MODEL),
                  'ZERO_POSE_DETECTOR': (ENABLE_POSE, POSE_DETECTOR)}
    for env, (enabled, (repo, filename)) in vision_env.items():
        os.environ.pop(env, None)
        if enabled:
            files.append(ModelFile(env, repo, filename))

    # Weights: reuse the Drive cache; download (in a background thread) only what is missing -----
    def download(repo, filename, revision, destination):
        return hf_hub_download(repo_id=repo, filename=filename, revision=revision, local_dir=str(destination),
                               force_download=REDOWNLOAD_MODELS)
    model_store = ModelStore(ROOT / 'models', CACHE, update=UPDATE_MODELS, redownload=REDOWNLOAD_MODELS,
                             copy_to_local=COPY_WEIGHTS_TO_LOCAL)
    legacy = (lambda item: CACHE / 'models' / item.repo.split('/')[0] / item.filename) if CACHE else None
    download_error = []
    def prepare_weights():
        try:
            os.environ.update(model_store.prepare(files, resolve, download, legacy=legacy))
        except Exception as exc:
            download_error.append(exc)
    t0 = time.monotonic()
    downloader = threading.Thread(target=prepare_weights, daemon=True); downloader.start()

    # Engine: restore a cached stable-diffusion.cpp build for this revision / GPU / CUDA, or build it once.
    # The fast engine runs in Python; the compiled engine is still needed for video.
    NEED_SDCPP = not FAST or ENABLE_VIDEO
    cuda_version = subprocess.run(['nvcc', '--version'], capture_output=True, text=True).stdout.rsplit('release ', 1)[-1].split(',')[0]
    engine_key = f'{SD_REVISION[:12]}-sm{GPU_ARCH}-cuda{cuda_version}'
    engine_dir = ROOT / 'engine' / engine_key
    engine = engine_dir / 'sd-server'
    required = ['--diffusion-model', '--llm', '--vae', '--offload-to-cpu', '--listen-ip', '--listen-port', '--diffusion-fa',
                '--sage-attn', '--audio-vae', '--vae-tiling']
    def engine_works(path):
        try:
            text = subprocess.run([str(path), '--help'], capture_output=True, text=True, timeout=60).stdout
            return all(flag in text for flag in required)
        except (OSError, subprocess.SubprocessError):
            return False
    if NEED_SDCPP:
        cached = (CACHE / 'engine' / engine_key / 'sd-server') if CACHE else None
        if REBUILD_ENGINE and 'engine_rebuilt' not in globals():
            shutil.rmtree(engine_dir, ignore_errors=True)
            shutil.rmtree('/content/stable-diffusion.cpp/build', ignore_errors=True)
            cached = None   # skip the Drive copy; the fresh build replaces it below
            engine_rebuilt = True
        if not engine.exists() and cached and cached.exists():
            engine_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(cached, engine); engine.chmod(0o755)
            ok(f'Engine restored from Drive ({engine_key})')
        if not (engine.exists() and engine_works(engine)):
            src = Path('/content/stable-diffusion.cpp')
            if not (src / '.git').exists():
                subprocess.run(['git', 'init', '-q', str(src)], check=True)
                subprocess.run(['git', '-C', str(src), 'remote', 'add', 'origin', 'https://github.com/leejet/stable-diffusion.cpp.git'], check=True)
            subprocess.run(['git', '-C', str(src), 'fetch', '-q', '--depth', '1', 'origin', SD_REVISION], check=True)
            subprocess.run(['git', '-C', str(src), 'checkout', '-q', 'FETCH_HEAD'], check=True)
            subprocess.run(['git', '-C', str(src), 'submodule', 'update', '-q', '--init', '--recursive', '--depth', '1'], check=True)
            subprocess.run(['cmake', '-S', str(src), '-B', str(src / 'build'), '-DCMAKE_BUILD_TYPE=Release',
                            '-DSD_CUDA=ON', f'-DCMAKE_CUDA_ARCHITECTURES={GPU_ARCH}', '-DSD_WEBP=OFF', '-DSD_WEBM=OFF',
                            '-DSD_SERVER_BUILD_FRONTEND=OFF'], check=True, stdout=subprocess.DEVNULL)
            print(f'• Building the engine for sm_{GPU_ARCH} on {os.cpu_count()} cores (first session only)…')
            subprocess.run(['cmake', '--build', str(src / 'build'), '--config', 'Release', '-j', str(os.cpu_count()), '--target', 'sd-server'],
                           check=True, stdout=subprocess.DEVNULL)
            engine_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src / 'build' / 'bin' / 'sd-server', engine); engine.chmod(0o755)
            assert engine_works(engine), 'The built engine is missing a required option.'
            drive_engine = (CACHE / 'engine' / engine_key / 'sd-server') if CACHE else None
            if drive_engine:
                drive_engine.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(engine, drive_engine)
            ok('Engine built' + (' and saved to Drive' if drive_engine else ''))
    os.environ['ZERO_SD_SERVER'] = str(engine) if NEED_SDCPP else ''
    os.environ['ZERO_SD_REVISION'] = SD_REVISION

    downloader.join()
    if download_error:
        raise download_error[0]
    revisions = model_store.revisions
    def model_id(repo, filename):
        return f"{repo}/{filename.rsplit('.', 1)[0]}@{revisions[repo][:12]}"
    os.environ['ZERO_MODEL_ID'] = model_id(DIFFUSION_REPO, DIFFUSION_FILE)
    if ENABLE_VIDEO:
        os.environ['ZERO_VIDEO_MODEL_ID'] = model_id(*VIDEO_DIFFUSION)
    if ENABLE_BACKGROUND_REMOVAL:
        os.environ['ZERO_MATTING_MODEL_ID'] = f'{MATTING_REPO}/{MATTING_FILE}@{revisions[MATTING_REPO][:12]}'
    if FAST:
        companion = link_view(model_store.paths, COMPANION_REPO, ROOT / 'views' / 'companion')
        fun_acc = link_view(model_store.paths, FAST_REPO, ROOT / 'views' / 'fun-acc')
        os.environ.update(ZERO_DIFFUSERS_COMPANION=str(companion), ZERO_FAST_LORA=str(fun_acc / FAST_FILE),
                          ZERO_FAST_CODE=str(fun_acc))
        os.environ['ZERO_MODEL_ID'] += ' · diffusers + Fun-Acc 4-step'
    for env, (enabled, repo, keep) in helper_repos.items():
        if enabled:
            os.environ[env] = str(link_view(model_store.paths, repo, ROOT / 'views' / env.lower()))
            os.environ[env + '_ID'] = f'{repo}@{revisions[repo][:12]}'
    if ENABLE_UPSCALE:
        os.environ['ZERO_UPSCALER_ID'] = model_id(*UPSCALE_MODEL)
    if ENABLE_POSE:
        os.environ['ZERO_POSE_MODEL_ID'] = f"{POSE_MODEL[0]}/{POSE_MODEL[1]} + {POSE_DETECTOR[0]}/{POSE_DETECTOR[1]}"
    (ROOT / 'model-revisions.json').write_text(json.dumps(revisions, indent=2))
    ok(f'Models ready in {time.monotonic() - t0:.0f}s · {model_store.summary()}')
''')
code('''
    #@title 4 · Start the engine (loads the image model into GPU memory) { display-mode: "form" }
    import httpx
    if 'server_process' in globals() and server_process.poll() is None:
        server_process.terminate()
        server_process.wait(timeout=30)
    if os.environ.get('ZERO_SD_SERVER'):
        subprocess.run(['pkill', '-f', os.environ['ZERO_SD_SERVER']])  # clear an engine orphaned by a hard stop
    os.environ.update({
        'ZERO_API_TOKEN': secrets.token_urlsafe(32),
        'ZERO_RUNNER': 'diffusers' if FAST else 'qwen',
        'ZERO_FLASH_ATTENTION': '1' if FLASH_ATTENTION else '0',
        'ZERO_SAGE_ATTENTION': '1' if SAGE_ATTENTION else '0',
        'ZERO_OFFLOAD': str(OFFLOAD),
        'ZERO_ENGINE_SWAP': '1' if ENGINE_SWAP else '0',
        'ZERO_VIDEO_FORMAT': VIDEO_FORMAT,
        'ZERO_ALLOWED_ORIGINS': 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173',
        'ZERO_OUTPUT_DIR': str(ROOT / 'outputs'),
        'ZERO_JOB_TIMEOUT': '3600',
    })
    service_log = (ROOT / 'service.log').open('w')
    t0 = time.monotonic()
    # The API binds to loopback only; step 5 adds an authenticated HTTPS tunnel.
    server_process = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'backend.app:create_app', '--factory',
                                      '--host', '127.0.0.1', '--port', '8000', '--workers', '1'],
                                     cwd=ROOT, env=os.environ.copy(), stdout=service_log, stderr=subprocess.STDOUT)
    api = httpx.Client(base_url='http://127.0.0.1:8000', timeout=30,
                       headers={'Authorization': 'Bearer ' + os.environ['ZERO_API_TOKEN']})
    health, shown = None, None
    while time.monotonic() - t0 < 1800:
        if server_process.poll() is not None:
            raise RuntimeError('The service stopped. See /content/studio-zero/service.log')
        try:
            health = api.get('/health').raise_for_status().json()
        except httpx.TransportError:
            time.sleep(0.5); continue
        if health['ready']:
            break
        if health.get('engine') == 'failed' or not health['message'].startswith('Loading'):
            raise RuntimeError(health['message'])
        if shown != health['message']:
            print('•', health['message']); shown = health['message']
        time.sleep(1)
    else:
        raise RuntimeError('The engine did not load in time. See /content/studio-zero/outputs/engine.log')
    where = 'offloaded to system RAM (slower)' if health.get('offload') else 'kept in GPU memory'
    ok(f"Engine ready in {time.monotonic() - t0:.0f}s · weights {where}")
    ok('Features: ' + ', '.join(health['capabilities']))

    def generate(settings, path='/generate', timeout=None):
        """Submit a job and wait for it; returns (job, seconds)."""
        start = time.monotonic()
        job = api.post(path, json=settings, timeout=timeout or 30).raise_for_status().json()
        while job['status'] in ('queued', 'running'):
            if server_process.poll() is not None:
                raise RuntimeError('The service stopped. See /content/studio-zero/service.log')
            time.sleep(1)
            job = api.get('/jobs/' + job['id']).raise_for_status().json()
        assert job['status'] == 'succeeded', job['message']
        return job, time.monotonic() - start

    def run_task(path, payload, timeout=600):
        """Submit a task and wait for it; returns (result, seconds)."""
        start = time.monotonic()
        task = api.post(path, json=payload, timeout=120).raise_for_status().json()
        while task['status'] in ('queued', 'running'):
            if time.monotonic() - start > timeout:
                raise RuntimeError(f'{path} took too long: ' + task['message'])
            time.sleep(0.5)
            task = api.get('/tasks/' + task['id']).raise_for_status().json()
        assert task['status'] == 'succeeded', task['message']
        return task['result'], time.monotonic() - start
''')

md('''
    ## Connect
    Cloudflare Quick Tunnel carries the traffic over HTTPS. Every request needs the access key, so the address alone
    cannot use your engine. A new key is made each session. Clear this cell's output before sharing the notebook.
''')
code('''
    #@title 5 · Connect your studio { display-mode: "form" }
    import re, html, urllib.parse, urllib.request
    from IPython.display import HTML, display
    cloudflared = ROOT / 'cloudflared'
    cached_tunnel = (CACHE / 'tools' / 'cloudflared') if CACHE else None
    if not cloudflared.exists() and cached_tunnel and cached_tunnel.exists():
        shutil.copy2(cached_tunnel, cloudflared)
    if not cloudflared.exists():
        urllib.request.urlretrieve('https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64', cloudflared)
        if cached_tunnel:
            cached_tunnel.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(cloudflared, cached_tunnel)
    cloudflared.chmod(0o755)
    if 'tunnel_process' in globals() and tunnel_process.poll() is None:
        tunnel_process.terminate(); tunnel_process.wait(timeout=15)
    tunnel_log_path = ROOT / 'tunnel.log'
    tunnel_log = tunnel_log_path.open('w')
    tunnel_process = subprocess.Popen([str(cloudflared), 'tunnel', '--url', 'http://127.0.0.1:8000', '--no-autoupdate'],
                                      stdout=tunnel_log, stderr=subprocess.STDOUT)
    for attempt in range(90):
        match = re.search(r'https://[a-z0-9-]+\\.trycloudflare\\.com', tunnel_log_path.read_text())
        if match:
            break
        time.sleep(1)
    else:
        raise RuntimeError('The tunnel did not start. See /content/studio-zero/tunnel.log')
    SERVICE_URL, ACCESS_KEY = match.group(0), os.environ['ZERO_API_TOKEN']
    # The link carries the details in the #fragment, which browsers never send to a server.
    STUDIO_LINK = ('http://localhost:5173/#connect=' + urllib.parse.quote(SERVICE_URL, safe='') +
                   '&key=' + urllib.parse.quote(ACCESS_KEY, safe=''))
    field = ('width:100%;box-sizing:border-box;font:13px ui-monospace,monospace;padding:7px 9px;border-radius:8px;'
             'border:1px solid #8886;background:transparent;color:inherit')
    def copy_row(label, value, ident):
        return (f'<div style="margin-top:10px"><div style="font-size:12px;opacity:.7;margin-bottom:4px">{label}</div>'
                f'<div style="display:flex;gap:6px"><input id="{ident}" readonly value="{html.escape(value)}" '
                f'onclick="this.select()" style="{field}"><button onclick="const f=document.getElementById(\\'{ident}\\');'
                f"f.select();(navigator.clipboard?navigator.clipboard.writeText(f.value):Promise.reject()).catch(()=>document.execCommand('copy'));"
                f"this.textContent='Copied'\\" style=\\"padding:6px 12px;border-radius:8px;border:1px solid #8886;"
                f'background:transparent;color:inherit;cursor:pointer">Copy</button></div></div>')
    display(HTML(
        '<div style="font-family:system-ui,sans-serif;border:1px solid #8885;border-radius:14px;padding:16px 18px;max-width:640px">'
        '<div style="font-size:17px;font-weight:600">✓ Studio Zero is ready</div>'
        '<div style="margin:12px 0 4px"><a href="' + html.escape(STUDIO_LINK) + '" target="_blank" '
        'style="display:inline-block;padding:9px 16px;border-radius:10px;background:#c6eda0;color:#26351c;'
        'text-decoration:none;font-weight:600">Open Studio Zero ↗</a>'
        '<span style="font-size:12px;opacity:.7;margin-left:10px">opens the studio on this computer (npm run dev) and connects</span></div>'
        '<div style="font-size:12px;opacity:.7;margin-top:12px">Or paste these into the studio under <b>Connect</b>:</div>'
        + copy_row('Address', SERVICE_URL, 'zero-address') + copy_row('Access key', ACCESS_KEY, 'zero-key') +
        '<div style="font-size:12px;opacity:.7;margin-top:12px">Keep this tab open while you create.</div></div>'))
    print('Address:', SERVICE_URL)
    print('Access key:', ACCESS_KEY)
    LAST_SETUP_AT = time.time()
''')

md('''
    ## Check (optional)
    Set **CHECKS** in Settings: *quick* makes one image, *full* tries every feature you ticked and shows the results
    together at the end. You can create in the studio while this runs.
''')
code('''
    #@title 6 · Check that everything works { display-mode: "form" }
    import base64, io, wave
    from PIL import Image as PILImage
    from IPython.display import HTML, display
    results, gallery = [], []

    def data_url(raw, kind='image/png'):
        return f'data:{kind};base64,' + base64.b64encode(raw).decode()
    def output(job):
        return api.get('/outputs/' + job['output_id'], timeout=300).raise_for_status().content
    def clip(text, size=110):
        text = ' '.join(text.split())
        return f'“{text[:size]}…”' if len(text) > size else f'“{text}”'
    def sound(raw):
        return 'audio/wav' if raw[:4] == b'RIFF' else 'audio/mpeg'
    def png(image):
        buffer = io.BytesIO(); image.save(buffer, 'PNG'); return buffer.getvalue()
    def show(label, raw, kind='image/png'):
        gallery.append((label, data_url(raw, kind), kind))
    def check(name, work, needed=False):
        start = time.monotonic()
        try:
            detail = work() or ''
        except Exception as exc:
            results.append(False)
            print(f'✗ {name}: {exc}')
            if needed:
                raise
            return
        results.append(True)
        print(f'✓ {name} · {time.monotonic() - start:.1f}s' + (f' · {detail}' if detail else ''))

    caps = api.get('/health').raise_for_status().json()['capabilities']
    vase = {}
    def first_image():
        job, _ = generate({'prompt': 'A small ceramic vase on a wooden table, soft daylight', 'width': 512, 'height': 512,
                           'steps': 8, 'guidance': 6, 'seed': 42})
        vase['raw'] = output(job); vase['url'] = data_url(vase['raw'])
        show('Image', vase['raw'])
        return '512 × 512'

    started = time.monotonic()
    try:
        if CHECKS == 'off':
            print('Checks are off (CHECKS in Settings).')
        else:
            check('Image', first_image, needed=True)
        if CHECKS == 'full':
            check('Next image (model stays loaded)', lambda: generate(
                {'prompt': 'A paper lantern at dusk', 'width': 512, 'height': 512, 'steps': 8, 'guidance': 6, 'seed': 7}) and '')

            def transparent():
                job, _ = generate({'prompt': 'A small red potion bottle, game item', 'width': 512, 'height': 512, 'steps': 8,
                                   'guidance': 6, 'seed': 11, 'transparent': True})
                potion = PILImage.open(io.BytesIO(output(job))).convert('RGBA')
                low, _ = potion.getchannel('A').getextrema()
                assert low < 255, 'the image has no transparent pixels'
                board = PILImage.new('RGBA', potion.size, (60, 60, 60, 255)); board.alpha_composite(potion)
                show('Transparent', png(board))
            check('Transparent image', transparent)

            def inpaint():
                half = PILImage.new('L', (512, 512), 0); half.paste(255, (256, 0, 512, 512))
                job, _ = generate({'operation': 'inpaint', 'prompt': 'a sprig of lavender in the vase', 'width': 512, 'height': 512,
                                   'steps': 8, 'guidance': 6, 'seed': 5, 'image': vase['url'], 'mask': data_url(png(half))}, '/edit', 120)
                show('Inpaint (right half)', output(job))
            check('Inpaint', inpaint)

            if 'reference' in caps:
                def reference():
                    job, _ = generate({'prompt': 'Change the ceramic vase in image 1 to cobalt blue. Keep the table and lighting.',
                                       'width': 512, 'height': 512, 'steps': 8, 'guidance': 6, 'seed': 42,
                                       'reference_images': [vase['url']]})
                    show('Reference edit: blue vase', output(job))
                check('Reference edit', reference)

            if ENABLE_BACKGROUND_REMOVAL:
                def background():
                    t1 = time.monotonic()
                    while (health := api.get('/health').raise_for_status().json()).get('matting') != 'ready':
                        if health.get('matting') == 'failed' or time.monotonic() - t1 > 600:
                            raise RuntimeError('the model did not load: ' + str(health.get('matting')))
                        time.sleep(1)
                    task = api.post('/remove-background', json={'image': vase['url']}).raise_for_status().json()
                    while task['status'] in ('queued', 'running'):
                        time.sleep(0.5)
                        task = api.get('/tasks/' + task['id']).raise_for_status().json()
                    assert task['status'] == 'succeeded', task['message']
                    matte = PILImage.open(io.BytesIO(api.get(f"/tasks/{task['id']}/mask").raise_for_status().content))
                    cutout = PILImage.open(io.BytesIO(vase['raw'])).convert('RGBA'); cutout.putalpha(matte)
                    board = PILImage.new('RGBA', cutout.size, (40, 40, 40, 255)); board.alpha_composite(cutout)
                    show('Background removed', png(board))
                    device = health.get('matting_device')
                    return f'on {device}' + ('' if device == 'cuda' else ' (slower; check ONNX Runtime CUDA in service.log)')
                check('Background removal', background)

            if 'enhance-prompt' in caps:
                def improve():
                    better, _ = run_task('/enhance-prompt', {'prompt': 'a fox in the snow', 'target': 'image'})
                    return clip(better['prompt'])
                check('Improve prompt', improve)
            if 'describe' in caps:
                def describe():
                    described, _ = run_task('/describe', {'image': vase['url'], 'purpose': 'image'})
                    return clip(described['prompt'])
                check('Describe image', describe)

            voice = {}
            if 'speech' in caps:
                def speech():
                    job, _ = generate({'text': 'Studio Zero can talk now. This short sentence checks the voice model, '
                                               'and it should sound clear and natural.', 'seed': 3}, '/speech', 120)
                    raw = output(job); voice['url'] = data_url(raw, sound(raw))
                    show('Voice', raw, sound(raw))
                    return 'includes loading the voice model'
                check('Voice', speech)
                if voice:
                    def clone():
                        job, _ = generate({'text': 'And this second line reuses the first voice as a sample.',
                                           'voice': voice['url'], 'seed': 4}, '/speech', 120)
                        raw = output(job); show('Cloned voice (should match)', raw, sound(raw))
                    check('Voice cloning', clone)
            if 'transcribe' in caps:
                def transcribe():
                    sample = voice.get('url')
                    if sample is None:  # no voice model: a second of silence still exercises the model
                        silent = io.BytesIO()
                        with wave.open(silent, 'wb') as w:
                            w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(bytes(32000))
                        sample = data_url(silent.getvalue(), 'audio/wav')
                    heard, _ = run_task('/transcribe', {'audio': sample})
                    return f"on {heard['device']} · " + clip(heard['text'], 160)
                check('Transcription', transcribe)
            if 'music' in caps:
                def music():
                    job, _ = generate({'style': 'Genre: indie pop. BPM: 100. Warm female vocal, acoustic guitar and light drums.',
                                       'lyrics': '[verse]\\nMorning light on the window\\n[chorus]\\nHere we go again',
                                       'duration': 20, 'seed': 7}, '/music', 120)
                    raw = output(job); show('Music (20 s)', raw, sound(raw))
                    return 'includes loading the music model'
                check('Music', music)
            if 'upscale' in caps:
                def upscale():
                    job, _ = generate({'image': vase['url'], 'scale': 2}, '/upscale', 120)
                    return f"{job['metadata']['source_width']} → {job['metadata']['width']} px wide"
                check('Upscale ×2', upscale)
            if 'detect-pose' in caps:
                from backend.vision import draw_pose
                pose = {}
                def detect():
                    job, _ = generate({'prompt': 'Full-body photo of a dancer leaping with arms raised, plain studio background',
                                       'width': 512, 'height': 768, 'steps': 8, 'guidance': 6, 'seed': 21})
                    found, _ = run_task('/detect-pose', {'image': data_url(output(job))})
                    assert found['people'], 'no person found'
                    pose['skeleton'] = draw_pose(found['people'][:1], found['width'], found['height'])
                    show('Detected pose', png(pose['skeleton']))
                    return f"on {found['device']} · {len(found['people'])} person(s)"
                check('Pose detection', detect)
                if pose and 'reference' in caps:
                    def posed():
                        job, _ = generate({'prompt': 'A knight in silver armour in a castle courtyard. The knight takes exactly the '
                                                     'body pose of the coloured stick figure in image 1; do not draw the stick figure.',
                                           'width': 512, 'height': 768, 'steps': 8, 'guidance': 6, 'seed': 5,
                                           'reference_images': [data_url(png(pose['skeleton']))]})
                        show('Knight in that pose', output(job))
                        return 'close to the skeleton, not exact'
                    check('Posed image', posed)
            if 'video' in caps:
                def video():
                    job, _ = generate({'prompt': 'A paper lantern swaying gently in the wind at dusk, soft light', 'width': 512,
                                       'height': 512, 'frames': 25, 'fps': 24, 'steps': VIDEO_STEPS, 'guidance': VIDEO_GUIDANCE,
                                       'seed': 3}, '/video', 120)
                    show('Video', output(job), f'video/{VIDEO_FORMAT}')
                    return 'includes swapping in the video model; the image model reloads on the next image'
                check('Video', video)
    finally:
        LAST_SETUP_AT = time.time()

    if gallery:
        tiles = []
        for label, url, kind in gallery:
            media = (f'<img src="{url}" style="width:100%;border-radius:8px;display:block">' if kind.startswith('image') else
                     f'<audio controls src="{url}" style="width:100%"></audio>' if kind.startswith('audio') else
                     f'<video controls loop muted src="{url}" style="width:100%;border-radius:8px"></video>')
            tiles.append(f'<figure style="margin:0">{media}<figcaption style="font-size:12px;opacity:.75;margin-top:4px">'
                         f'{label}</figcaption></figure>')
        display(HTML('<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:14px;'
                     'max-width:980px;font-family:system-ui,sans-serif;margin-top:8px">' + ''.join(tiles) + '</div>'))
    if results:
        passed, total = sum(results), len(results)
        seconds = time.monotonic() - started
        took = f'{seconds:.0f}s' if seconds < 90 else f'{seconds / 60:.1f} min'
        if passed == total:
            ok(f'All {total} checks passed in {took}.' if total > 1 else
               'Quick check passed. Set CHECKS to full in Settings to try every feature.')
        else:
            raise RuntimeError(f'{total - passed} of {total} checks failed (✗ above). Details: /content/studio-zero/service.log')
''')

md('## When you finish')
code('''
    #@title ⏹ Stop and save (run this on its own when you finish) { display-mode: "form" }
    #@markdown Save your work in the studio first (a `.zero` project keeps every image). This stops the engine,
    #@markdown waits for any models still being saved to Drive, and flushes Drive so the next session downloads nothing.
    import os, subprocess, time
    if time.time() - globals().get('LAST_SETUP_AT', 0) < 15:
        print('Skipped: Run all reached this cell. Your engine keeps running; run this cell on its own when you finish.')
    else:
        for name in ['tunnel_process', 'server_process']:
            process = globals().get(name)
            if process and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill(); process.wait()
        os.environ.pop('ZERO_API_TOKEN', None)
        print('✓ Engine stopped. The access key no longer works.')
        store = globals().get('model_store')
        if store and store.saving:
            print('• Finishing the Drive save (first session only)…')
            while not store.wait(30):
                print('  still saving to Drive…')
        if store:
            print('✓ Model cache:', store.summary())
        if globals().get('CACHE'):
            from google.colab import drive
            drive.flush_and_unmount()
            print('✓ Drive flushed: the next session reuses everything.')
        print('You can now close the runtime: Runtime → Disconnect and delete runtime.')
''')

md('''
    ## Reference

    **Engines.** With `ENGINE = auto`, GPUs with 22 GB or more and runtimes with 45 GB or more of RAM (L4 High-RAM,
    A100, H100) use the **fast engine**: Qwen-Image 2.1 in diffusers with Alibaba's Fun-Acc adapter, 4 steps per image
    instead of about 28, using the same uncensored UC weights. On an A100 an image or edit takes about 3–5 seconds.
    Smaller GPUs use stable-diffusion.cpp, which is compiled once per GPU type and cached on Drive. Every edit mode works
    on both. Images over about 2.4 MP decode in tiles so 2K output fits in less memory.

    **Drive cache.** Models are saved under *My Drive/StudioZero* in the first session and loaded from there afterwards,
    with no Hugging Face downloads. A copy cut short by a runtime reset is detected by size and fetched again. Cached
    models stay at the version you first downloaded until you tick `UPDATE_MODELS`. In the first session, run
    **Stop and save** before ending the runtime so Drive finishes saving. If Drive is full, sessions still work but
    download again.

    | Feature | Model | Size | Licence |
    |---|---|---|---|
    | Images and edits | [Qwen-Image 2.1 UC](https://huggingface.co/abenzerps/Qwen-Image-2.1-GGUF) | 4.6–14 GB + 19 GB companion (fast engine) | Qwen research licence (non-commercial) |
    | Remove background | BiRefNet (ONNX) | 1 GB | MIT |
    | Improve / Describe | Qwen3-VL-2B Instruct | 4.3 GB | Apache-2.0 |
    | Upscale | Real-ESRGAN x4plus | 67 MB | BSD-3 |
    | Pose | DWPose + YOLOX | 240 MB | Apache-2.0 |
    | Voice | Chatterbox Turbo | 3 GB | MIT (clips carry an inaudible watermark) |
    | Transcribe | faster-whisper base | 145 MB | MIT |
    | Music | MiniMax Music 3 | 28 GB | Show "MiniMax-Music3" in commercial products; disclose AI music |
    | Video | [LTX-2.5](https://huggingface.co/Lightricks/LTX-2.5) distilled Q4_K_M | 44 GB | LTX licence (gated) |

    **Notes on features**
    - *Improve prompt* can use DeepSeek's API instead of the local model: add a Colab secret named `DEEPSEEK_API_KEY`.
      DeepSeek V4 Flash itself (about 167 GB) is too large to run here. Describe always runs on this runtime.
    - *Voice* clones from a clean sample of 10 seconds or more. Only clone voices you have permission to use.
    - *Poses* guide images through Qwen-Image's reference pictures, so results follow the pose closely but not exactly.
    - *Video* needs the gated Lightricks files: accept the licence on Hugging Face, then paste a read token into
      `HF_TOKEN` in Settings (or add it as the Colab secret `HF_TOKEN`). A token typed into Settings is saved in the
      notebook, so clear it before sharing; the secret is not. Only one big model is in GPU memory at a time, so the first video after images (and the first
      image after a video) takes a minute or two to swap.
    - Helper models load on first use. On GPUs with 40 GB or more they stay loaded; on smaller GPUs they unload after use.

    **Troubleshooting.** Logs are in `/content/studio-zero`: `service.log` (the API), `outputs/engine.log` (the image
    engine) and `tunnel.log`. If loading from Drive stalls, tick `COPY_WEIGHTS_TO_LOCAL`. If attention errors appear,
    untick `SAGE_ATTENTION` or `FLASH_ATTENTION` under Advanced settings.

    This notebook is generated by `python scripts/build_notebook.py` in the Studio Zero repository.
''')

notebook = {'cells': cells, 'metadata': {'accelerator': 'GPU', 'kernelspec': {'display_name': 'Python 3', 'language': 'python', 'name': 'python3'}, 'language_info': {'name': 'python'}, 'colab': {'name': 'Studio_Zero_Colab.ipynb', 'provenance': [], 'gpuType': 'A100', 'machine_shape': 'hm', 'toc_visible': True}}, 'nbformat': 4, 'nbformat_minor': 5}
for index, cell in enumerate(cells):
    cell['id'] = f'studio-zero-{index:02d}'
path = ROOT / 'colab' / 'Studio_Zero_Colab.ipynb'
path.parent.mkdir(exist_ok=True)
path.write_text(json.dumps(notebook, indent=2), encoding='utf-8')
print(f'Built {path} ({len(cells)} cells, all Python cells syntax-checked).')
