import base64
import io
import json
import shutil
import time
import wave
from pathlib import Path
from threading import Event

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.app import create_app
from backend.assistant import DemoPromptHelper, PromptHelper, clean
from backend.audio import (DemoMusicRunner, DemoSpeaker, MusicRunner, Speaker, Transcriber, split_sentences, srt,
                           write_wav)
from backend.engines import EngineSet
from backend.runner import DemoRunner
from backend.schema import MusicRequest, SpeechRequest, TranscribeRequest

TOKEN = 'test-audio-assistant-token-0123456789abcd'
AUTH = {'Authorization': 'Bearer ' + TOKEN}


def wav_data_url(seconds=3.0, rate=16000):
    buffer = io.BytesIO()
    with wave.open(buffer, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
        w.writeframes(b'\x00\x00' * int(seconds * rate))
    return 'data:audio/wav;base64,' + base64.b64encode(buffer.getvalue()).decode()


def png_data_url(color=(20, 40, 220), size=(64, 64)):
    buffer = io.BytesIO(); Image.new('RGB', size, color).save(buffer, format='PNG')
    return 'data:image/png;base64,' + base64.b64encode(buffer.getvalue()).decode()


def wait(client, path, tries=400):
    for _ in range(tries):
        item = client.get(path, headers=AUTH).json()
        if item['status'] in ('succeeded', 'failed', 'cancelled'):
            return item
        time.sleep(.05)
    raise AssertionError('did not finish: ' + path)


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(DemoRunner(), TOKEN, tmp_path)) as c:
        yield c


def test_demo_capabilities_include_audio_and_assistant(client):
    health = client.get('/health', headers=AUTH).json()
    for name in ('describe', 'enhance-prompt', 'transcribe', 'speech', 'music'):
        assert name in health['capabilities']
    assert health['helper_models']['music'] == 'studio-zero/demo-music'


def test_enhance_prompt_and_describe(client):
    task = client.post('/enhance-prompt', headers=AUTH, json={'prompt': 'a fox in snow', 'target': 'image'}).json()
    done = wait(client, '/tasks/' + task['id'])
    assert done['status'] == 'succeeded' and done['result']['prompt'].startswith('a fox in snow')
    assert 'NOT AI' in done['result']['prompt'] and 'working' not in done
    task = client.post('/describe', headers=AUTH, json={'image': png_data_url(), 'purpose': 'image'}).json()
    done = wait(client, '/tasks/' + task['id'])
    assert 'blue' in done['result']['prompt'] and done['kind'] == 'describe'


def test_transcribe_returns_segments_and_srt(client):
    task = client.post('/transcribe', headers=AUTH, json={'audio': wav_data_url(9)}).json()
    done = wait(client, '/tasks/' + task['id'])
    result = done['result']
    assert done['status'] == 'succeeded' and result['duration'] == 9.0
    assert len(result['segments']) == 3 and '00:00:04,000' in result['srt']


def test_speech_and_music_jobs_produce_wav(client, monkeypatch):
    monkeypatch.setenv('ZERO_AUDIO_FORMAT', 'wav')
    job = client.post('/speech', headers=AUTH, json={'text': 'Hello there. This is a test.'}).json()
    done = wait(client, '/jobs/' + job['id'])
    assert done['status'] == 'succeeded' and done['metadata']['kind'] == 'speech'
    assert done['metadata']['cloned_voice'] is False
    response = client.get('/outputs/' + job['id'], headers=AUTH)
    assert response.headers['content-type'] == 'audio/wav'
    with wave.open(io.BytesIO(response.content)) as w:
        assert w.getframerate() == 24000 and w.getnframes() > 0
    job = client.post('/music', headers=AUTH, json={'style': 'calm piano', 'instrumental': True, 'duration': 10}).json()
    done = wait(client, '/jobs/' + job['id'])
    assert done['status'] == 'succeeded'
    with wave.open(io.BytesIO(client.get('/outputs/' + job['id'], headers=AUTH).content)) as w:
        assert w.getnchannels() == 2 and abs(w.getnframes() / w.getframerate() - 10) < .1
    kinds = [j['metadata']['kind'] for j in client.get('/jobs', headers=AUTH).json()]
    assert 'music' in kinds and 'speech' in kinds


@pytest.mark.skipif(shutil.which('ffmpeg') is None, reason='ffmpeg not installed')
def test_audio_is_mp3_by_default(client, monkeypatch):
    monkeypatch.delenv('ZERO_AUDIO_FORMAT', raising=False)
    job = client.post('/speech', headers=AUTH, json={'text': 'Short test.'}).json()
    done = wait(client, '/jobs/' + job['id'])
    assert done['status'] == 'succeeded' and done['metadata']['format'] == 'mp3'
    response = client.get('/outputs/' + job['id'], headers=AUTH)
    assert response.headers['content-type'] == 'audio/mpeg' and response.content[:3] in (b'ID3', b'\xff\xfb', b'\xff\xf3')


def test_validation(client):
    assert client.post('/music', headers=AUTH, json={'style': 'rock'}).status_code == 422  # lyrics or instrumental
    bad = 'data:text/plain;base64,' + base64.b64encode(b'x' * 100).decode()
    assert client.post('/transcribe', headers=AUTH, json={'audio': bad}).status_code == 422
    assert client.post('/enhance-prompt', headers=AUTH, json={'prompt': '  ', 'target': 'image'}).status_code == 422
    assert client.post('/enhance-prompt', headers=AUTH, json={'prompt': 'x', 'target': 'poem'}).status_code == 422


def test_missing_helpers_are_not_offered(tmp_path):
    app = create_app(DemoRunner(), TOKEN, tmp_path, helpers=(None, None, None, None))
    with TestClient(app) as c:
        caps = c.get('/health', headers=AUTH).json()['capabilities']
        assert not {'describe', 'enhance-prompt', 'transcribe', 'speech', 'music'} & set(caps)
        response = c.post('/speech', headers=AUTH, json={'text': 'hi'})
        assert response.status_code == 501 and 'ENABLE_VOICE' in response.json()['detail']


def test_background_removal_still_works_through_generic_tasks(client):
    task = client.post('/remove-background', headers=AUTH, json={'image': png_data_url(size=(96, 64))}).json()
    assert task['width'] == 96 and task['kind'] == 'remove-background'
    done = wait(client, '/tasks/' + task['id'])
    assert done['status'] == 'succeeded'
    assert client.get(f"/tasks/{task['id']}/mask", headers=AUTH).status_code == 200


# Units ---------------------------------------------------------------------------------------
def test_split_sentences_keeps_chunks_short():
    text = 'One. ' * 100 + 'x' * 700
    parts = split_sentences(text, limit=120)
    assert all(len(p) <= 120 for p in parts) and ''.join(parts).replace(' ', '').count('One.') == 100


def test_srt_format():
    assert srt([{'start': 0, 'end': 1.5, 'text': ' hi '}]) == '1\n00:00:00,000 --> 00:00:01,500\nhi\n'


def test_clean_strips_labels_and_quotes():
    assert clean('<think>x</think>Prompt: "a red fox"') == 'a red fox'


def test_prompt_helper_uses_deepseek_when_key_given():
    calls = []

    class Response:
        status_code = 200
        def json(self):
            return {'choices': [{'message': {'content': 'A vivid fox'}}]}

    class Client:
        def post(self, url, headers, json):
            calls.append((url, headers, json)); return Response()

    helper = PromptHelper(model_dir='', api_key='sk-test', client=Client())
    result = helper.enhance('fox', 'image')
    assert result == {'prompt': 'A vivid fox', 'model': 'DeepSeek API (deepseek-flash)'}
    url, headers, body = calls[0]
    assert url.endswith('/chat/completions') and headers['Authorization'] == 'Bearer sk-test'
    assert body['thinking'] == {'type': 'disabled'} and body['messages'][1]['content'] == 'fox'
    with pytest.raises(RuntimeError):
        helper.describe(Image.new('RGB', (8, 8)), 'image')  # describing needs the local vision model


def test_music_runner_rewrites_index_to_local_folder(tmp_path):
    index = {'_class_name': 'MiniMaxMusic3ModularPipeline',
             'transformer': ['diffusers', 'X', {'pretrained_model_name_or_path': 'MiniMaxAI/MiniMax-Music3', 'subfolder': 'transformer'}]}
    source = tmp_path / 'source.json'; source.write_text(json.dumps(index))
    view = tmp_path / 'view'; view.mkdir()
    (view / 'modular_model_index.json').symlink_to(source)
    runner = MusicRunner(model_dir=str(view))
    runner.local_index()
    patched = json.loads((view / 'modular_model_index.json').read_text())
    assert patched['transformer'][2]['pretrained_model_name_or_path'] == str(view)
    assert not (view / 'modular_model_index.json').is_symlink()
    assert json.loads(source.read_text()) == index  # the Drive copy is untouched
    assert 'music model' in runner.missing()[0]


def test_music_lifecycle_with_fake_loader(tmp_path):
    view = tmp_path / 'm'
    for d in ('language_model', 'transformer', 'rvq_depth_decoder', 'vocoder', 'condition_encoder', 'tokenizer'):
        (view / d).mkdir(parents=True)
    (view / 'modular_model_index.json').write_text('{}')
    runner = MusicRunner(model_dir=str(view), loader=lambda: 'pipe')
    assert runner.missing() == []
    runner.start()
    for _ in range(100):
        if runner.state()['engine'] == 'ready':
            break
        time.sleep(.01)
    assert runner.readiness() == (True, 'Music model ready') and runner.pipe == 'pipe'
    runner.stop()
    assert runner.state()['engine'] == 'stopped' and runner.pipe is None


class FakeResident:
    def __init__(self, vram=None):
        self.status, self.vram_gib, self.stops = 'stopped', vram, 0
        self.label = 'fake'
    def start(self): self.status = 'ready'
    def stop(self): self.status = 'stopped'; self.stops += 1
    def state(self): return {'engine': self.status, 'loaded_in_seconds': 1}
    def readiness(self): return (self.status == 'ready', 'x')
    def missing(self): return []


def test_engine_set_keeps_image_loaded_when_music_fits():
    image, music = FakeResident(), FakeResident(vram=24)
    engines = EngineSet(image, None, swap=True, music=music, free_memory=lambda: 40)
    engines.acquire('image', Event(), lambda *a: None)
    engines.acquire('music', Event(), lambda *a: None)
    assert image.status == 'ready' and music.status == 'ready' and image.stops == 0
    engines.acquire('image', Event(), lambda *a: None)  # already loaded: nothing is unloaded
    assert music.status == 'ready' and image.stops == 0


def test_engine_set_swaps_when_music_does_not_fit():
    image, music = FakeResident(), FakeResident(vram=24)
    engines = EngineSet(image, None, swap=True, music=music, free_memory=lambda: 10)
    engines.acquire('image', Event(), lambda *a: None)
    engines.acquire('music', Event(), lambda *a: None)
    assert image.status == 'stopped' and music.status == 'ready'


def test_speech_request_validates_voice():
    with pytest.raises(ValueError):
        SpeechRequest(text='hi', voice='data:image/png;base64,AAAA')
    assert SpeechRequest(text='hi', voice=wav_data_url(6)).voice
    assert TranscribeRequest(audio=wav_data_url(1), language='en').language == 'en'
    with pytest.raises(ValueError):
        TranscribeRequest(audio=wav_data_url(1), language='English')


def test_float32_loudness_keeps_samples_float32():
    import numpy as np
    from backend.audio import float32_loudness

    class FakeTTS:
        def norm_loudness(self, wav, sr, target_lufs=-27):
            return wav * np.float64(1.5)  # NumPy 2 promotes this to float64

    tts = float32_loudness(FakeTTS())
    out = tts.norm_loudness(np.ones(4, dtype=np.float32), 24000)
    assert out.dtype == np.float32 and float(out[0]) == 1.5


def test_read_pcm(tmp_path):
    from backend.audio import read_pcm
    path = tmp_path / 'a.wav'
    write_wav(path, [0.0, 0.5, -0.5], 16000)
    pcm = read_pcm(path)
    assert pcm.dtype.name == 'float32' and abs(pcm[1] - 0.5) < 1e-3 and abs(pcm[2] + 0.5) < 1e-3
