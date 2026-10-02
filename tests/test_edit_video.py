import base64
import io
import json
import subprocess
import sys
import time
from pathlib import Path
from threading import Event

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from backend.app import create_app
from backend.engines import EngineSet
from backend.runner import (DemoRunner, ResidentQwenRunner, ResidentVideoRunner, find_ffmpeg, offload_wanted,
                            transparent_prompt)
import backend.runner as runner_module
from backend.schema import EditRequest, VideoRequest

TOKEN = 'test-edit-video-token-0123456789abcdef'
AUTH = {'Authorization': 'Bearer ' + TOKEN}
needs_ffmpeg = pytest.mark.skipif(find_ffmpeg() is None, reason='ffmpeg not installed')


def data_url(image, fmt='PNG'):
    buffer = io.BytesIO(); image.save(buffer, format=fmt)
    return f'data:image/{fmt.lower()};base64,' + base64.b64encode(buffer.getvalue()).decode()


def source(size=(256, 256)):
    image = Image.new('RGB', size, (30, 90, 60))
    ImageDraw.Draw(image).rectangle((20, 20, 120, 120), fill=(200, 200, 40))
    return image


def mask(size=(256, 256), box=(128, 128, 256, 256)):
    image = Image.new('L', size, 0)
    ImageDraw.Draw(image).rectangle(box, fill=255)
    return image


def await_job(client, id, tries=300):
    for _ in range(tries):
        job = client.get('/jobs/' + id, headers=AUTH).json()
        if job['status'] in ('succeeded', 'failed', 'cancelled'):
            return job
        time.sleep(.05)
    raise AssertionError('Job did not complete')


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(DemoRunner(), TOKEN, tmp_path)) as c:
        yield c


def test_demo_capabilities(client):
    caps = client.get('/health', headers=AUTH).json()['capabilities']
    for name in ('text-to-image', 'transparent', 'edit', 'inpaint', 'outpaint', 'image-to-image', 'variations'):
        assert name in caps
    assert ('video' in caps) == (find_ffmpeg() is not None)


def test_inpaint_changes_only_the_white_mask_area(client):
    body = {'operation': 'inpaint', 'prompt': 'a lantern', 'width': 256, 'height': 256, 'steps': 4,
            'image': data_url(source()), 'mask': data_url(mask())}
    job = client.post('/edit', json=body, headers=AUTH)
    assert job.status_code == 202, job.text
    job = await_job(client, job.json()['id'])
    assert job['status'] == 'succeeded', job
    meta = job['metadata']
    assert meta['kind'] == 'edit' and meta['operation'] == 'inpaint' and meta['strength'] == 1.0
    assert 'image' not in meta and 'mask' not in meta
    result = Image.open(io.BytesIO(client.get('/outputs/' + job['id'], headers=AUTH).content)).convert('RGB')
    assert result.size == (256, 256)
    assert result.getpixel((60, 60)) == (200, 200, 40)      # outside the mask: kept
    assert result.getpixel((200, 160)) != (30, 90, 60)       # inside: regenerated


def test_edit_validation(client):
    base = {'prompt': 'x', 'width': 256, 'height': 256, 'image': data_url(source())}
    assert client.post('/edit', json={**base, 'operation': 'inpaint'}, headers=AUTH).status_code == 422      # mask required
    assert client.post('/edit', json={**base, 'operation': 'outpaint', 'mask': data_url(mask((128, 128), (0, 0, 64, 64)))}, headers=AUTH).status_code == 422  # wrong size
    assert client.post('/edit', json={**base, 'operation': 'sharpen'}, headers=AUTH).status_code == 422
    assert client.post('/edit', json={**base, 'operation': 'edit', 'image': data_url(source((300, 256)))}, headers=AUTH).status_code == 422
    assert client.post('/edit', json={**base, 'operation': 'image-to-image', 'strength': 2}, headers=AUTH).status_code == 422
    ok = client.post('/edit', json={**base, 'operation': 'image-to-image', 'strength': .3}, headers=AUTH)
    assert ok.status_code == 202 and ok.json()['metadata']['strength'] == .3


def test_instruction_edit_requires_vision_on_a_real_engine(tmp_path):
    class TextOnly(DemoRunner):
        mode = 'qwen'
    with TestClient(create_app(TextOnly(), TOKEN, tmp_path, video_runner=None)) as c:
        caps = c.get('/health', headers=AUTH).json()['capabilities']
        assert 'inpaint' in caps and 'edit' not in caps and 'video' not in caps
        response = c.post('/edit', json={'operation': 'edit', 'prompt': 'x', 'width': 256, 'height': 256, 'image': data_url(source())}, headers=AUTH)
        assert response.status_code == 422 and 'vision encoder' in response.json()['detail']
        assert c.post('/video', json={'prompt': 'x'}, headers=AUTH).status_code == 501


def test_transparent_generation_is_rgba(client):
    job = client.post('/generate', json={'prompt': 'a potion', 'width': 256, 'height': 256, 'transparent': True}, headers=AUTH).json()
    job = await_job(client, job['id'])
    assert job['metadata']['transparent'] is True and job['metadata']['kind'] == 'image'
    image = Image.open(io.BytesIO(client.get('/outputs/' + job['id'], headers=AUTH).content))
    assert image.mode == 'RGBA' and image.getpixel((2, 2))[3] == 0 and image.getpixel((128, 128))[3] == 255


@needs_ffmpeg
def test_demo_video_is_browser_mp4(client, tmp_path):
    assert client.post('/video', json={'prompt': 'x', 'frames': 20}, headers=AUTH).status_code == 422   # not 8n+1
    assert client.post('/video', json={'prompt': 'x', 'width': 700}, headers=AUTH).status_code == 422
    job = client.post('/video', json={'prompt': 'a comet', 'width': 256, 'height': 256, 'frames': 17, 'fps': 12,
                                      'image': data_url(source())}, headers=AUTH)
    assert job.status_code == 202, job.text
    job = await_job(client, job.json()['id'])
    assert job['status'] == 'succeeded', job
    assert job['metadata']['kind'] == 'video' and job['metadata']['frames'] == 17 and job['metadata']['start_image'] is True
    response = client.get('/outputs/' + job['id'], headers=AUTH)
    assert response.headers['content-type'] == 'video/mp4' and response.content[4:8] == b'ftyp'
    width, height, frames, fps = runner_module.video_info(tmp_path / f"{job['id']}.mp4")
    assert (width, height, frames) == (256, 256, 17) and fps == 12


def test_resident_edit_payload_mapping(tmp_path, monkeypatch):
    vision = tmp_path / 'vision.gguf'; vision.write_bytes(b'v')
    monkeypatch.setenv('ZERO_VISION_ENCODER', str(vision))
    runner = ResidentQwenRunner()
    image, m = data_url(source()), data_url(mask())
    common = {'prompt': 'a red hat', 'width': 256, 'height': 256, 'seed': 3}
    inpaint = runner.edit_payload(EditRequest(operation='inpaint', image=image, mask=m, **common))
    assert inpaint['init_image'] == image and inpaint['mask_image'] == m and inpaint['strength'] == 1.0
    assert inpaint['ref_images'] == [image]       # the vision encoder sees the source for context
    instruction = runner.edit_payload(EditRequest(operation='edit', image=image, **common))
    assert 'init_image' not in instruction and instruction['ref_images'] == [image]
    i2i = runner.edit_payload(EditRequest(operation='image-to-image', image=image, strength=.4, transparent=True, **common))
    assert i2i['strength'] == .4 and i2i['ref_images'] == [] and 'mask_image' not in i2i
    assert i2i['prompt'] == transparent_prompt('a red hat') and 'RGBA' in i2i['prompt']
    assert 'vae_tiling_params' not in i2i
    big = runner.payload(EditRequest(operation='edit', image=data_url(source((2048, 2048))), prompt='x', width=2048, height=2048))
    assert big['vae_tiling_params'] == {'enabled': True}
    monkeypatch.delenv('ZERO_VISION_ENCODER')
    no_vision = ResidentQwenRunner().edit_payload(EditRequest(operation='inpaint', image=image, mask=m, **common))
    assert no_vision['ref_images'] == []


def test_offload_auto_uses_gpu_memory(tmp_path, monkeypatch):
    weight = tmp_path / 'w.gguf'
    with weight.open('wb') as f:
        f.truncate(4 * 2**30)   # sparse 4 GiB file
    monkeypatch.setattr(runner_module, '_gpu_memory', [24.0])
    assert offload_wanted([weight]) is False                 # 4 + 6 headroom < 24
    monkeypatch.setattr(runner_module, '_gpu_memory', [8.0])
    assert offload_wanted([weight]) is True
    monkeypatch.setattr(runner_module, '_gpu_memory', [None])
    assert offload_wanted([weight]) is True                  # unknown GPU: stay safe
    monkeypatch.setenv('ZERO_OFFLOAD', 'off')
    assert offload_wanted([weight]) is False
    monkeypatch.setenv('ZERO_OFFLOAD', 'on')
    monkeypatch.setattr(runner_module, '_gpu_memory', [80.0])
    assert offload_wanted([weight]) is True


def test_video_runner_command_and_payload(tmp_path, monkeypatch):
    for name in ('ZERO_SD_SERVER', 'ZERO_VIDEO_DIFFUSION', 'ZERO_VIDEO_TEXT_ENCODER', 'ZERO_VIDEO_VAE', 'ZERO_VIDEO_AUDIO_VAE'):
        (tmp_path / name).write_text('x'); monkeypatch.setenv(name, str(tmp_path / name))
    monkeypatch.setenv('ZERO_OFFLOAD', 'on'); monkeypatch.setenv('ZERO_SAGE_ATTENTION', '1')
    runner = ResidentVideoRunner()
    argv = runner.command()
    assert argv[argv.index('--audio-vae') + 1] == str(tmp_path / 'ZERO_VIDEO_AUDIO_VAE')
    assert argv[argv.index('--listen-port') + 1] == '18432' and '--offload-to-cpu' in argv and '--sage-attn' in argv
    assert '--embeddings-connectors' not in argv
    payload = runner.payload(VideoRequest(prompt='waves', frames=49, fps=24, seed=5, image=data_url(source())))
    assert payload['video_frames'] == 49 and payload['output_format'] == 'avi' and payload['init_image'].startswith('data:image/png')
    assert payload['vae_tiling_params']['temporal_tiling'] is True and 'end_image' not in payload


class FakeResident:
    def __init__(self, label):
        self.label, self.model, self.mode = label, label + '-model', 'qwen'
        self.status, self.events = 'stopped', []
    def start(self):
        self.events.append('start'); self.status = 'ready'
    def stop(self):
        self.events.append('stop'); self.status = 'stopped'
    def state(self):
        return {'engine': self.status, 'loaded_in_seconds': None}
    def readiness(self):
        return self.status == 'ready', self.status
    def missing(self):
        return []


def test_engine_set_swaps_one_model_at_a_time():
    image, video = FakeResident('image'), FakeResident('video')
    engines = EngineSet(image, video, swap=True)
    engines.start()
    assert image.status == 'ready' and video.status == 'stopped'
    assert engines.readiness('video') == (True, engines.readiness('video')[1])   # loads on demand
    messages = []
    assert engines.acquire('video', Event(), lambda value, message: messages.append(message)) is video
    assert image.status == 'stopped' and video.status == 'ready' and any('Unloading' in m for m in messages)
    assert engines.readiness('image')[0] is True
    engines.acquire('image', Event(), lambda *a: None)
    assert image.status == 'ready' and video.status == 'stopped'
    both = EngineSet(FakeResident('image'), FakeResident('video'), swap=False)
    both.start(); both.acquire('video', Event(), lambda *a: None)
    assert both.runner('image').status == 'ready' and both.runner('video').status == 'ready'


FAKE_VIDEO_ENGINE = r'''
import base64, json, subprocess, sys, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
port = int(sys.argv[sys.argv.index("--listen-port") + 1]); record, ffmpeg = sys.argv[1], sys.argv[2]
jobs, lock = {}, threading.Lock()
def finish(job_id, body):
    folder = Path(tempfile.mkdtemp()); avi = folder / "v.avi"
    subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-f", "lavfi", "-i", f"testsrc=size={body['width']}x{body['height']}:rate={body['fps']}",
                    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=24000", "-frames:v", str(body["video_frames"]), "-shortest",
                    "-c:v", "mjpeg", "-c:a", "pcm_s16le", str(avi)], check=True)
    with lock:
        jobs[job_id].update(status="completed", result={"output_format": "avi", "mime_type": "video/x-msvideo", "b64_json": base64.b64encode(avi.read_bytes()).decode()})
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def send(self, code, payload):
        data = json.dumps(payload).encode(); self.send_response(code)
        self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
    def do_GET(self):
        if self.path == "/sdcpp/v1/capabilities": return self.send(200, {"current_mode": "vid_gen"})
        job_id = self.path.rsplit("/", 1)[-1]
        with lock:
            return self.send(200, jobs[job_id]) if job_id in jobs else self.send(404, {})
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])) or b"{}")
        if self.path == "/sdcpp/v1/vid_gen":
            with open(record, "a") as f: f.write(json.dumps({k: v for k, v in body.items() if k != "init_image"}) + "\n")
            with lock:
                job_id = "v%d" % (len(jobs) + 1); jobs[job_id] = {"id": job_id, "status": "generating", "queue_position": 0}
            threading.Thread(target=finish, args=(job_id, body), daemon=True).start()
            return self.send(202, {"id": job_id})
        return self.send(404, {})
ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
'''


@needs_ffmpeg
def test_real_engine_path_swaps_image_and_video_and_converts_to_mp4(tmp_path, monkeypatch):
    import socket
    from tests.test_service import FAKE_ENGINE
    def port():
        with socket.socket() as s:
            s.bind(('127.0.0.1', 0)); return str(s.getsockname()[1])
    for name in ('ZERO_SD_SERVER', 'ZERO_DIFFUSION', 'ZERO_TEXT_ENCODER', 'ZERO_VAE', 'ZERO_VIDEO_DIFFUSION',
                 'ZERO_VIDEO_TEXT_ENCODER', 'ZERO_VIDEO_VAE', 'ZERO_VIDEO_AUDIO_VAE'):
        (tmp_path / name).write_text('x'); monkeypatch.setenv(name, str(tmp_path / name))
    monkeypatch.setenv('ZERO_ENGINE_PORT', port()); monkeypatch.setenv('ZERO_VIDEO_ENGINE_PORT', port())
    monkeypatch.setenv('ZERO_OUTPUT_DIR', str(tmp_path / 'out'))
    (tmp_path / 'image_engine.py').write_text(FAKE_ENGINE); (tmp_path / 'video_engine.py').write_text(FAKE_VIDEO_ENGINE)
    image, video = ResidentQwenRunner(), ResidentVideoRunner()
    image_argv, video_argv = image.command(), video.command()
    monkeypatch.setattr(image, 'command', lambda: [sys.executable, str(tmp_path / 'image_engine.py'), str(tmp_path / 'img.jsonl'), '0.2', *image_argv[1:]])
    monkeypatch.setattr(video, 'command', lambda: [sys.executable, str(tmp_path / 'video_engine.py'), str(tmp_path / 'vid.jsonl'), find_ffmpeg(), *video_argv[1:]])
    with TestClient(create_app(image, TOKEN, tmp_path / 'out', matter=None, video_runner=video, engine_swap=True)) as c:
        for _ in range(100):
            if c.get('/health', headers=AUTH).json()['ready']:
                break
            time.sleep(.1)
        health = c.get('/health', headers=AUTH).json()
        assert 'video' in health['capabilities'] and health['video_engine'] == 'stopped' and health['engine_swap'] is True
        first_image_pid = image.process.pid
        job = c.post('/video', json={'prompt': 'surf', 'width': 256, 'height': 320, 'frames': 25, 'fps': 24, 'steps': 4,
                                     'image': data_url(source((256, 320)))}, headers=AUTH).json()
        job = await_job(c, job['id'], tries=600)
        assert job['status'] == 'succeeded', job
        assert image.process is None and video.process is not None        # image engine was unloaded
        response = c.get('/outputs/' + job['id'], headers=AUTH)
        assert response.headers['content-type'] == 'video/mp4'
        width, height, frames, fps = runner_module.video_info(tmp_path / 'out' / f"{job['id']}.mp4")
        assert (width, height, frames) == (256, 320, 25)
        probe = subprocess.run([find_ffmpeg(), '-hide_banner', '-i', str(tmp_path / 'out' / f"{job['id']}.mp4")], capture_output=True, text=True).stderr
        assert 'Audio: aac' in probe                                         # engine audio survives conversion
        sent = json.loads((tmp_path / 'vid.jsonl').read_text().splitlines()[0])
        assert sent['video_frames'] == 25 and sent['sample_params']['sample_steps'] == 4
        image_job = c.post('/generate', json={'prompt': 'hills', 'width': 256, 'height': 256}, headers=AUTH)
        assert image_job.status_code == 202, image_job.text                  # accepted while unloaded
        image_job = await_job(c, image_job.json()['id'], tries=600)
        assert image_job['status'] == 'succeeded', image_job
        assert video.process is None and image.process is not None and image.process.pid != first_image_pid


@needs_ffmpeg
def test_webm_video_option(tmp_path, monkeypatch):
    monkeypatch.setenv('ZERO_VIDEO_FORMAT', 'webm')
    with TestClient(create_app(DemoRunner(), TOKEN, tmp_path)) as c:
        job = c.post('/video', json={'prompt': 'a comet', 'width': 256, 'height': 256, 'frames': 9, 'fps': 12}, headers=AUTH).json()
        assert job['metadata']['format'] == 'webm'
        job = await_job(c, job['id'])
        assert job['status'] == 'succeeded', job
        response = c.get('/outputs/' + job['id'], headers=AUTH)
        assert response.headers['content-type'] == 'video/webm' and response.content[:4] == b'\x1a\x45\xdf\xa3'
        assert runner_module.video_info(tmp_path / f"{job['id']}.webm")[2] == 9


def test_swap_also_unloads_video_for_command_line_image_runner():
    video = FakeResident('video')
    engines = EngineSet(DemoRunner(), video, swap=True)
    engines.acquire('video', Event(), lambda *a: None)
    assert video.status == 'ready'
    runner = engines.acquire('image', Event(), lambda *a: None)
    assert isinstance(runner, DemoRunner) and video.status == 'stopped'   # GPU freed for the per-job runner


def test_readiness_of_the_outgoing_engine_never_restarts_it():
    image, video = FakeResident('image'), FakeResident('video')
    engines = EngineSet(image, video, swap=True)
    engines.start()
    seen = []
    def progress(value, message):
        # Mid-swap: a concurrent /health must not auto-start the image engine again.
        seen.append(engines.readiness('image'))
    engines.acquire('video', Event(), progress)
    assert image.events == ['start', 'stop'] and video.status == 'ready'
    assert seen and all(ready for ready, _ in seen)
