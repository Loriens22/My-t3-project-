"""Verified cold storage for reproducible, idle scratch-workspace dependencies.

Project sources never move.  The caller owns native thread/process eligibility
and supplies a context-manager factory which rechecks it at the atomic commit.
The cache may be written by npm after a workspace resumes; it is refreshed the
next time that workspace is idle.  A changed package lock is never silently
paired with an older dependency archive on restoration.
"""
from contextlib import contextmanager
import ctypes
import errno
import fcntl
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import tarfile
import tempfile

from archive_store import ArchiveStoreError, sha256_file

CACHE_ROOT = Path("/tmp/t3-settled-deps")
MIN_BYTES = 1024 * 1024
MAX_BYTES = 512 * 1024 * 1024
MAX_ENTRIES = 100000
CHUNK = 1024 * 1024
LOCK_FILES = ("package.json", "package-lock.json", "npm-shrinkwrap.json",
              "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb")


class DependencyCacheError(RuntimeError):
    pass


class _BoundedTarInfo(tarfile.TarInfo):
    # tarfile otherwise reads a whole PAX/GNU extension before yielding a
    # member. Bound that metadata too, not only the extracted regular files.
    def _proc_pax(self, archive):
        if self.size > 65536:
            raise DependencyCacheError("Dependency archive metadata is oversized")
        return super()._proc_pax(archive)

    def _proc_gnulong(self, archive):
        if self.size > 4096:
            raise DependencyCacheError("Dependency archive path is oversized")
        return super()._proc_gnulong(archive)


def _fsync_dir(directory):
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _real_directory(path, create=False):
    if ".." in Path(path).parts:
        raise DependencyCacheError("Parent traversal is unsupported")
    path = Path(path).absolute()
    fd = os.open(path.anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.parts[1:]:
            if create:
                try:
                    os.mkdir(part, mode=0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
    except OSError:
        raise DependencyCacheError("Dependency directory path is unsafe") from None
    finally:
        os.close(fd)
    return path.resolve(strict=True)


def _workspace(root, workspace):
    root = _real_directory(root)
    if ".." in Path(workspace).parts:
        raise DependencyCacheError("Parent traversal is unsupported")
    workspace = Path(workspace).absolute()
    scratch = root / "t3/scratch"
    if workspace == scratch or not workspace.is_relative_to(scratch):
        raise DependencyCacheError("Only isolated scratch workspaces can be offloaded")
    workspace = _real_directory(workspace)
    if workspace == scratch or not workspace.is_relative_to(scratch):
        raise DependencyCacheError("Only isolated scratch workspaces can be offloaded")
    return root, workspace


def _identity(path):
    info = path.lstat()
    return (info.st_dev, info.st_ino, info.st_mode, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns)


def _stage_identity(path):
    info = path.lstat()
    return [info.st_dev, info.st_ino, stat.S_IFMT(info.st_mode)]


def _entries(tree):
    yield tree, "."
    def visit(directory):
        for item in sorted(os.scandir(directory), key=lambda entry: entry.name):
            path = Path(item.path)
            yield path, path.relative_to(tree).as_posix()
            if item.is_dir(follow_symlinks=False):
                yield from visit(path)
    yield from visit(tree)


def _file_hash(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode):
            raise DependencyCacheError("Dependency entry is not a regular file")
        digest = hashlib.sha256()
        count = 0
        with os.fdopen(fd, "rb", closefd=False) as source:
            for chunk in iter(lambda: source.read(CHUNK), b""):
                count += len(chunk)
                if count > MAX_BYTES:
                    raise DependencyCacheError("Dependency file exceeds the archive limit")
                digest.update(chunk)
        after = os.fstat(fd)
        fields = ("st_dev", "st_ino", "st_mode", "st_size", "st_mtime_ns", "st_ctime_ns")
        if any(getattr(before, name) != getattr(after, name) for name in fields):
            raise DependencyCacheError("Dependencies changed during inspection")
        if _identity(path) != tuple(getattr(after, name) for name in fields):
            raise DependencyCacheError("Dependencies changed during inspection")
        return digest.hexdigest()
    finally:
        os.close(fd)


def fingerprint(tree):
    """Content/mode/link digest; inode and mtime deliberately are not semantics."""
    tree = _real_directory(tree)
    digest = hashlib.sha256()
    size = count = 0
    for path, relative in _entries(tree):
        count += 1
        if count > MAX_ENTRIES:
            raise DependencyCacheError("Too many dependency entries")
        info = path.lstat()
        mode = stat.S_IMODE(info.st_mode)
        if mode & 0o7000:
            raise DependencyCacheError("Special dependency permissions are unsupported")
        if stat.S_ISLNK(info.st_mode):
            target = os.readlink(path)
            if (os.path.isabs(target) or not path.resolve(strict=False).is_relative_to(tree)):
                raise DependencyCacheError("Dependency symlink escapes its tree")
            row = [relative, "link", target]
        elif stat.S_ISDIR(info.st_mode):
            row = [relative, "dir", mode]
        elif stat.S_ISREG(info.st_mode):
            size += info.st_size
            if size > MAX_BYTES:
                raise DependencyCacheError("Dependencies exceed the archive limit")
            row = [relative, "file", mode, info.st_size, _file_hash(path)]
        else:
            raise DependencyCacheError("Special dependency entries are unsupported")
        digest.update(json.dumps(row, ensure_ascii=True, separators=(",", ":")).encode())
        digest.update(b"\n")
    return {"treeDigest": digest.hexdigest(), "fileBytes": size, "entries": count}


def lock_fingerprint(workspace):
    result = {}
    for name in LOCK_FILES:
        path = workspace / name
        try:
            info = path.lstat()
        except FileNotFoundError:
            result[name] = None
            continue
        if not stat.S_ISREG(info.st_mode) or info.st_size > 32 * CHUNK:
            raise DependencyCacheError("Package metadata is unsafe or oversized")
        result[name] = _file_hash(path)
    return result


def _pack(tree, destination):
    # Build every regular file independently: no tar hard links or link targets
    # can escape the archive, even when npm hard-linked two source files.
    with destination.open("xb") as raw:
        with gzip.GzipFile(filename="", mode="wb", compresslevel=1, mtime=0, fileobj=raw) as zipped:
            with tarfile.open(fileobj=zipped, mode="w|", format=tarfile.PAX_FORMAT) as archive:
                total = count = 0
                for path, relative in _entries(tree):
                    count += 1
                    if count > MAX_ENTRIES:
                        raise DependencyCacheError("Too many dependency entries")
                    info = archive.gettarinfo(str(path), arcname="node_modules" + ("/" + relative if relative != "." else ""))
                    info.uid = info.gid = 0
                    info.uname = info.gname = ""
                    if path.is_symlink():
                        info.type = tarfile.SYMTYPE
                        info.linkname = os.readlink(path)
                        archive.addfile(info)
                    elif path.is_dir():
                        info.type = tarfile.DIRTYPE
                        archive.addfile(info)
                    else:
                        info.type, info.linkname = tarfile.REGTYPE, ""
                        info.size = path.stat(follow_symlinks=False).st_size
                        total += info.size
                        if total > MAX_BYTES:
                            raise DependencyCacheError("Dependencies exceed the archive limit")
                        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                        with os.fdopen(fd, "rb") as source:
                            if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
                                raise DependencyCacheError("Dependency changed during archival")
                            archive.addfile(info, source)
        raw.flush()
        os.fsync(raw.fileno())
    if destination.stat().st_size > MAX_BYTES:
        raise DependencyCacheError("Compressed dependencies exceed the archive limit")


def _member_parts(name):
    path = PurePosixPath(name)
    if ("\\" in name or path.is_absolute() or not path.parts
            or any(part in ("", ".", "..") for part in name.split("/"))
            or path.parts[0] != "node_modules"):
        raise DependencyCacheError("Unsafe dependency archive path")
    return path.parts


def _unpack(source, destination):
    """Extract a bounded stream without tarfile.extract or following links."""
    destination = _real_directory(destination, create=True)
    seen = set()
    directories = []
    total = 0
    with tarfile.open(source, "r|gz", tarinfo=_BoundedTarInfo) as archive:
        for member in archive:
            parts = _member_parts(member.name)
            if parts in seen or len(seen) >= MAX_ENTRIES:
                raise DependencyCacheError("Duplicate or excessive archive entries")
            seen.add(parts)
            path = destination.joinpath(*parts)
            _real_directory(path.parent)
            if member.mode & 0o7000:
                raise DependencyCacheError("Special archive permissions are unsupported")
            if member.isdir():
                path.mkdir(mode=0o700)
                directories.append((path, member.mode, member.mtime))
            elif member.isreg() and member.sparse is None:
                total += member.size
                if member.size < 0 or total > MAX_BYTES:
                    raise DependencyCacheError("Dependency archive exceeds the size limit")
                stream = archive.extractfile(member)
                if stream is None:
                    raise DependencyCacheError("Dependency archive is incomplete")
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                             member.mode & 0o777)
                with os.fdopen(fd, "wb") as target:
                    remaining = member.size
                    while remaining:
                        chunk = stream.read(min(CHUNK, remaining))
                        if not chunk:
                            raise DependencyCacheError("Dependency archive is incomplete")
                        target.write(chunk)
                        remaining -= len(chunk)
                    target.flush()
                    os.fsync(target.fileno())
                os.chmod(path, member.mode & 0o777, follow_symlinks=False)
                os.utime(path, (member.mtime, member.mtime), follow_symlinks=False)
            elif member.issym():
                target = member.linkname
                relative = PurePosixPath(*parts[1:-1], target)
                depth = 0
                if os.path.isabs(target) or "\\" in target:
                    raise DependencyCacheError("Unsafe dependency archive symlink")
                for part in relative.parts:
                    if part == "..":
                        depth -= 1
                    elif part not in ("", "."):
                        depth += 1
                    if depth < 0:
                        raise DependencyCacheError("Dependency archive symlink escapes its tree")
                os.symlink(target, path)
            else:
                raise DependencyCacheError("Hard links and special archive entries are unsupported")
    tree = destination / "node_modules"
    _real_directory(tree)
    for path, mode, mtime in reversed(directories):
        os.chmod(path, mode & 0o777, follow_symlinks=False)
        os.utime(path, (mtime, mtime), follow_symlinks=False)
        _fsync_dir(path)
    # A link chain can escape despite individually lexical internal targets.
    fingerprint(tree)
    return tree


def _paths(root, workspace):
    relative = workspace.relative_to(root).as_posix()
    identifier = hashlib.sha256(relative.encode()).hexdigest()
    manifests = _real_directory(root / "t3/archive/dependencies", create=True)
    return identifier, manifests / (identifier + ".json"), workspace / (".t3-deps-original-" + identifier[:20])


@contextmanager
def _locked(root):
    directory = _real_directory(root / "t3/archive/dependencies", create=True)
    fd = os.open(directory / ".lock", os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


def _write_manifest(file, record):
    _real_directory(file.parent)
    fd, name = tempfile.mkstemp(prefix=".manifest-", dir=file.parent)
    try:
        with os.fdopen(fd, "w") as target:
            json.dump(record, target, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
            target.flush()
            os.fsync(target.fileno())
        if file.is_symlink():
            raise DependencyCacheError("Dependency manifest path is unsafe")
        os.replace(name, file)
        _fsync_dir(file.parent)
    finally:
        Path(name).unlink(missing_ok=True)


def _validate_record(record, previous=False):
    required = {"version", "workspace", "treeDigest", "fileBytes", "entries", "archiveKey",
                "archiveSha256", "archiveBytes", "locks", "state"}
    if (not isinstance(record, dict) or not required <= record.keys() or record["version"] != 1
            or record["state"] not in ("prepared", "offloaded", "retained")
            or not isinstance(record["workspace"], str)
            or any(p in ("", ".", "..") for p in record["workspace"].split("/"))
            or not record["workspace"].startswith("t3/scratch/")
            or not isinstance(record["locks"], dict) or set(record["locks"]) != set(LOCK_FILES)):
        raise DependencyCacheError("Dependency manifest is invalid")
    if type(record.get("cacheLayout", 1)) is not int or record.get("cacheLayout", 1) not in (1, 2):
        raise DependencyCacheError("Dependency cache layout is invalid")
    for field in ("treeDigest", "archiveSha256"):
        value = record[field]
        if not isinstance(value, str) or len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
            raise DependencyCacheError("Dependency manifest checksum is invalid")
    for field in ("fileBytes", "entries", "archiveBytes"):
        if not isinstance(record[field], int) or record[field] < 0 or record[field] > MAX_BYTES:
            raise DependencyCacheError("Dependency manifest size is invalid")
    if record["archiveKey"] != "dependencies/" + record["archiveSha256"] + ".tar.gz":
        raise DependencyCacheError("Dependency archive key is invalid")
    for value in record["locks"].values():
        if value is not None and (not isinstance(value, str) or len(value) != 64
                                  or any(c not in "0123456789abcdef" for c in value)):
            raise DependencyCacheError("Package metadata checksum is invalid")
    if "stageIdentity" in record:
        identity = record["stageIdentity"]
        if (not isinstance(identity, list) or len(identity) != 3
                or any(not isinstance(v, int) or v < 0 for v in identity)
                or identity[2] not in (stat.S_IFDIR, stat.S_IFLNK)):
            raise DependencyCacheError("Dependency original identity is invalid")
    if "previous" in record:
        if previous or not isinstance(record["previous"], dict):
            raise DependencyCacheError("Nested dependency recovery is invalid")
        _validate_record(record["previous"], previous=True)
        if record["previous"]["workspace"] != record["workspace"]:
            raise DependencyCacheError("Dependency recovery workspace is invalid")
    return record


def _load_manifest(file):
    if file.is_symlink() or file.stat().st_size > 65536:
        raise DependencyCacheError("Dependency manifest is unsafe")
    record = json.loads(file.read_text())
    _validate_record(record)
    return record


def _cache(identifier, digest, layout=2):
    if any(len(value) != 64 or any(c not in "0123456789abcdef" for c in value)
           for value in (identifier, digest)):
        raise DependencyCacheError("Dependency cache identifier is invalid")
    if type(layout) is not int or layout not in (1, 2):
        raise DependencyCacheError("Dependency cache layout is invalid")
    base = _real_directory(CACHE_ROOT, create=True)
    directory = _real_directory(base / identifier, create=True)
    if layout == 1:
        return directory / digest
    # Node resolves imported files through realpath before searching ancestors
    # for bare sibling packages. The actual dependency root must therefore be
    # named node_modules. Keep its wrapper disjoint from the deployed legacy
    # digest directory: placing it inside that tree would mutate the migration
    # source and break rollback/content verification.
    wrapper = _real_directory(directory / "v2" / digest, create=True)
    return wrapper / "node_modules"


def _record_cache(identifier, record):
    # Missing layout is the already-deployed layout, independently for both a
    # current prepared record and its previous rollback record.
    return _cache(identifier, record["treeDigest"], record.get("cacheLayout", 1))


def _expected_link(path, target):
    return path.is_symlink() and os.readlink(path) == str(target)


def _ensure_cache(record, identifier, archive_file):
    cache = _record_cache(identifier, record)
    if cache.exists() or cache.is_symlink():
        if fingerprint(cache)["treeDigest"] != record["treeDigest"]:
            raise DependencyCacheError("Existing dependency cache has newer contents")
        return cache
    with tempfile.TemporaryDirectory(prefix=".restore-", dir=cache.parent) as temporary:
        unpacked = _unpack(archive_file, Path(temporary))
        if fingerprint(unpacked)["treeDigest"] != record["treeDigest"]:
            raise DependencyCacheError("Dependency archive tree verification failed")
        _rename_noreplace(unpacked, cache)
        _fsync_dir(cache.parent)
    return cache


def _renameat2(first, second, flags):
    libc = ctypes.CDLL(None, use_errno=True)
    renameat2 = getattr(libc, "renameat2", None)
    if renameat2 is None:
        raise DependencyCacheError("Atomic dependency exchange is unsupported")
    renameat2.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
    renameat2.restype = ctypes.c_int
    if renameat2(-100, os.fsencode(first), -100, os.fsencode(second), flags) != 0:
        code = ctypes.get_errno()
        if code in (errno.ENOSYS, errno.EINVAL, errno.EOPNOTSUPP, errno.EXDEV):
            raise DependencyCacheError("Atomic dependency exchange is unsupported")
        raise DependencyCacheError("Atomic dependency exchange failed")


def _exchange(first, second):
    _renameat2(first, second, 2)


def _rename_noreplace(first, second):
    _renameat2(first, second, 1)


def _discard_original(stage, record):
    if not stage.exists() and not stage.is_symlink():
        record["cleanupDone"] = True
        return True
    # A deterministic filename never authorizes deleting a later unrelated
    # directory. The exact original inode is recorded before the exchange.
    if (record.get("cleanupDone") or not record.get("stageIdentity")
            or _stage_identity(stage) != record["stageIdentity"]):
        return False
    if stage.is_symlink():
        if os.readlink(stage) == record.get("stageLinkTarget"):
            stage.unlink()
            _fsync_dir(stage.parent)
            record["cleanupDone"] = True
            return True
        return False
    if not stage.is_dir() or not shutil.rmtree.avoids_symlink_attacks:
        return False
    if not record.get("cleanupStarted") and fingerprint(stage)["treeDigest"] != record["treeDigest"]:
        return False
    shutil.rmtree(stage)
    _fsync_dir(stage.parent)
    record["cleanupDone"] = True
    return True


def offload(root, workspace, store, commit_guard):
    """Release persistent dependencies only after S3 readback and guarded swap.

    Errors leave persistent originals or the committed, verified cache intact.
    The caller should log error types/reasons, never raw provider exceptions.
    """
    os.umask(0o077)
    if store is None:
        return {"offloaded": False, "reason": "archive_unconfigured"}
    if not callable(commit_guard):
        raise DependencyCacheError("An eligibility commit guard is required")
    root, workspace = _workspace(root, workspace)
    with _locked(root):
        identifier, manifest_file, stage = _paths(root, workspace)
        live = workspace / "node_modules"
        previous = _load_manifest(manifest_file) if manifest_file.exists() else None
        if stage.exists() or stage.is_symlink():
            return {"offloaded": False, "reason": "recovery_pending"}
        refresh = False
        if live.is_symlink():
            if previous is None:
                return {"offloaded": False, "reason": "unowned_symlink"}
            previous_cache = _record_cache(identifier, previous)
            if not _expected_link(live, previous_cache) or not previous_cache.is_dir():
                return {"offloaded": False, "reason": "restore_pending"}
            source, refresh = previous_cache, True
        elif live.is_dir():
            source = live
        else:
            return {"offloaded": False, "reason": "no_dependencies"}
        baseline = fingerprint(source)
        locks = lock_fingerprint(workspace)
        if (refresh and previous.get("cacheLayout", 1) == 2
                and baseline["treeDigest"] == previous["treeDigest"] and locks == previous["locks"]):
            return {"offloaded": False, "reason": "already_offloaded"}
        if baseline["fileBytes"] < MIN_BYTES:
            return {"offloaded": False, "reason": "small_dependencies"}
        source_identity, live_identity = _identity(source), _identity(live)
        cache_base = _real_directory(CACHE_ROOT, create=True)
        if cache_base.is_relative_to(root):
            raise DependencyCacheError("Dependency cache must be outside persistent data")
        with tempfile.TemporaryDirectory(prefix=".archive-", dir=cache_base) as temporary:
            archive_file = Path(temporary) / "dependencies.tar.gz"
            _pack(source, archive_file)
            if fingerprint(source) != baseline or lock_fingerprint(workspace) != locks:
                raise DependencyCacheError("Dependencies changed before upload")
            archive_digest = sha256_file(archive_file)
            key = "dependencies/" + archive_digest + ".tar.gz"
            verified = store.put_verified(key, archive_file)
            if verified.get("sha256") != archive_digest or verified.get("key") != key:
                raise DependencyCacheError("Dependency archive verification failed")
            record = {"version": 1, "cacheLayout": 2, "workspace": workspace.relative_to(root).as_posix(),
                      **baseline, "archiveKey": key, "archiveSha256": archive_digest,
                      "archiveBytes": archive_file.stat().st_size, "locks": locks,
                      "state": "prepared", "cleanupStarted": False, "cleanupDone": False,
                      "stageIdentity": _stage_identity(live),
                      "stageLinkTarget": str(source) if refresh else None}
            if previous is not None and refresh:
                record["previous"] = {k: v for k, v in previous.items() if k != "previous"}
            cache = _ensure_cache(record, identifier, archive_file)
            exchanged = False
            try:
                with commit_guard():
                    if (_identity(source) != source_identity or _identity(live) != live_identity
                            or fingerprint(source) != baseline or lock_fingerprint(workspace) != locks
                            or fingerprint(cache)["treeDigest"] != baseline["treeDigest"]):
                        raise DependencyCacheError("Dependencies changed before commit")
                    os.symlink(str(cache), stage)
                    _fsync_dir(workspace)
                    _write_manifest(manifest_file, record)
                    _exchange(live, stage)
                    exchanged = True
                    _fsync_dir(workspace)
                    if (not _expected_link(live, cache)
                            or (not refresh and fingerprint(stage) != baseline)):
                        raise DependencyCacheError("Dependencies changed during commit")
                    record.update({"state": "offloaded", "cleanupStarted": True})
                    _write_manifest(manifest_file, record)
            except BaseException:
                # The original is retained until the guarded exchange and its
                # durable manifest have both completed. SIGKILL recovery is in
                # restore_all; ordinary failures roll back immediately.
                if exchanged and (stage.exists() or stage.is_symlink()) and _expected_link(live, cache):
                    _exchange(live, stage)
                    _fsync_dir(workspace)
                if _expected_link(stage, cache):
                    stage.unlink()
                    _fsync_dir(workspace)
                if previous is not None:
                    _write_manifest(manifest_file, previous)
                elif manifest_file.exists():
                    manifest_file.unlink()
                    _fsync_dir(manifest_file.parent)
                raise
            cleaned = _discard_original(stage, record)
            record.pop("previous", None)
            _write_manifest(manifest_file, record)
            return {"offloaded": True, "refreshed": refresh, "fileBytes": baseline["fileBytes"],
                    "migrated": refresh and previous.get("cacheLayout", 1) != 2,
                    "bytesReclaimed": 0 if refresh or not cleaned else baseline["fileBytes"],
                    "cleanupPending": not cleaned}


def _restore_one(root, manifest_file, store, *, cold=False):
    record = _load_manifest(manifest_file)
    root, workspace = _workspace(root, root / record["workspace"])
    identifier, expected_manifest, stage = _paths(root, workspace)
    if expected_manifest != manifest_file:
        raise DependencyCacheError("Dependency manifest identifier is invalid")
    live = workspace / "node_modules"
    cache = _record_cache(identifier, record)
    if not live.is_symlink():
        # Original or a newer npm install wins over an old archive. The only
        # cleanup allowed here is our pre-exchange symlink, never real data.
        if live.is_dir():
            if cold and _expected_link(stage, cache):
                stage.unlink()
                _fsync_dir(workspace)
            if cold:
                record["state"] = "retained"
                _write_manifest(manifest_file, record)
            return "retained"
        return "missing_path"
    if not _expected_link(live, cache):
        previous = record.get("previous")
        if record["state"] == "prepared" and previous:
            old_cache = _record_cache(identifier, previous)
            if _expected_link(live, old_cache) and _expected_link(stage, cache):
                if not cold:
                    return "recovery_pending"
                stage.unlink()
                _write_manifest(manifest_file, previous)
                return _restore_one(root, manifest_file, store, cold=cold)
        return "unowned_symlink"
    if not cold and cache.exists():
        # A resumed workspace may legitimately mutate this reproducible cache.
        # Periodic restore only checks presence; settled offload owns expensive
        # content validation and publishing a newer archive.
        _real_directory(cache)
        return "ready"
    current_locks = lock_fingerprint(workspace)
    if current_locks != record["locks"]:
        return "needs_reinstall"
    restored = False
    if cache.exists() or cache.is_symlink():
        if fingerprint(cache)["treeDigest"] != record["treeDigest"]:
            return "cache_changed"
    else:
        if store is None:
            return "archive_unconfigured"
        with tempfile.TemporaryDirectory(prefix=".download-", dir=_real_directory(CACHE_ROOT, create=True)) as temporary:
            packed = store.get_verified(record["archiveKey"], Path(temporary) / "dependencies.tar.gz",
                                        record["archiveSha256"])
            if not _expected_link(live, cache):
                return "live_path_changed"
            if lock_fingerprint(workspace) != record["locks"]:
                return "needs_reinstall"
            cache = _ensure_cache(record, identifier, packed)
            restored = True
    if not cold:
        return "restored" if restored else "ready"
    if stage.exists() and not stage.is_symlink() and not record.get("cleanupStarted"):
        if _stage_identity(stage) != record.get("stageIdentity"):
            return "unknown_original"
        if fingerprint(stage)["treeDigest"] != record["treeDigest"]:
            _exchange(live, stage)
            _fsync_dir(workspace)
            if _expected_link(stage, cache):
                stage.unlink()
            record.update({"state": "retained", "cleanupDone": True})
            _write_manifest(manifest_file, record)
            return "retained_mutated_original"
    record.update({"state": "offloaded", "cleanupStarted": True})
    _write_manifest(manifest_file, record)
    if not _discard_original(stage, record):
        return "cleanup_pending"
    record.pop("previous", None)
    _write_manifest(manifest_file, record)
    return "restored" if restored else "ready"


def restore_all(root, store, *, cold=False):
    """Cold-start recovery; unavailable S3 never replaces existing data.

    Return counts only, suitable for private diagnostics without project names.
    Native chat startup can proceed when dependencies await a storage retry.
    """
    os.umask(0o077)
    root = _real_directory(root)
    result = {"restored": 0, "ready": 0, "retained": 0, "deferred": 0, "failed": 0,
              "reasons": {}}
    working_store = store
    with _locked(root):
        directory = root / "t3/archive/dependencies"
        for file in sorted(directory.glob("*.json")):
            try:
                outcome = _restore_one(root, file, working_store, cold=cold)
                if outcome == "archive_unconfigured" and store is not None and working_store is None:
                    outcome = "archive_unavailable"
                category = outcome if outcome in ("restored", "ready", "retained") else "deferred"
                result[category] += 1
                result["reasons"][outcome] = result["reasons"].get(outcome, 0) + 1
            except ArchiveStoreError:
                # One failed network transfer is enough evidence of an outage.
                # Do not spend the cold-start deadline once for every archive.
                working_store = None
                result["failed"] += 1
                result["storageUnavailable"] = True
            except (DependencyCacheError, OSError, ValueError, tarfile.TarError, RuntimeError):
                result["failed"] += 1
    return result
