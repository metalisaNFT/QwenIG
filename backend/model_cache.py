"""Persistent model store: download each weight file once, reuse it in every later session.

The store is any directory that outlives the runtime (Google Drive on Colab, a disk on a GPU host):

    <store>/models/<owner>/<repo>/<filename>
    <store>/models/manifest.json   {"version": 1, "files": {"<repo>:<filename>": {"revision", "size"}}}

A file counts as cached only when the manifest lists it and the stored copy has the recorded size,
so a copy cut short by a runtime reset is detected and fetched again. Cached repositories stay pinned
to their recorded revision: with everything cached, preparing makes no network request at all.
`update=True` checks the repository's `main` branch and replaces only files that changed.
`redownload=True` ignores the cache and fetches every file again (at the pinned revision unless
`update=True`), replacing the stored copies.

New downloads land on fast local disk first; copying them into the store happens in a background
thread so the engine can start immediately. Nothing here depends on Hugging Face directly: the
caller supplies `resolve` (repository metadata) and `download` (fetch one file) functions.
"""
from __future__ import annotations

import json
import os
import shutil
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable

MANIFEST_VERSION = 1


@dataclass(frozen=True)
class ModelFile:
    env: str        # environment variable that receives the local path
    repo: str       # "owner/name"
    filename: str   # path inside the repository, e.g. "vae/model.safetensors"


@dataclass(frozen=True)
class RepoSnapshot:
    revision: str
    sizes: dict[str, int | None] = field(default_factory=dict)  # filename -> bytes (None if unknown)


Resolver = Callable[[str, str], RepoSnapshot]        # (repo, revision or "main")
Downloader = Callable[[str, str, str, Path], Path]   # (repo, filename, revision, destination dir) -> file
Legacy = Callable[[ModelFile], Path]                 # where an older notebook layout kept the file


def _size(path: Path) -> int | None:
    try:
        return path.stat().st_size if path.is_file() else None
    except OSError:
        return None


def _copy(source: Path, target: Path) -> None:
    """Copy through a temporary name so a partial copy never sits under the final name."""
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + '.partial')
    with source.open('rb') as reader, partial.open('wb') as writer:
        shutil.copyfileobj(reader, writer, 16 * 1024 * 1024)
    os.replace(partial, target)


class ModelStore:
    def __init__(self, local: Path, store: Path | None = None, *, update: bool = False, redownload: bool = False,
                 copy_to_local: bool = True, reserve_bytes: int = 256 * 1024 * 1024,
                 log: Callable[[str], None] = print):
        self.local = Path(local)
        self.store = Path(store) if store else None
        self.update = update
        self.redownload = redownload
        self.copy_to_local = copy_to_local
        self.reserve_bytes = reserve_bytes
        self.log = log
        self.revisions: dict[str, str] = {}
        self.paths: dict[tuple[str, str], str] = {}  # (repo, filename) → where this session reads it
        self.save_errors: list[str] = []
        self.reused: list[str] = []
        self.downloaded: list[str] = []
        self._pending: list[tuple[ModelFile, Path, str, int]] = []
        self._lock = threading.Lock()
        self._saver: threading.Thread | None = None

    # ── manifest ──────────────────────────────────────────────────────────
    @property
    def manifest_path(self) -> Path | None:
        return self.store / 'models' / 'manifest.json' if self.store else None

    def stored_path(self, item: ModelFile) -> Path:
        assert self.store is not None
        return self.store / 'models' / item.repo / item.filename

    def read_manifest(self) -> dict:
        path = self.manifest_path
        if not path or not path.is_file():
            return {'version': MANIFEST_VERSION, 'files': {}}
        try:
            data = json.loads(path.read_text(encoding='utf-8'))
            if data.get('version') != MANIFEST_VERSION or not isinstance(data.get('files'), dict):
                raise ValueError('unsupported manifest')
            return data
        except (OSError, ValueError) as exc:
            self.log(f'Model cache manifest unreadable ({exc}); cached files will be verified again.')
            return {'version': MANIFEST_VERSION, 'files': {}}

    def _record(self, item: ModelFile, revision: str, size: int) -> None:
        with self._lock:
            manifest = self.read_manifest()
            manifest['files'][f'{item.repo}:{item.filename}'] = {'revision': revision, 'size': size}
            path = self.manifest_path
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_name(path.name + '.partial')
            temporary.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding='utf-8')
            os.replace(temporary, path)

    def _cached_revision(self, item: ModelFile, manifest: dict) -> str | None:
        """The recorded revision if the stored copy is complete, else None."""
        if not self.store:
            return None
        entry = manifest['files'].get(f'{item.repo}:{item.filename}')
        if not isinstance(entry, dict) or not isinstance(entry.get('revision'), str):
            return None
        return entry['revision'] if _size(self.stored_path(item)) == entry.get('size') else None

    # ── preparing ─────────────────────────────────────────────────────────
    def prepare(self, files: Iterable[ModelFile], resolve: Resolver, download: Downloader,
                legacy: Legacy | None = None) -> dict[str, str]:
        """Return {env: local path} for every file, reusing the store and downloading only what is missing."""
        files = list(files)
        manifest = self.read_manifest()
        paths: dict[str, str] = {}
        by_repo: dict[str, list[ModelFile]] = {}
        for item in files:
            by_repo.setdefault(item.repo, []).append(item)

        for repo, items in by_repo.items():
            cached = {item: self._cached_revision(item, manifest) for item in items}
            pinned = sorted({rev for rev in cached.values() if rev})
            snapshot = None
            if self.update or not pinned:
                snapshot = resolve(repo, 'main')
            elif self.redownload or any(cached[item] != pinned[0] for item in items):
                snapshot = resolve(repo, pinned[0])   # add a file to a pinned repository at the same revision
            revision = snapshot.revision if snapshot else pinned[0]
            self.revisions[repo] = revision

            for item in items:
                if cached[item] == revision and not self.redownload:
                    paths[item.env] = self.paths[(item.repo, item.filename)] = str(self._use_stored(item))
                    self.reused.append(item.filename)
                    continue
                if item.filename not in snapshot.sizes:
                    raise RuntimeError(f'{item.filename} is not in {repo} at {revision[:12]}. '
                                       'The repository layout changed; update the notebook settings.')
                expected = snapshot.sizes[item.filename]
                adopted = self._adopt_legacy(item, legacy, revision, expected) if (legacy and not self.redownload) else None
                if adopted:
                    paths[item.env] = self.paths[(item.repo, item.filename)] = str(adopted)
                    self.reused.append(item.filename)
                    continue
                self.log(f'Downloading {repo}/{item.filename}…')
                path = Path(download(repo, item.filename, revision, self.local / repo))
                actual = _size(path)
                if actual is None or (expected is not None and actual != expected):
                    raise RuntimeError(f'Download of {item.filename} is incomplete ({actual} of {expected} bytes).')
                paths[item.env] = self.paths[(item.repo, item.filename)] = str(path)
                self.downloaded.append(item.filename)
                if self.store:
                    self._pending.append((item, path, revision, actual))

        paths.pop("", None)  # files without their own variable (whole-folder snapshots) are in self.paths
        if self._pending:
            self._saver = threading.Thread(target=self._save_pending, name='model-store-save', daemon=True)
            self._saver.start()
        return paths

    def _use_stored(self, item: ModelFile) -> Path:
        stored = self.stored_path(item)
        if not self.copy_to_local:
            return stored
        local = self.local / item.repo / item.filename
        if _size(local) != _size(stored):
            self.log(f'Restoring {item.filename} from the cache…')
            _copy(stored, local)
        return local

    def _adopt_legacy(self, item: ModelFile, legacy: Legacy, revision: str, expected: int | None) -> Path | None:
        """Move a complete file from an older cache layout into the store instead of downloading it again."""
        if not self.store:
            return None
        old = legacy(item)
        size = _size(old)
        if size is None or expected is None or size != expected:
            return None
        target = self.stored_path(item)
        target.parent.mkdir(parents=True, exist_ok=True)
        os.replace(old, target)
        self._record(item, revision, size)
        self.log(f'Reused {item.filename} from the previous Drive cache layout.')
        return self._use_stored(item)

    # ── saving into the store ─────────────────────────────────────────────
    def _save_pending(self) -> None:
        for item, path, revision, size in self._pending:
            try:
                free = shutil.disk_usage(self.store).free
            except OSError:
                free = None
            if free is not None and free < size + self.reserve_bytes:
                message = (f'Not enough space in the cache for {item.filename} '
                           f'({size / 1e9:.2f} GB needed, {free / 1e9:.2f} GB free); it will download again next session.')
                self.save_errors.append(message); self.log(message)
                continue
            try:
                _copy(path, self.stored_path(item))
                if _size(self.stored_path(item)) != size:
                    raise OSError('stored copy has the wrong size')
                self._record(item, revision, size)
                self.log(f'Saved {item.filename} to the cache.')
            except OSError as exc:
                message = f'Could not save {item.filename} to the cache: {exc}'
                self.save_errors.append(message); self.log(message)

    @property
    def saving(self) -> bool:
        return bool(self._saver and self._saver.is_alive())

    def wait(self, timeout: float | None = None) -> bool:
        """Block until background saves finish. Returns False if they are still running."""
        if self._saver:
            self._saver.join(timeout)
        return not self.saving

    def summary(self) -> str:
        parts = [f'{len(self.reused)} reused from cache', f'{len(self.downloaded)} downloaded']
        if self.saving:
            parts.append('saving new files to the cache in the background')
        if self.save_errors:
            parts.append(f'{len(self.save_errors)} not cached (see messages above)')
        return ', '.join(parts)


def link_view(paths: dict, repo: str, destination: Path) -> Path:
    """One folder with a repository's layout, linking each file wherever this session reads it
    (Drive or local disk). Libraries that load a whole folder (diffusers) then see a normal snapshot."""
    destination = Path(destination)
    for (owner, filename), path in paths.items():
        if owner != repo:
            continue
        target = destination / filename
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.is_symlink() or target.exists():
            target.unlink()
        target.symlink_to(Path(path).resolve())
    return destination
