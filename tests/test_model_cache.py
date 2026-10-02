import json
from pathlib import Path

import pytest

from backend.model_cache import ModelFile, ModelStore, RepoSnapshot

FILES = [ModelFile('ZERO_DIFFUSION', 'owner/diffusion', 'model.gguf'),
         ModelFile('ZERO_VAE', 'owner/diffusion', 'vae/vae.safetensors'),
         ModelFile('ZERO_TEXT_ENCODER', 'other/encoder', 'encoder.gguf')]
CONTENT = {'model.gguf': b'diffusion' * 100, 'vae/vae.safetensors': b'vae' * 50,
           'encoder.gguf': b'encoder' * 80, 'mmproj.gguf': b'vision' * 30}


class FakeHub:
    def __init__(self, revision='rev-1'):
        self.revision = revision
        self.resolves, self.downloads = [], []
        self.truncate = set()

    def resolve(self, repo, revision):
        self.resolves.append((repo, revision))
        return RepoSnapshot(self.revision if revision == 'main' else revision,
                            {name: len(data) for name, data in CONTENT.items()})

    def download(self, repo, filename, revision, dest):
        self.downloads.append((repo, filename, revision))
        path = Path(dest) / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        data = CONTENT[filename]
        path.write_bytes(data[:-1] if filename in self.truncate else data)
        return path


def session(tmp_path, hub, files=FILES, name='session', **options):
    store = ModelStore(tmp_path / name, tmp_path / 'drive', log=lambda message: None, **options)
    paths = store.prepare(files, hub.resolve, hub.download)
    assert store.wait(10)
    return store, paths


def test_first_session_downloads_and_saves_everything(tmp_path):
    hub = FakeHub()
    store, paths = session(tmp_path, hub)
    assert len(hub.downloads) == 3 and store.save_errors == []
    for item in FILES:
        assert Path(paths[item.env]).read_bytes() == CONTENT[item.filename]
        assert store.stored_path(item).read_bytes() == CONTENT[item.filename]
    manifest = json.loads((tmp_path / 'drive/models/manifest.json').read_text())
    assert manifest['files']['owner/diffusion:vae/vae.safetensors'] == {'revision': 'rev-1', 'size': 150}
    assert store.revisions == {'owner/diffusion': 'rev-1', 'other/encoder': 'rev-1'}


def test_second_session_downloads_nothing_and_contacts_no_hub(tmp_path):
    session(tmp_path, FakeHub(), name='first')
    hub = FakeHub(revision='rev-2')  # upstream moved on; cached files stay pinned
    store, paths = session(tmp_path, hub, name='second')
    assert hub.downloads == [] and hub.resolves == []
    assert store.revisions == {'owner/diffusion': 'rev-1', 'other/encoder': 'rev-1'}
    assert sorted(store.reused) == sorted(item.filename for item in FILES)
    for item in FILES:
        assert Path(paths[item.env]).is_relative_to(tmp_path / 'second')   # copied to fast local disk
        assert Path(paths[item.env]).read_bytes() == CONTENT[item.filename]


def test_direct_store_paths_without_local_copy(tmp_path):
    session(tmp_path, FakeHub(), name='first')
    store, paths = session(tmp_path, FakeHub(), name='second', copy_to_local=False)
    assert all(Path(path).is_relative_to(tmp_path / 'drive') for path in paths.values())


def test_new_file_in_pinned_repository_uses_the_pinned_revision(tmp_path):
    session(tmp_path, FakeHub(), name='first')
    hub = FakeHub(revision='rev-2')
    extra = FILES + [ModelFile('ZERO_VISION_ENCODER', 'other/encoder', 'mmproj.gguf')]
    store, paths = session(tmp_path, hub, files=extra, name='second')
    assert hub.resolves == [('other/encoder', 'rev-1')]
    assert hub.downloads == [('other/encoder', 'mmproj.gguf', 'rev-1')]
    assert Path(paths['ZERO_VISION_ENCODER']).read_bytes() == CONTENT['mmproj.gguf']


def test_update_checks_main_and_refreshes(tmp_path):
    session(tmp_path, FakeHub(), name='first')
    hub = FakeHub(revision='rev-2')
    store, _ = session(tmp_path, hub, name='second', update=True)
    assert {revision for _, _, revision in hub.downloads} == {'rev-2'}
    manifest = json.loads((tmp_path / 'drive/models/manifest.json').read_text())
    assert {entry['revision'] for entry in manifest['files'].values()} == {'rev-2'}
    hub = FakeHub(revision='rev-2')
    session(tmp_path, hub, name='third', update=True)
    assert hub.downloads == []   # already current


def test_truncated_store_copy_is_fetched_again(tmp_path):
    first, _ = session(tmp_path, FakeHub(), name='first')
    stored = first.stored_path(FILES[0])
    stored.write_bytes(stored.read_bytes()[:10])   # e.g. Drive sync cut short by a reset
    hub = FakeHub()
    store, paths = session(tmp_path, hub, name='second')
    assert hub.downloads == [('owner/diffusion', 'model.gguf', 'rev-1')]
    assert stored.read_bytes() == CONTENT['model.gguf']


def test_incomplete_download_fails(tmp_path):
    hub = FakeHub(); hub.truncate.add('encoder.gguf')
    with pytest.raises(RuntimeError, match='incomplete'):
        session(tmp_path, hub)


def test_missing_repository_file_fails_clearly(tmp_path):
    with pytest.raises(RuntimeError, match='not in owner/diffusion'):
        session(tmp_path, FakeHub(), files=[ModelFile('X', 'owner/diffusion', 'missing.gguf')])


def test_no_store_downloads_locally_only(tmp_path):
    hub = FakeHub()
    store = ModelStore(tmp_path / 'local', None, log=lambda message: None)
    paths = store.prepare(FILES, hub.resolve, hub.download)
    assert store.wait(1) and len(hub.downloads) == 3 and not (tmp_path / 'drive').exists()
    assert all(Path(path).is_file() for path in paths.values())


def test_full_store_keeps_session_working(tmp_path, monkeypatch):
    import backend.model_cache as model_cache
    monkeypatch.setattr(model_cache.shutil, 'disk_usage', lambda path: type('Usage', (), {'free': 10})())
    store, paths = session(tmp_path, FakeHub(), reserve_bytes=0)
    assert len(store.save_errors) == 3 and 'Not enough space' in store.save_errors[0]
    assert all(Path(path).is_file() for path in paths.values())
    assert not (tmp_path / 'drive/models/manifest.json').exists()


def test_corrupt_manifest_is_rebuilt(tmp_path):
    session(tmp_path, FakeHub(), name='first')
    (tmp_path / 'drive/models/manifest.json').write_text('{not json')
    hub = FakeHub()
    store, _ = session(tmp_path, hub, name='second')
    assert len(hub.downloads) == 3 and store.save_errors == []
    assert json.loads((tmp_path / 'drive/models/manifest.json').read_text())['version'] == 1


def test_legacy_drive_files_are_adopted_without_download(tmp_path):
    legacy_root = tmp_path / 'drive/models'
    for item in FILES:   # the earlier notebook kept files under models/<owner>/<filename>
        path = legacy_root / item.repo.split('/')[0] / item.filename
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(CONTENT[item.filename])
    hub = FakeHub()
    store = ModelStore(tmp_path / 'local', tmp_path / 'drive', log=lambda message: None)
    paths = store.prepare(FILES, hub.resolve, hub.download,
                          legacy=lambda item: legacy_root / item.repo.split('/')[0] / item.filename)
    assert hub.downloads == [] and sorted(store.reused) == sorted(item.filename for item in FILES)
    for item in FILES:
        assert store.stored_path(item).read_bytes() == CONTENT[item.filename]
        assert Path(paths[item.env]).read_bytes() == CONTENT[item.filename]
    hub = FakeHub()
    session(tmp_path, hub, name='later')
    assert hub.downloads == [] and hub.resolves == []


def test_redownload_fetches_everything_again_at_the_pinned_revision(tmp_path):
    first, _ = session(tmp_path, FakeHub(), name='first')
    first.stored_path(FILES[2]).write_bytes(b'x' * len(CONTENT['encoder.gguf']))   # right size, bad bytes
    hub = FakeHub(revision='rev-2')
    store, paths = session(tmp_path, hub, name='second', redownload=True)
    assert sorted(f for _, f, _ in hub.downloads) == sorted(item.filename for item in FILES)
    assert {revision for _, _, revision in hub.downloads} == {'rev-1'}   # pinned, not upstream main
    assert first.stored_path(FILES[2]).read_bytes() == CONTENT['encoder.gguf']
    assert Path(paths['ZERO_TEXT_ENCODER']).read_bytes() == CONTENT['encoder.gguf']
    hub = FakeHub()
    session(tmp_path, hub, name='third')
    assert hub.downloads == []


def test_redownload_with_update_takes_main(tmp_path):
    session(tmp_path, FakeHub(), name='first')
    hub = FakeHub(revision='rev-2')
    session(tmp_path, hub, name='second', redownload=True, update=True)
    assert {revision for _, _, revision in hub.downloads} == {'rev-2'} and len(hub.downloads) == 3


def test_paths_and_view_folder_link_every_file(tmp_path):
    from backend.model_cache import link_view
    hub = FakeHub()
    store, paths = session(tmp_path, hub, name='first')
    assert store.paths[('owner/diffusion', 'vae/vae.safetensors')] == paths['ZERO_VAE']
    view = link_view(store.paths, 'owner/diffusion', tmp_path / 'view')
    assert (view / 'vae' / 'vae.safetensors').read_bytes() == CONTENT['vae/vae.safetensors']
    assert (view / 'model.gguf').is_symlink() and not (view / 'encoder.gguf').exists()
    link_view(store.paths, 'owner/diffusion', tmp_path / 'view')   # idempotent


def test_files_without_a_variable_are_tracked_by_path(tmp_path):
    hub = FakeHub()
    files = [ModelFile('', 'owner/diffusion', 'model.gguf'), ModelFile('', 'owner/diffusion', 'vae/vae.safetensors')]
    store, paths = session(tmp_path, hub, files=files)
    assert paths == {} and len(store.paths) == 2
    assert Path(store.paths[('owner/diffusion', 'model.gguf')]).read_bytes() == CONTENT['model.gguf']
