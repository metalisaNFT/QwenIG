import base64
import io
import time
from threading import Event

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from backend.app import create_app
from backend.matting import BiRefNetMatter, DemoMatter
from backend.runner import DemoRunner

TOKEN = 'test-matting-token-0123456789abcdef'
AUTH = {'Authorization': 'Bearer ' + TOKEN}


def subject_image(size=(300, 200), mode='RGB'):
    image = Image.new(mode, size, (30, 160, 90, 255) if mode == 'RGBA' else (30, 160, 90))
    ImageDraw.Draw(image).ellipse((100, 50, 200, 150), fill=(230, 60, 40, 255) if mode == 'RGBA' else (230, 60, 40))
    return image


def data_url(image, fmt='PNG'):
    buffer = io.BytesIO(); image.save(buffer, format=fmt)
    return f'data:image/{fmt.lower()};base64,' + base64.b64encode(buffer.getvalue()).decode()


def await_task(client, id):
    for _ in range(200):
        task = client.get('/tasks/' + id, headers=AUTH).json()
        if task['status'] in ('succeeded', 'failed', 'cancelled'):
            return task
        time.sleep(.02)
    raise AssertionError('Task did not finish')


def test_demo_service_advertises_and_returns_a_same_size_mask(tmp_path):
    with TestClient(create_app(DemoRunner(), TOKEN, tmp_path)) as client:
        health = client.get('/health', headers=AUTH).json()
        assert 'remove-background' in health['capabilities']
        assert health['matting_mode'] == 'demo'
        response = client.post('/remove-background', json={'image': data_url(subject_image(), 'JPEG')}, headers=AUTH)
        assert response.status_code == 202, response.text
        task = await_task(client, response.json()['id'])
        assert task['status'] == 'succeeded' and task['demo'] is True
        assert (task['width'], task['height']) == (300, 200)
        mask = Image.open(io.BytesIO(client.get(f"/tasks/{task['id']}/mask", headers=AUTH).content))
        assert mask.mode == 'L' and mask.size == (300, 200)
        assert mask.getpixel((150, 100)) == 255 and mask.getpixel((10, 10)) == 0
        # Background removal is not generation history.
        assert client.get('/jobs', headers=AUTH).json() == []


def test_transparent_pixels_stay_hidden_in_the_demo_mask():
    image = subject_image(mode='RGBA')
    ImageDraw.Draw(image).rectangle((140, 90, 160, 110), fill=(230, 60, 40, 0))
    assert DemoMatter().matte(image).getpixel((150, 100)) < 40


def test_validation_auth_and_missing_engine_support(tmp_path):
    with TestClient(create_app(DemoRunner(), TOKEN, tmp_path)) as client:
        assert client.post('/remove-background', json={'image': data_url(subject_image())}).status_code == 401
        for bad in ['https://example.com/a.png', 'data:image/png;base64,AAAA', 'data:image/gif;base64,R0lGOD']:
            assert client.post('/remove-background', json={'image': bad}, headers=AUTH).status_code == 422
        assert client.get('/tasks/unknown', headers=AUTH).status_code == 404
        assert client.get('/tasks/unknown/mask').status_code == 401
    with TestClient(create_app(DemoRunner(), TOKEN, tmp_path, matter=None)) as client:
        assert 'remove-background' not in client.get('/health', headers=AUTH).json()['capabilities']
        assert client.post('/remove-background', json={'image': data_url(subject_image())}, headers=AUTH).status_code == 501


class SlowMatter(DemoMatter):
    def __init__(self):
        self.release = Event()

    def matte(self, image):
        self.release.wait(5)
        return super().matte(image)


def test_queued_tasks_cancel_and_masks_are_not_served_early(tmp_path):
    matter = SlowMatter()
    with TestClient(create_app(DemoRunner(), TOKEN, tmp_path, matter=matter)) as client:
        first = client.post('/remove-background', json={'image': data_url(subject_image())}, headers=AUTH).json()
        second = client.post('/remove-background', json={'image': data_url(subject_image())}, headers=AUTH).json()
        assert client.get(f"/tasks/{first['id']}/mask", headers=AUTH).status_code == 409
        assert client.post(f"/tasks/{second['id']}/cancel", json={}, headers=AUTH).json()['status'] == 'cancelled'
        matter.release.set()
        assert await_task(client, first['id'])['status'] == 'succeeded'
        assert await_task(client, second['id'])['status'] == 'cancelled'
        assert client.get(f"/tasks/{second['id']}/mask", headers=AUTH).status_code == 409


def test_large_images_fit_the_upload_limit(tmp_path):
    # A 2048 px PNG of noise is several MB: accepted by the image route's larger body limit.
    import random
    noisy = Image.frombytes('RGB', (1024, 1024), random.Random(3).randbytes(1024 * 1024 * 3))
    body = data_url(noisy)
    assert len(body) > 128 * 1024
    with TestClient(create_app(DemoRunner(), TOKEN, tmp_path)) as client:
        assert client.post('/remove-background', json={'image': body}, headers=AUTH).status_code == 202


class FakeSession:
    """Stands in for onnxruntime: returns logits that are high inside the centre square."""
    def __init__(self, dtype='tensor(float)', fail=False):
        self.dtype, self.fail, self.seen = dtype, fail, None

    def get_inputs(self):
        return [type('Input', (), {'name': 'input_image', 'type': self.dtype})()]

    def get_outputs(self):
        return [type('Output', (), {'name': 'output_image'})()]

    def run(self, names, feed):
        import numpy as np
        if self.fail:
            raise RuntimeError('CUDA out of memory')
        self.seen = feed['input_image']
        logits = np.full((1, 1, 64, 64), -12.0, dtype=np.float32)
        logits[..., 16:48, 16:48] = 12.0
        return [logits]


def ready_matter(monkeypatch, tmp_path, session):
    model = tmp_path / 'model.onnx'; model.write_bytes(b'onnx')
    monkeypatch.setenv('ZERO_MATTING_MODEL', str(model))
    monkeypatch.setenv('ZERO_MATTING_SIZE', '64')
    matter = BiRefNetMatter()
    matter.session, matter.device, matter.status = session, 'cuda', 'ready'
    return matter


def test_birefnet_preprocessing_and_sigmoid_mask(monkeypatch, tmp_path):
    np = pytest.importorskip('numpy')
    session = FakeSession()
    matter = ready_matter(monkeypatch, tmp_path, session)
    mask = matter.matte(subject_image((320, 160)))
    assert session.seen.shape == (1, 3, 64, 64) and session.seen.dtype == np.float32
    # ImageNet normalisation: the green background's red channel is well below zero.
    assert session.seen[0, 0, 0, 0] < -1.5
    assert mask.size == (320, 160) and mask.mode == 'L'
    assert mask.getpixel((160, 80)) == 255 and mask.getpixel((5, 5)) == 0
    half = FakeSession('tensor(float16)')
    ready_matter(monkeypatch, tmp_path, half).matte(subject_image())
    assert half.seen.dtype == np.float16


def test_gpu_failure_falls_back_to_cpu_once(monkeypatch, tmp_path):
    pytest.importorskip('numpy')
    matter = ready_matter(monkeypatch, tmp_path, FakeSession(fail=True))
    cpu = FakeSession()
    monkeypatch.setattr(matter, '_session', lambda cpu_only=False: (cpu, 'cpu'))
    assert matter.matte(subject_image()).getpixel((150, 100)) == 255
    assert matter.device == 'cpu' and matter.session is cpu


def test_real_engine_without_model_reports_how_to_enable(monkeypatch, tmp_path):
    monkeypatch.setenv('ZERO_MATTING_MODEL', str(tmp_path / 'missing.onnx'))
    ready, message = BiRefNetMatter().readiness()
    assert not ready and 'Colab notebook' in message


def test_onnx_runtime_session_end_to_end(monkeypatch, tmp_path):
    """Runs the real ONNX Runtime path with a tiny model sharing BiRefNet's input/output contract."""
    onnx = pytest.importorskip('onnx')
    pytest.importorskip('onnxruntime')
    from onnx import TensorProto, helper
    node = helper.make_node('ReduceMean', ['input_image', 'axes'], ['output_image'], keepdims=1)
    graph = helper.make_graph([node], 'mean', [helper.make_tensor_value_info('input_image', TensorProto.FLOAT, [1, 3, 64, 64])],
                              [helper.make_tensor_value_info('output_image', TensorProto.FLOAT, [1, 1, 64, 64])],
                              [helper.make_tensor('axes', TensorProto.INT64, [1], [1])])
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid('', 18)])
    model.ir_version = 9
    path = tmp_path / 'tiny.onnx'; onnx.save(model, path)
    monkeypatch.setenv('ZERO_MATTING_MODEL', str(path))
    monkeypatch.setenv('ZERO_MATTING_SIZE', '64')
    matter = BiRefNetMatter(); matter.start()
    for _ in range(200):
        if matter.state()['matting'] != 'loading':
            break
        time.sleep(.02)
    assert matter.readiness()[0], matter.readiness()
    mask = matter.matte(Image.new('RGB', (100, 50), 'white'))
    # White normalises to positive values: sigmoid(mean) > 0.5 everywhere.
    assert mask.size == (100, 50) and mask.getpixel((50, 25)) > 200


def test_notebook_downloads_and_smoke_tests_background_removal():
    import json
    from pathlib import Path
    root = Path(__file__).resolve().parents[1]
    notebook = json.loads((root / 'colab' / 'Studio_Zero_Colab.ipynb').read_text(encoding='utf-8'))
    code = '\n'.join(''.join(c['source']) for c in notebook['cells'] if c['cell_type'] == 'code')
    assert "MATTING_REPO = 'onnx-community/BiRefNet-ONNX'" in code
    assert "('ZERO_MATTING_MODEL', MATTING_REPO, MATTING_FILE)" in code
    assert 'onnxruntime-gpu' in code and "check('Background removal'" in code
    assert 'backend/matting.py' in code  # bundled with the API sources
