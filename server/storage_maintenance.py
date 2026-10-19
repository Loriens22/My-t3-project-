"""Cold SQLite conversion and bounded live reclamation. Never removes user work."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile
import time

from compact_reasoning import compact, connect, incremental_reclaim, view_fingerprint

MIB = 1024 * 1024


def compressed_backup(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    part = destination.with_name(destination.name + ".partial")
    before = hashlib.sha256()
    with source.open("rb") as src, gzip.open(part, "wb", compresslevel=1) as dst:
        for chunk in iter(lambda: src.read(MIB), b""):
            before.update(chunk)
            dst.write(chunk)
    after = hashlib.sha256()
    with gzip.open(part, "rb") as src:
        for chunk in iter(lambda: src.read(MIB), b""):
            after.update(chunk)
    assert before.digest() == after.digest(), "Backup verification failed"
    os.chmod(part, 0o600)
    part.replace(destination)


def trim_diagnostics(root):
    limit = MIB if shutil.disk_usage(root).free >= 128 * MIB else 256 * 1024
    files = []
    for base, pattern in [(root / "t3/userdata/logs/provider", "events*.log*"),
                          (root / "data/opencode/log", "*.log*")]:
        if base.is_dir() and not base.is_symlink():
            files += [p for p in base.glob(pattern) if p.is_file() and not p.is_symlink()]
    freed = 0
    # Truncate in place: active append-only log descriptors remain valid and
    # cannot keep an unlinked, invisible file consuming the volume.
    for file in files:
        size = file.stat().st_size
        if size > limit:
            with file.open("rb") as stream:
                stream.seek(size - limit)
                tail = stream.read().split(b"\n", 1)
            retained = tail[1] if len(tail) == 2 else b""
            with file.open("r+b") as stream:
                stream.write(retained)
                stream.truncate()
            freed += size - len(retained)
    total = sum(p.stat().st_size for p in files)
    for file in sorted(files, key=lambda p: p.stat().st_mtime):
        if total <= 8 * MIB:
            break
        size = file.stat().st_size
        with file.open("r+b") as stream:
            stream.truncate(0)
        freed += size
        total -= size
    return freed


def archive_unused_v1(root, scratch):
    """Keep the unused import database as a verified gzip if staging needs space.

    T3's initializeV2Database returns immediately when statev2.sqlite exists.
    The live V2 database and its complete conversation history stay untouched.
    """
    legacy = root / "t3/userdata/state.sqlite"
    if not legacy.is_file() or legacy.is_symlink():
        return 0
    snapshot = scratch / "legacy-v1.sqlite"
    with connect(legacy, timeout=5) as source, connect(snapshot, timeout=5) as dest:
        source.backup(dest, pages=128)
        assert dest.execute("PRAGMA quick_check").fetchone()[0] == "ok"
    archive = root / "backups/legacy-v1-state.sqlite.gz"
    compressed_backup(snapshot, archive)
    before = legacy.stat().st_size
    legacy.unlink()
    for suffix in ["-wal", "-shm"]:
        Path(str(legacy) + suffix).unlink(missing_ok=True)
    return before - archive.stat().st_size


def convert_cold(root, file, reasoning=False):
    if not file.is_file() or file.is_symlink():
        return {"converted": False}
    with connect(file, timeout=5) as db:
        if db.execute("PRAGMA auto_vacuum").fetchone()[0] == 2:
            return {"converted": False}
        db.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchall()
    # The original stays intact until a checked, complete replacement is fsynced
    # on the same volume. A failed preparation never unlinks the source database.
    stage = file.with_name(file.name + ".storage-new")
    stage.unlink(missing_ok=True)
    scratch_root = Path(os.environ.get("T3_STORAGE_SCRATCH", "/tmp/t3-storage"))
    scratch_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.TemporaryDirectory(prefix="prepare-", dir=scratch_root) as work:
        prepared = Path(work) / "prepared.sqlite"
        with connect(file, timeout=5) as src, connect(prepared, timeout=5) as dst:
            src.backup(dst, pages=128)
            assert dst.execute("PRAGMA quick_check").fetchone()[0] == "ok"
        compressed_backup(prepared, scratch_root / (file.name + ".before-compaction.gz"))
        result = {"beforeBytes": file.stat().st_size}
        with connect(prepared, timeout=5) as db:
            if reasoning:
                result.update(compact(db, verify=True))
            db.execute("PRAGMA auto_vacuum=INCREMENTAL")
            db.execute("VACUUM")
            assert db.execute("PRAGMA auto_vacuum").fetchone()[0] == 2
            assert db.execute("PRAGMA quick_check").fetchone()[0] == "ok"
            db.execute("PRAGMA journal_mode=WAL").fetchone()
        needed = prepared.stat().st_size
        if reasoning and shutil.disk_usage(root).free < needed + 2 * MIB:
            result["legacyArchiveBytesReclaimed"] = archive_unused_v1(root, Path(work))
        if shutil.disk_usage(root).free < needed + 2 * MIB:
            raise RuntimeError("Insufficient staging space; original database preserved")
        try:
            with prepared.open("rb") as src, stage.open("wb") as dst:
                shutil.copyfileobj(src, dst, MIB)
                dst.flush()
                os.fsync(dst.fileno())
            os.chmod(stage, 0o600)
            # All runtimes are stopped. A completed checkpoint made sidecars
            # obsolete; they must never be attached to the replacement database.
            for suffix in ["-wal", "-shm"]:
                Path(str(file) + suffix).unlink(missing_ok=True)
            os.replace(stage, file)
            directory = os.open(file.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            stage.unlink(missing_ok=True)
        result.update({"converted": True, "afterBytes": file.stat().st_size})
        return result


def maintain(root, cold=False, force=False):
    os.umask(0o077)
    started = time.monotonic()
    root = Path(root)
    before = shutil.disk_usage(root).free
    result = {"beforeFree": before, "diagnosticBytesReclaimed": trim_diagnostics(root)}
    state = root / "t3/userdata/statev2.sqlite"
    opencode = root / "data/opencode/opencode.db"
    if cold:
        # Fresh installs can start with page reclamation enabled. Do not create
        # a V2 file ahead of a pending V1 import on an existing installation.
        fresh = not state.exists() and not (root / "t3/userdata/state.sqlite").exists()
        for file in ([state, opencode] if fresh else []):
            if not file.exists():
                file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with connect(file) as db:
                    db.execute("PRAGMA auto_vacuum=INCREMENTAL")
                    db.execute("VACUUM")
        # OpenCode's free pages help stage the larger T3 conversion safely.
        result["opencode"] = convert_cold(root, opencode)
        result["t3"] = convert_cold(root, state, reasoning=True)
    if state.is_file() and (force or state.stat().st_size > 96 * MIB or before < 192 * MIB):
        try:
            with connect(state) as db:
                result["reasoning"] = compact(db)
                result["reclaim"] = incremental_reclaim(db, max_pages=8192)
        except sqlite3.OperationalError as error:
            if "locked" not in str(error).lower() and "busy" not in str(error).lower():
                raise
            result["deferred"] = "database_busy"
    if opencode.is_file():
        try:
            with connect(opencode) as db:
                result["opencodeReclaim"] = incremental_reclaim(db, max_pages=2048)
        except sqlite3.OperationalError as error:
            if "locked" not in str(error).lower() and "busy" not in str(error).lower():
                raise
    result["afterFree"] = shutil.disk_usage(root).free
    result["milliseconds"] = round((time.monotonic() - started) * 1000)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--cold", action="store_true")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    try:
        os.nice(10)
    except OSError:
        pass
    print(json.dumps(maintain(os.environ.get("T3_PHONE_ROOT", "/data"), cold=args.cold, force=args.force)), flush=True)
