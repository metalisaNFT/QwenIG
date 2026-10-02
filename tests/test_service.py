import io
import json
import sys
import time
from threading import Event
import pytest
from fastapi.testclient import TestClient
from PIL import Image
from backend.app import create_app
from backend.runner import Cancelled, DemoRunner, QwenRunner
from backend.schema import GenerateRequest

TOKEN = "test-only-token-0123456789abcdef"
AUTH = {"Authorization": "Bearer " + TOKEN}

@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(DemoRunner(), TOKEN, tmp_path)) as c:
        yield c

def await_job(client, id):
    for _ in range(100):
        result = client.get('/jobs/' + id, headers=AUTH).json()
        if result['status'] in ('succeeded', 'failed', 'cancelled'):
            return result
        time.sleep(.04)
    raise AssertionError('Job did not complete')

def test_auth_and_cors(client):
    assert client.get('/health').status_code == 401
    assert client.get('/jobs').status_code == 401
    assert client.get('/health', headers=AUTH).json()['mode'] == 'demo'
    response = client.options('/generate', headers={'Origin': 'http://localhost:5173', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type'})
    assert response.headers['access-control-allow-origin'] == 'http://localhost:5173'
    assert client.options('/generate', headers={'Origin': 'https://untrusted.example', 'Access-Control-Request-Method': 'POST'}).status_code == 400
    assert client.get('/outputs/unknown').status_code == 401

def test_browser_connection_origin_must_match_api_configuration(tmp_path, monkeypatch):
    monkeypatch.delenv('ZERO_ALLOWED_ORIGINS', raising=False)
    def preflight(client, origin):
        return client.options('/health', headers={
            'Origin': origin,
            'Access-Control-Request-Method': 'GET',
            'Access-Control-Request-Headers': 'authorization',
        })
    with TestClient(create_app(DemoRunner(), TOKEN, tmp_path)) as client:
        assert preflight(client, 'http://127.0.0.1:5173').headers['access-control-allow-origin'] == 'http://127.0.0.1:5173'
        rejected = preflight(client, 'http://127.0.0.1:5174')
        assert rejected.status_code == 400
        assert 'access-control-allow-origin' not in rejected.headers
    monkeypatch.setenv('ZERO_ALLOWED_ORIGINS', 'http://127.0.0.1:5174')
    with TestClient(create_app(DemoRunner(), TOKEN, tmp_path)) as client:
        assert preflight(client, 'http://127.0.0.1:5174').headers['access-control-allow-origin'] == 'http://127.0.0.1:5174'
        assert preflight(client, 'https://untrusted.example').status_code == 400


def test_generate_download_metadata_and_restart(client, tmp_path):
    response = client.post('/generate', json={'prompt': 'quiet hills', 'width': 256, 'height': 320, 'seed': -1}, headers=AUTH)
    assert response.status_code == 202
    id = response.json()['id']; job = await_job(client, id)
    assert job['status'] == 'succeeded', job
    assert job['metadata']['seed'] >= 0
    assert client.get('/jobs', headers=AUTH).json()[0]['id'] == id
    output = client.get('/outputs/' + id, headers=AUTH)
    assert output.status_code == 200
    image = Image.open(io.BytesIO(output.content)); assert image.size == (256, 320)
    assert json.loads(image.info['studio_zero']) == job['metadata']
    assert client.post('/jobs/' + id + '/cancel', json={}, headers=AUTH).json()['status'] == 'succeeded'
    with TestClient(create_app(DemoRunner(), TOKEN, tmp_path)) as restarted:
        assert restarted.get('/jobs/' + id, headers=AUTH).json()['status'] == 'succeeded'
        assert restarted.get('/outputs/' + id, headers=AUTH).status_code == 200
        assert restarted.get('/jobs', headers=AUTH).json()[0]['metadata'] == job['metadata']

def test_validation_cancel_and_extension_contract(client):
    assert client.post('/generate', json={'prompt': '   '}, headers=AUTH).status_code == 422
    assert client.post('/generate', json={'prompt': 'x', 'width': 513}, headers=AUTH).status_code == 422
    assert client.post('/generate', json={'prompt': 'x', 'steps': 0}, headers=AUTH).status_code == 422
    id = client.post('/generate', json={'prompt': 'x'}, headers=AUTH).json()['id']
    assert client.post('/jobs/' + id + '/cancel', json={}, headers=AUTH).json()['status'] == 'cancelled'
    assert client.get('/outputs/' + id, headers=AUTH).status_code == 409
    assert client.post('/edit', json={'operation': 'inpaint', 'source_asset_id': 'x', 'settings': {'prompt': 'x'}}, headers=AUTH).status_code == 422
    assert client.get('/jobs/not-a-job', headers=AUTH).status_code == 404

def test_runner_failure_visible(tmp_path):
    class Broken(DemoRunner):
        def generate(self, *args):
            raise RuntimeError('Test engine failed')
    with TestClient(create_app(Broken(), TOKEN, tmp_path)) as c:
        id = c.post('/generate', json={'prompt': 'x'}, headers=AUTH).json()['id']
        assert await_job(c, id)['message'] == 'Test engine failed'

def test_qwen_command_and_process_cancellation(tmp_path, monkeypatch):
    r = QwenRunner(); request = GenerateRequest(prompt='a "quoted" idea; not a shell command', seed=42)
    argv = r.command(request, tmp_path / 'out.png')
    assert argv[argv.index('-p') + 1] == request.prompt
    assert argv[argv.index('--seed') + 1] == '42'
    monkeypatch.setattr(r, 'readiness', lambda: (True, 'ok'))
    monkeypatch.setattr(r, 'command', lambda req, out: [sys.executable, '-c', 'import time; time.sleep(30)'])
    cancel = Event(); cancel.set(); start = time.monotonic()
    with pytest.raises(Cancelled):
        r.generate(request, tmp_path / 'out.png', cancel, lambda *_: None)
    assert time.monotonic() - start < 5

def test_missing_weights_not_ready(tmp_path):
    with TestClient(create_app(QwenRunner(), TOKEN, tmp_path)) as c:
        assert c.get('/health', headers=AUTH).json()['ready'] is False
        assert c.post('/generate', json={'prompt': 'x'}, headers=AUTH).status_code == 503


FAKE_ENGINE = r'''
import base64, io, json, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from PIL import Image
port = int(sys.argv[sys.argv.index("--listen-port") + 1]); record = sys.argv[1]
time.sleep(float(sys.argv[2]))  # simulated one-time weight loading
jobs, lock = {}, threading.Lock()
def finish(job_id, body):
    time.sleep(0.3)
    with lock:
        if jobs[job_id]["status"] == "cancelled":
            return
    buffer = io.BytesIO(); Image.new("RGB", (body["width"], body["height"]), "#335544").save(buffer, "PNG")
    with lock:
        jobs[job_id].update(status="completed", result={"output_format": "png", "images": [{"index": 0, "b64_json": base64.b64encode(buffer.getvalue()).decode()}]})
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def send(self, code, payload):
        data = json.dumps(payload).encode(); self.send_response(code)
        self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)
    def do_GET(self):
        if self.path == "/sdcpp/v1/capabilities": return self.send(200, {"current_mode": "img_gen"})
        job_id = self.path.rsplit("/", 1)[-1]
        with lock:
            return self.send(200, jobs[job_id]) if job_id in jobs else self.send(404, {})
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])) or b"{}")
        if self.path == "/sdcpp/v1/img_gen":
            with open(record, "a") as f: f.write(json.dumps(body) + "\n")
            with lock:
                job_id = "job_%d" % (len(jobs) + 1); jobs[job_id] = {"id": job_id, "status": "generating", "queue_position": 0, "result": None, "error": None}
            threading.Thread(target=finish, args=(job_id, body), daemon=True).start()
            return self.send(202, {"id": job_id, "status": "queued"})
        job_id = self.path.split("/")[-2]
        with lock:
            jobs[job_id]["status"] = "cancelled"
        return self.send(200, jobs[job_id])
ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
'''


def resident_runner(tmp_path, monkeypatch, load_seconds=1.0):
    import socket
    for name in ("ZERO_SD_SERVER", "ZERO_DIFFUSION", "ZERO_TEXT_ENCODER", "ZERO_VAE"):
        (tmp_path / name).write_text("x"); monkeypatch.setenv(name, str(tmp_path / name))
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0)); monkeypatch.setenv("ZERO_ENGINE_PORT", str(s.getsockname()[1]))
    monkeypatch.setenv("ZERO_ENGINE_LOG", str(tmp_path / "engine.log"))
    from backend.runner import ResidentQwenRunner
    script = tmp_path / "fake_engine.py"; script.write_text(FAKE_ENGINE)
    runner = ResidentQwenRunner(); record = tmp_path / "requests.jsonl"
    real = runner.command()
    assert real[:2] == [str(tmp_path / "ZERO_SD_SERVER"), "--diffusion-model"] and "--listen-ip" in real and real[real.index("--listen-ip") + 1] == "127.0.0.1"
    monkeypatch.setattr(runner, "command", lambda: [sys.executable, str(script), str(record), str(load_seconds), *real[1:]])
    return runner, record


def test_resident_engine_loads_once_and_reuses_model(tmp_path, monkeypatch):
    runner, record = resident_runner(tmp_path, monkeypatch)
    with TestClient(create_app(runner, TOKEN, tmp_path / "out")) as c:
        health = c.get('/health', headers=AUTH).json()
        assert health['ready'] is False and health['engine'] == 'loading'
        assert c.post('/generate', json={'prompt': 'x'}, headers=AUTH).status_code == 503
        for _ in range(100):
            health = c.get('/health', headers=AUTH).json()
            if health['ready']:
                break
            time.sleep(.1)
        assert health['engine'] == 'ready' and health['loaded_in_seconds'] is not None
        pid = runner.process.pid
        ids = [c.post('/generate', json={'prompt': 'hills', 'width': 256, 'height': 320, 'steps': 12, 'guidance': 4.5, 'seed': 7}, headers=AUTH).json()['id'] for _ in range(2)]
        for id in ids:
            job = await_job(c, id)
            assert job['status'] == 'succeeded', job
            image = Image.open(io.BytesIO(c.get('/outputs/' + id, headers=AUTH).content)); assert image.size == (256, 320)
        assert runner.process.pid == pid  # same resident process served both images
        sent = [json.loads(line) for line in record.read_text().splitlines()]
        assert len(sent) == 2 and sent[0]['seed'] == 7 and sent[0]['sample_params'] == {'sample_method': 'euler', 'sample_steps': 12, 'guidance': {'txt_cfg': 4.5}}
    assert runner.process is None  # shutdown stops the engine


def test_resident_engine_crash_is_reported(tmp_path, monkeypatch):
    runner, _ = resident_runner(tmp_path, monkeypatch, load_seconds=0.2)
    runner.start()
    for _ in range(100):
        if runner.readiness()[0]:
            break
        time.sleep(.1)
    runner.process.kill(); runner.process.wait()
    ready, message = runner.readiness()
    assert not ready and 'stopped unexpectedly' in message
    runner.stop()


def test_resident_engine_cancellation_returns_quickly(tmp_path, monkeypatch):
    runner, _ = resident_runner(tmp_path, monkeypatch, load_seconds=0.2)
    runner.start()
    for _ in range(100):
        if runner.readiness()[0]:
            break
        time.sleep(.1)
    cancel = Event(); cancel.set(); start = time.monotonic()
    with pytest.raises(Cancelled):
        runner.generate(GenerateRequest(prompt='x', width=256, height=256, seed=1), tmp_path / 'o.png', cancel, lambda *_: None)
    assert time.monotonic() - start < 3 and runner.readiness()[0]
    runner.stop()
