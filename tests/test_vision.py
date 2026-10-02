import base64
import io
import time

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.app import create_app
from backend.runner import DemoRunner
from backend.vision import (COLORS, LIMBS, STANDING, DemoPoseDetector, PoseDetector, check_upscale_size, draw_pose,
                            split_alpha)

TOKEN = 'test-vision-token-0123456789abcdefghijkl'
AUTH = {'Authorization': 'Bearer ' + TOKEN}


def png(size=(64, 48), mode='RGB', color=(10, 120, 200)):
    buffer = io.BytesIO()
    Image.new(mode, size, color if mode == 'RGB' else color + (0,)).save(buffer, format='PNG')
    return 'data:image/png;base64,' + base64.b64encode(buffer.getvalue()).decode()


def wait(client, path, tries=400):
    for _ in range(tries):
        item = client.get(path, headers=AUTH).json()
        if item['status'] in ('succeeded', 'failed', 'cancelled'):
            return item
        time.sleep(.05)
    raise AssertionError('did not finish')


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(DemoRunner(), TOKEN, tmp_path)) as c:
        yield c


def test_capabilities(client):
    caps = client.get('/health', headers=AUTH).json()['capabilities']
    assert 'upscale' in caps and 'detect-pose' in caps


def test_upscale_job_doubles_size_and_keeps_history(client):
    job = client.post('/upscale', headers=AUTH, json={'image': png(), 'scale': 2}).json()
    done = wait(client, '/jobs/' + job['id'])
    assert done['status'] == 'succeeded', done['message']
    m = done['metadata']
    assert (m['kind'], m['width'], m['height'], m['source_width'], m['scale']) == ('upscale', 128, 96, 64, 2)
    image = Image.open(io.BytesIO(client.get('/outputs/' + job['id'], headers=AUTH).content))
    assert image.size == (128, 96)
    assert 'studio_zero' in image.info  # same metadata stamp as generations


def test_upscale_rejects_oversized_output(client):
    response = client.post('/upscale', headers=AUTH, json={'image': png((2100, 64)), 'scale': 4})
    assert response.status_code == 422 and '8192' in response.json()['detail']
    assert client.post('/upscale', headers=AUTH, json={'image': png(), 'scale': 3}).status_code == 422


def test_detect_pose_task(client):
    task = client.post('/detect-pose', headers=AUTH, json={'image': png((200, 400))}).json()
    done = wait(client, '/tasks/' + task['id'])
    result = done['result']
    assert done['kind'] == 'detect-pose' and result['width'] == 200 and len(result['people']) == 1
    assert len(result['people'][0]) == 18 and all(len(p) == 3 for p in result['people'][0])


def test_missing_vision_helpers(tmp_path):
    with TestClient(create_app(DemoRunner(), TOKEN, tmp_path, vision=(None, None))) as c:
        caps = c.get('/health', headers=AUTH).json()['capabilities']
        assert 'upscale' not in caps and 'detect-pose' not in caps
        assert c.post('/upscale', headers=AUTH, json={'image': png()}).status_code == 501
        assert c.post('/detect-pose', headers=AUTH, json={'image': png()}).status_code == 501


def test_check_upscale_size():
    check_upscale_size(1536, 1536, 4)  # 37.7 MP
    with pytest.raises(ValueError):
        check_upscale_size(2048, 2048, 4)  # 67 MP: over the 48 MP cap
    with pytest.raises(ValueError):
        check_upscale_size(4096, 4096, 4)
    with pytest.raises(ValueError):
        check_upscale_size(4096, 4096, 2)  # 64 MP


def test_split_alpha():
    rgb, alpha = split_alpha(Image.new('RGBA', (4, 4), (1, 2, 3, 0)))
    assert rgb.mode == 'RGB' and alpha is not None
    rgb, alpha = split_alpha(Image.new('RGBA', (4, 4), (1, 2, 3, 255)))
    assert alpha is None  # fully opaque: no alpha work needed


def test_openpose_tables():
    assert len(LIMBS) == 17 and len(COLORS) == 18 and len(STANDING) == 18


def test_draw_pose_draws_coloured_skeleton_and_skips_low_confidence():
    person = [[100 + x * 100, 20 + y * 200, 0.9] for x, y in STANDING]
    image = draw_pose([person], 300, 260)
    assert image.size == (300, 260)
    nose = person[0]
    assert image.getpixel((int(nose[0]), int(nose[1]))) == COLORS[0]
    hidden = [[x, y, 0.1] for x, y, _ in person]
    assert draw_pose([hidden], 300, 260).getbbox() is None


def test_pose_detector_keeps_people_only():
    class Detector:
        def __call__(self, image):
            return np.array([[0, 0, 10, 10], [5, 5, 20, 20]], dtype=float), np.array([0, 56])  # a person and a chair

    class Pose:
        def __init__(self):
            self.boxes = None
        def __call__(self, image, bboxes):
            self.boxes = bboxes
            n = len(bboxes)
            return np.ones((n, 134, 2)), np.full((n, 134), .8)

    pose = Pose()
    detector = PoseDetector(pose_path='x', detector_path='y')
    detector.models, detector.device = (Detector(), pose), 'cpu'
    result = detector.detect(Image.new('RGB', (32, 32)))
    assert len(pose.boxes) == 1 and len(result['people']) == 1 and len(result['people'][0]) == 18


def test_demo_pose_detector_fits_the_image():
    result = DemoPoseDetector().detect(Image.new('RGB', (100, 300)))
    xs = [p[0] for p in result['people'][0]]
    ys = [p[1] for p in result['people'][0]]
    assert 0 <= min(xs) and max(xs) <= 100 and 0 <= min(ys) and max(ys) <= 300


def test_demo_references_are_opt_in_and_visible(tmp_path):
    from backend.runner import DemoRunner as Demo
    assert not getattr(Demo(), 'supports_references', False)
    with TestClient(create_app(Demo(references=True), TOKEN, tmp_path)) as c:
        assert 'reference' in c.get('/health', headers=AUTH).json()['capabilities']
        red = png((64, 64), color=(255, 0, 0))
        job = c.post('/generate', headers=AUTH, json={'prompt': 'x', 'width': 512, 'height': 512, 'reference_images': [red]}).json()
        done = wait(c, '/jobs/' + job['id'])
        image = Image.open(io.BytesIO(c.get('/outputs/' + job['id'], headers=AUTH).content)).convert('RGB')
        assert done['metadata']['reference_count'] == 1 and image.getpixel((image.width - 30, 30)) == (255, 0, 0)
