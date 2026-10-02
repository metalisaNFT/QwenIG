"""The fast engine's scheduling logic, with a NumPy stand-in for the diffusers pipeline."""
import base64
import io
import time
from contextlib import nullcontext
from threading import Event
from types import SimpleNamespace

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from backend.app import create_app
from backend.diffusers_runner import DiffusersQwenRunner, LatentBlend, latent_mask, start_index
from backend.engines import EngineSet
from backend.runner import Cancelled, transparent_prompt
from backend.schema import EditRequest, GenerateRequest

TOKEN = 'test-diffusers-token-0123456789abcdef'
AUTH = {'Authorization': 'Bearer ' + TOKEN}
SIGMAS = np.array([1.0, 0.9169867, 0.7861579, 0.549491, 0.0])
SCALE = 16          # fake VAE: one latent cell per 16×16 pixels
CHANNELS = 3


class NumpyOps:
    def inference(self):
        return nullcontext()

    def generator(self, seed):
        return np.random.default_rng(seed)

    def randn_like(self, like, generator):
        return generator.standard_normal(like.shape).astype(np.float32)

    def vae_input(self, pipe, image, width, height):
        return np.asarray(image.convert('RGB').resize((width, height)), dtype=np.float32) / 255.0

    def from_numpy(self, array, like):
        return array.astype(np.float32)

    def free(self):
        pass


class FakePipe:
    """Mimics QwenImage21Pipeline: Euler-like steps, step callbacks, interrupt, packing."""

    def __init__(self):
        self.scheduler = SimpleNamespace(sigmas=SIGMAS)
        self.transformer = object()
        self._interrupt = False
        self.calls, self.trace = [], []

    def _encode_vae_image(self, pixels, generator):
        h, w = pixels.shape[0] // SCALE, pixels.shape[1] // SCALE
        cells = pixels[: h * SCALE, : w * SCALE].reshape(h, SCALE, w, SCALE, 3).mean(axis=(1, 3))
        return cells.transpose(2, 0, 1)[None, :, None]          # (1, C, 1, h, w)

    @staticmethod
    def _pack_latents(latents, batch, channels, height, width):
        return latents.reshape(batch, channels, height * width).transpose(0, 2, 1)

    def __call__(self, **kw):
        self.calls.append(kw)
        self._interrupt = False
        h, w = kw['height'] // SCALE, kw['width'] // SCALE
        latents = kw.get('latents')
        if latents is None:
            latents = kw['generator'].standard_normal((1, h * w, CHANNELS)).astype(np.float32)
        for i in range(kw['num_inference_steps']):
            if self._interrupt:
                continue
            latents = latents + 0.25            # a stand-in "denoising" step
            out = kw['callback_on_step_end'](self, i, None, {'latents': latents})
            latents = out.get('latents', latents)
            self.trace.append(latents.copy())
        self.final = latents
        mode = 'RGBA' if 'RGBA' in kw['prompt'] else 'RGB'
        return SimpleNamespace(images=[Image.new(mode, (kw['width'], kw['height']), (90, 120, 140, 0 if mode == 'RGBA' else 255))])


class FakePDD:
    def __init__(self):
        self.armed = []

    def pdd_step_callback(self, transformer, sigmas, block):
        self.armed.append('start')
        def callback(pipe, i, t, values):
            self.armed.append(i)
            return {}
        return callback


def make_runner(tmp_path, monkeypatch, fast=True, loader=None):
    companion = tmp_path / 'companion'; companion.mkdir(exist_ok=True)
    (companion / 'model_index.json').write_text('{}')
    monkeypatch.setenv('ZERO_DIFFUSERS_COMPANION', str(companion))
    monkeypatch.delenv('ZERO_DIFFUSION', raising=False)
    if fast:
        code = tmp_path / 'pdd'; (code / 'models').mkdir(parents=True, exist_ok=True)
        for name in ('qwenimage21_pdd.py', 'lora_utils_pdd.py'):
            (code / name).write_text('# stub')
        (code / 'models' / 'pdd_config.json').write_text('{}')
        (code / 'models' / 'acc.safetensors').write_text('x')
        monkeypatch.setenv('ZERO_FAST_LORA', str(code / 'models' / 'acc.safetensors'))
    else:
        monkeypatch.delenv('ZERO_FAST_LORA', raising=False)
    pdd = FakePDD()
    pipe = FakePipe()
    runner = DiffusersQwenRunner(
        loader=loader or (lambda: (pipe, {'module': pdd, 'config': {'pdd_block_size': 1}, 'sigmas': SIGMAS} if fast else None)),
        ops=NumpyOps())
    return runner, pipe, pdd


def ready(runner):
    runner.start()
    for _ in range(100):
        if runner.readiness()[0]:
            return
        time.sleep(.01)
    raise AssertionError(runner.readiness())


def data_url(image):
    buffer = io.BytesIO(); image.save(buffer, 'PNG')
    return 'data:image/png;base64,' + base64.b64encode(buffer.getvalue()).decode()


def test_latent_mask_marks_any_touched_cell():
    mask = Image.new('L', (64, 32), 0)
    ImageDraw.Draw(mask).point((17, 3), fill=255)        # one pixel in cell (1, 0)
    cells = latent_mask(mask, 4, 2).reshape(2, 4)
    assert cells.tolist() == [[0, 1, 0, 0], [0, 0, 0, 0]]


def test_start_index_follows_strength():
    assert start_index(SIGMAS, 1.0) == 0
    assert start_index(SIGMAS, 0.6) == 3          # first boundary ≤ 0.6 is 0.549
    assert start_index(SIGMAS, 0.95) == 1
    assert start_index(SIGMAS, 0.05) == 3          # always leaves one real step


def test_fast_generation_uses_four_steps_without_cfg(tmp_path, monkeypatch):
    runner, pipe, pdd = make_runner(tmp_path, monkeypatch)
    ready(runner)
    assert 'Fast' in runner.readiness()[1]
    seen = []
    request = GenerateRequest(prompt='a fox', width=512, height=256, steps=28, guidance=6, seed=4, negative_prompt='blur', transparent=True)
    runner.generate(request, tmp_path / 'out.png', Event(), lambda v, m: seen.append((v, m)))
    kw = pipe.calls[-1]
    assert kw['num_inference_steps'] == 4 and kw['true_cfg_scale'] == 1.0 and kw['use_kv_cache'] is False
    assert 'negative_prompt' not in kw and kw['prompt'] == transparent_prompt('a fox')
    assert pdd.armed == ['start', 0, 1, 2, 3]
    assert seen[-1] == (100, 'Step 4 of 4…')
    assert Image.open(tmp_path / 'out.png').size == (512, 256)


def test_quality_mode_keeps_steps_and_cfg_with_negative_prompt(tmp_path, monkeypatch):
    runner, pipe, _ = make_runner(tmp_path, monkeypatch, fast=False)
    ready(runner)
    runner.generate(GenerateRequest(prompt='x', width=256, height=256, steps=12, guidance=4, negative_prompt='blur'), tmp_path / 'o.png', Event(), lambda *a: None)
    kw = pipe.calls[-1]
    assert kw['num_inference_steps'] == 12 and kw['true_cfg_scale'] == 4.0 and kw['negative_prompt'] == 'blur'


def test_inpaint_keeps_unmasked_latents_exactly(tmp_path, monkeypatch):
    runner, pipe, _ = make_runner(tmp_path, monkeypatch)
    ready(runner)
    source = Image.new('RGB', (512, 256), (200, 40, 40))
    ImageDraw.Draw(source).rectangle((0, 0, 255, 255), fill=(20, 200, 90))
    mask = Image.new('L', (512, 256), 0); ImageDraw.Draw(mask).rectangle((256, 0, 511, 255), fill=255)
    request = EditRequest(operation='inpaint', prompt='a lamp', width=512, height=256, image=data_url(source), mask=data_url(mask), seed=1)
    runner.edit(request, tmp_path / 'e.png', Event(), lambda *a: None)
    x0 = FakePipe._pack_latents(pipe._encode_vae_image(np.asarray(source, np.float32) / 255, None), 1, 3, 16, 32)
    m = latent_mask(mask, 32, 16)[0, :, 0].astype(bool)
    assert np.allclose(pipe.final[0, ~m], x0[0, ~m])           # σ = 0 at the end: exactly the source
    assert not np.allclose(pipe.final[0, m], x0[0, m])         # generated where marked
    assert len(pipe.calls[-1]['image']) == 1                    # the source also conditions the edit


def test_image_to_image_starts_at_the_strength_boundary(tmp_path, monkeypatch):
    runner, pipe, _ = make_runner(tmp_path, monkeypatch)
    ready(runner)
    source = Image.new('RGB', (256, 256), (120, 130, 140))
    request = EditRequest(operation='image-to-image', prompt='autumn', width=256, height=256, image=data_url(source), strength=.6, seed=9)
    runner.edit(request, tmp_path / 'i.png', Event(), lambda *a: None)
    blend_state = pipe.trace[2]                                # end of step index 2 == boundary 3 (σ = .549)
    x0 = FakePipe._pack_latents(pipe._encode_vae_image(np.asarray(source, np.float32) / 255, None), 1, 3, 16, 16)
    noise = np.random.default_rng(10).standard_normal(x0.shape).astype(np.float32)
    assert np.allclose(blend_state, x0 * (1 - SIGMAS[3]) + noise * SIGMAS[3], atol=1e-5)
    assert np.allclose(pipe.final, blend_state + 0.25)         # one real step from there, untouched
    assert 'image' not in pipe.calls[-1]


def test_instruction_edit_conditions_on_source_and_references(tmp_path, monkeypatch):
    runner, pipe, _ = make_runner(tmp_path, monkeypatch)
    ready(runner)
    request = EditRequest(operation='edit', prompt='make it red', width=256, height=256, image=data_url(Image.new('RGB', (256, 256))),
                          reference_images=[data_url(Image.new('RGB', (32, 32), 'blue'))])
    runner.edit(request, tmp_path / 'x.png', Event(), lambda *a: None)
    kw = pipe.calls[-1]
    assert len(kw['image']) == 2 and kw['output_resolution'] == 1024 and 'latents' not in kw


def test_cancel_interrupts_and_raises(tmp_path, monkeypatch):
    runner, pipe, _ = make_runner(tmp_path, monkeypatch)
    ready(runner)
    cancelled = Event(); cancelled.set()
    with pytest.raises(Cancelled):
        runner.generate(GenerateRequest(prompt='x', width=256, height=256), tmp_path / 'c.png', cancelled, lambda *a: None)
    assert len(pipe.trace) == 1                                 # stopped after the first step


def test_lifecycle_failure_missing_and_swap(tmp_path, monkeypatch):
    def broken():
        raise RuntimeError('out of memory')
    runner, _, _ = make_runner(tmp_path, monkeypatch, loader=broken)
    runner.start()
    for _ in range(100):
        if runner.state()['engine'] == 'failed':
            break
        time.sleep(.01)
    ready_flag, message = runner.readiness()
    assert not ready_flag and 'out of memory' in message
    monkeypatch.setenv('ZERO_DIFFUSERS_COMPANION', str(tmp_path / 'nowhere'))
    assert 'companion model folder (text encoder, VAE)' in DiffusersQwenRunner().missing()
    good, _, _ = make_runner(tmp_path, monkeypatch)
    engines = EngineSet(good, None)
    engines.start(); ready(good)
    good.stop()
    assert good.state()['engine'] == 'stopped' and good.pipe is None


def test_api_edit_round_trip_with_fast_engine(tmp_path, monkeypatch):
    runner, pipe, _ = make_runner(tmp_path, monkeypatch)
    with TestClient(create_app(runner, TOKEN, tmp_path / 'out', matter=None, video_runner=None)) as c:
        for _ in range(100):
            health = c.get('/health', headers=AUTH).json()
            if health['ready']:
                break
            time.sleep(.02)
        assert health['ready'] and {'edit', 'inpaint', 'transparent', 'reference'} <= set(health['capabilities'])
        mask = Image.new('L', (256, 256), 0); ImageDraw.Draw(mask).rectangle((0, 0, 127, 255), fill=255)
        job = c.post('/edit', json={'operation': 'outpaint', 'prompt': 'sea', 'width': 256, 'height': 256,
                                    'image': data_url(Image.new('RGB', (256, 256), 'grey')), 'mask': data_url(mask)}, headers=AUTH).json()
        for _ in range(200):
            job = c.get('/jobs/' + job['id'], headers=AUTH).json()
            if job['status'] in ('succeeded', 'failed'):
                break
            time.sleep(.02)
        assert job['status'] == 'succeeded', job
        assert Image.open(io.BytesIO(c.get('/outputs/' + job['id'], headers=AUTH).content)).size == (256, 256)
