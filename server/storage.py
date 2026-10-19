"""Cold-start recovery. Never prune projects, conversations, credentials or databases."""
import datetime
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile

ROOT = Path(os.environ.get("T3_PHONE_ROOT", "/data"))
MIN_FREE = 96 * 1024 * 1024
MARKER = ROOT / "resource-recovery-v1"


def digest(file):
    h = hashlib.sha256()
    for chunk in iter(lambda: file.read(1024 * 1024), b""):
        h.update(chunk)
    return h.hexdigest()


def compress_verified(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = destination.with_name(destination.name + ".partial")
    try:
        with source.open("rb") as src, gzip.open(temporary, "wb", compresslevel=1) as dst:
            shutil.copyfileobj(src, dst, 1024 * 1024)
        os.chmod(temporary, 0o600)
        with source.open("rb") as src, gzip.open(temporary, "rb") as dst:
            assert digest(src) == digest(dst), "Recovery archive verification failed"
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)


ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
before = shutil.disk_usage(ROOT).free
# These two directories contain downloaded tool dependencies and model caches,
# not project files. OpenCode regenerates them; its auth/config stay untouched.
for relative in ["cache", "config/opencode/node_modules"]:
    candidate = ROOT / relative
    if candidate.exists() and not candidate.is_symlink():
        shutil.rmtree(candidate)

needs_recovery = not MARKER.exists()
if needs_recovery:
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = ROOT / "backups" / ("resource-recovery-" + stamp)
    backup.mkdir(parents=True, mode=0o700)
    # Preserve diagnostics before reducing their size. Existing child processes
    # are not running yet, so these are stable files rather than live logs.
    logs = [ROOT / "server.log", ROOT / "opencode-server.log"]
    logs += list((ROOT / "t3/userdata/logs").glob("server.trace.ndjson*"))
    for file in logs:
        if not file.is_file() or file.is_symlink() or file.stat().st_size < 1024 * 1024:
            continue
        relative = file.relative_to(ROOT)
        compress_verified(file, backup / (str(relative) + ".gz"))
        with file.open("rb") as stream:
            stream.seek(max(0, file.stat().st_size - 256 * 1024))
            tail = stream.read()
        file.write_bytes(tail)
        os.chmod(file, 0o600)

    manifest = {"createdAt": stamp, "databases": []}
    with tempfile.TemporaryDirectory(prefix="t3-recovery-") as scratch:
        candidates = []
        for base in [ROOT / "t3/userdata", ROOT / "data"]:
            for pattern in ["*.sqlite", "*.db"]:
                candidates.extend(base.rglob(pattern))
        for number, file in enumerate(sorted(set(candidates))):
            if not file.is_file() or file.is_symlink():
                continue
            with file.open("rb") as stream:
                if stream.read(16) != b"SQLite format 3\0":
                    continue
            copy = Path(scratch) / (str(number) + ".sqlite")
            with sqlite3.connect(file.as_uri() + "?mode=ro", uri=True) as src:
                with sqlite3.connect(copy) as dst:
                    src.backup(dst, pages=256)
                    assert dst.execute("PRAGMA quick_check").fetchone()[0] == "ok"
            archive = backup / (str(file.relative_to(ROOT)) + ".gz")
            compress_verified(copy, archive)
            manifest["databases"].append({"path": str(file.relative_to(ROOT)), "bytes": copy.stat().st_size})
            # Reclaim committed WAL pages only after verifying a complete backup.
            with sqlite3.connect(file, timeout=10) as database:
                database.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchall()

    for relative in ["opencode.json", "opencode-server-password", "t3/userdata/settings.json"]:
        file = ROOT / relative
        if file.is_file():
            target = backup / relative
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            shutil.copy2(file, target)
            os.chmod(target, 0o600)
    secrets = ROOT / "t3/userdata/secrets"
    if secrets.is_dir():
        shutil.copytree(secrets, backup / "t3/userdata/secrets", dirs_exist_ok=True)
    (backup / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

    if not MARKER.exists():
        settings_file = ROOT / "t3/userdata/settings.json"
        if settings_file.is_file():
            settings = json.loads(settings_file.read_text())
            # Let interrupted work remain available for a deliberate resume,
            # rather than replaying all jobs together during crash recovery.
            settings["continueThreadsAfterServerUpdate"] = False
            settings_file.write_text(json.dumps(settings, indent=2) + "\n")
            os.chmod(settings_file, 0o600)
        MARKER.write_text(stamp + "\n")
        os.chmod(MARKER, 0o600)
    print("Storage recovery verified:", len(manifest["databases"]), "database backups;", backup)

print("Persistent storage free bytes:", shutil.disk_usage(ROOT).free, "(before recovery:", before, ")")
