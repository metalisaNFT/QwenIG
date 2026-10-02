import base64
import io
import json
import random
import time
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image

from backend.app import create_app
from backend.runner import DemoRunner, ResidentQwenRunner
from backend.schema import GenerateRequest

TOKEN = 'test-reference-token-0123456789abcdef'
AUTH = {'Authorization': 'Bearer ' + TOKEN}

def reference(color='red', noisy=False):
    image = Image.frombytes('RGB', (512, 512), random.Random(7).randbytes(512 * 512 * 3)) if noisy else Image.new('RGB', (32, 32), color)
    buffer = io.BytesIO(); image.save(buffer, format='PNG')
    return 'data:image/png;base64,' + base64.b64encode(buffer.getvalue()).decode()

class ReferenceRunner(DemoRunner):
    supports_references = True

    def generate(self, request, output, cancelled, progress):
        self.received = request.reference_images
        Image.new('RGB', (request.width, request.height), 'blue').save(output)

def test_references_reach_runner_in_order_and_stay_out_of_job_metadata(tmp_path):
    runner = ReferenceRunner()
    images = [reference(noisy=True), reference('green')]
    assert len(images[0]) > 128 * 1024
    with TestClient(create_app(runner, TOKEN, tmp_path)) as client:
        assert 'reference' in client.get('/health', headers=AUTH).json()['capabilities']
        response = client.post('/generate', json={'prompt':'Use image 1 and image 2', 'width':256, 'height':320, 'reference_images':images}, headers=AUTH)
        assert response.status_code == 202, response.text[:200]
        job = response.json()
        for _ in range(100):
            job = client.get('/jobs/' + job['id'], headers=AUTH).json()
            if job['status'] == 'succeeded': break
            time.sleep(.02)
        assert job['status'] == 'succeeded'
        assert runner.received == images
        assert job['metadata']['reference_count'] == 2
        assert 'reference_images' not in job['metadata']
        assert images[0] not in (tmp_path / (job['id'] + '.json')).read_text()

def test_text_only_engine_rejects_references_instead_of_ignoring_them(tmp_path):
    with TestClient(create_app(DemoRunner(), TOKEN, tmp_path)) as client:
        assert 'reference' not in client.get('/health', headers=AUTH).json()['capabilities']
        response = client.post('/generate', json={'prompt':'edit', 'reference_images':[reference()]}, headers=AUTH)
        assert response.status_code == 422
        assert 'vision encoder' in response.json()['detail']

def test_invalid_references_and_authentication_are_rejected_with_cors(tmp_path):
    with TestClient(create_app(ReferenceRunner(), TOKEN, tmp_path)) as client:
        headers = {**AUTH, 'Origin': 'http://127.0.0.1:5173'}
        for images in [['https://example.com/image.png'], ['data:image/png;base64,AAAA'], [reference()] * 4]:
            assert client.post('/generate', json={'prompt':'edit','reference_images':images}, headers=headers).status_code == 422
        response = client.post('/generate', json={'prompt':'x'}, headers={'Origin':headers['Origin']})
        assert response.status_code == 401
        assert response.headers['access-control-allow-origin'] == headers['Origin']
        response = client.post('/jobs/x/cancel', content='x' * (128 * 1024 + 1), headers=headers)
        assert response.status_code == 413
        assert response.headers['access-control-allow-origin'] == headers['Origin']

def test_resident_engine_vision_arguments_and_native_reference_payload(tmp_path, monkeypatch):
    vision = tmp_path / 'vision.gguf'; vision.write_bytes(b'test')
    monkeypatch.setenv('ZERO_VISION_ENCODER', str(vision))
    runner = ResidentQwenRunner()
    assert runner.supports_references
    command = runner.command()
    assert command[command.index('--llm_vision') + 1] == str(vision)
    request = GenerateRequest(prompt='Edit image 1', reference_images=[reference()])
    payload = runner.payload(request)
    assert payload['ref_images'] == request.reference_images
    assert payload['auto_resize_ref_image'] is False
    monkeypatch.delenv('ZERO_VISION_ENCODER')
    assert not ResidentQwenRunner().supports_references

def test_notebook_bundles_current_backend_and_reference_smoke_test():
    root = Path(__file__).resolve().parents[1]
    notebook = json.loads((root / 'colab' / 'Studio_Zero_Colab.ipynb').read_text(encoding='utf-8'))
    cells = [''.join(c['source']) for c in notebook['cells'] if c['cell_type'] == 'code']
    import ast
    source_cell = next(c for c in cells if 'SOURCES = ' in c)
    assignment = next(n for n in ast.parse(source_cell).body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'SOURCES' for t in n.targets))
    bundled = ast.literal_eval(assignment.value)
    for path, source in bundled.items(): assert source == (root / path).read_text(encoding='utf-8')
    assert any('mmproj-Qwen3VL-8B-Instruct-F16.gguf' in c for c in cells)
    assert any("check('Reference edit'" in c for c in cells)


def test_notebook_is_a_readable_form():
    """Every code cell is a titled Colab form (code hidden); settings are form fields; checks are optional."""
    root = Path(__file__).resolve().parents[1]
    notebook = json.loads((root / 'colab' / 'Studio_Zero_Colab.ipynb').read_text(encoding='utf-8'))
    code = [c for c in notebook['cells'] if c['cell_type'] == 'code']
    for cell in code:
        assert cell['metadata'].get('cellView') == 'form'
        assert ''.join(cell['source']).startswith('#@title ')
    settings = ''.join(code[0]['source'])
    for name in ('ENABLE_VIDEO', 'ENABLE_MUSIC', 'ENGINE', 'MODEL_SIZE', 'CHECKS', 'REDOWNLOAD_MODELS', 'HF_TOKEN'):
        assert f'{name} = ' in settings and '#@param' in settings.split(f'{name} = ', 1)[1].splitlines()[0]
    text = '\n'.join(''.join(c['source']) for c in code)
    assert "CHECKS == 'full'" in text and '#connect=' in text and 'LAST_SETUP_AT' in text


def test_notebook_hf_token_field_wins_and_is_never_printed():
    root = Path(__file__).resolve().parents[1]
    notebook = json.loads((root / 'colab' / 'Studio_Zero_Colab.ipynb').read_text(encoding='utf-8'))
    code = [''.join(c['source']) for c in notebook['cells'] if c['cell_type'] == 'code']
    assert 'HF_TOKEN = ""  #@param {type:"string"}' in code[0]  # empty by default: nothing secret in the shared file
    models = next(c for c in code if c.startswith('#@title 3 '))
    assert "os.environ['HF_TOKEN'] = HF_TOKEN.strip()" in models and "colab_secret('HF_TOKEN')" in models
    for cell in code:
        for line in cell.splitlines():
            if 'print(' in line or 'ok(' in line:
                assert "environ['HF_TOKEN']" not in line and 'HF_TOKEN.strip' not in line
