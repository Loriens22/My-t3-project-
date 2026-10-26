"""Verified private tiering for idle Settled conversations.

Readable native projections, source files, event identities and resume state stay
on the volume. Only superseded string snapshots are shortened after a verified
external copy. Reproducible dependencies use the separately recoverable cache.
"""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import tempfile
import time

from archive_store import make_store, sha256_file
from compact_reasoning import connect, incremental_reclaim

MIB = 1024 * 1024
FINAL = {"completed", "failed", "cancelled", "interrupted", "rolled_back"}
PREFIX = "orchestration_v2_projection_"
NOTICE = "[Superseded snapshot archived. The complete current content remains in the conversation.]"
FIELDS = {
    "reasoning": ("text",),
    "assistant_message": ("text",),
    "command_execution": ("input", "output"),
    "dynamic_tool": ("input", "output"),
    "file_change": ("diffStr", "oldStr", "newStr"),
}


class Deferred(RuntimeError):
    pass


def atomic_json(file, value):
    file = Path(file)
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if file.is_symlink():
        raise Deferred("unsafe_manifest")
    fd, name = tempfile.mkstemp(prefix=".archive-", dir=file.parent)
    try:
        with os.fdopen(fd, "w") as out:
            json.dump(value, out, separators=(",", ":"))
            out.flush()
            os.fsync(out.fileno())
        os.replace(name, file)
        directory = os.open(file.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        Path(name).unlink(missing_ok=True)


def read_json(file, default=None):
    try:
        if file.is_symlink():
            raise Deferred("unsafe_manifest")
        return json.loads(file.read_text())
    except FileNotFoundError:
        return default


def age_seconds(value, now):
    try:
        return now - datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError, AttributeError):
        return -1


def settled(thread, now=None, grace=120):
    now = time.time() if now is None else now
    if thread.get("deletedAt") or thread.get("settledOverride") == "active":
        return False
    when = thread.get("settledAt") or thread.get("archivedAt")
    return bool(when and min(age_seconds(when, now), age_seconds(thread.get("updatedAt"), now)) >= grace)


def schema(db):
    return {name: {r[1] for r in db.execute('PRAGMA table_info("' + name + '")')}
            for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}


def inactive(db, thread_id, tables):
    # Unknown schemas/statuses fail closed. Do not infer inactivity merely from
    # a completed parent run: background children can wake it again.
    for suffix, finished in [
        ("runs", FINAL), ("subagents", FINAL),
        ("runtime_requests", {"resolved", "cancelled", "expired"}),
    ]:
        table = PREFIX + suffix
        if not {"thread_id", "status", "payload_json"} <= tables.get(table, set()):
            return False
        for status, raw in db.execute('SELECT status,payload_json FROM "' + table + '" WHERE thread_id=?', (thread_id,)):
            if status not in finished:
                return False
            item = json.loads(raw)
            delivery = item.get("completionDelivery") or {}
            if delivery.get("state") in ("pending", "claimed"):
                return False
    table = PREFIX + "provider_threads"
    if "payload_json" not in tables.get(table, set()):
        return False
    for (raw,) in db.execute('SELECT payload_json FROM "' + table + '" WHERE thread_id=?', (thread_id,)):
        if json.loads(raw).get("pendingBackgroundTasks"):
            return False
    table = "orchestration_v2_effect_outbox"
    if not {"thread_id", "status"} <= tables.get(table, set()):
        return False
    if any(status not in {"succeeded", "cancelled", "failed"}
           for (status,) in db.execute('SELECT status FROM "' + table + '" WHERE thread_id=?', (thread_id,))):
        return False
    table = PREFIX + "turn_items"
    if not {"thread_id", "type", "status"} <= tables.get(table, set()):
        return False
    if db.execute('SELECT 1 FROM "' + table + '" WHERE thread_id=? AND type IN (\'command_execution\',\'dynamic_tool\',\'subagent\') AND status IN (\'pending\',\'running\',\'waiting\') LIMIT 1', (thread_id,)).fetchone():
        return False
    return True


def thread_state(db, thread_id, tables, *, grace=120, expected_sequence=None):
    row = db.execute("SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id=?", (thread_id,)).fetchone()
    if not row:
        raise Deferred("thread_missing")
    thread = json.loads(row[0])
    if not settled(thread, grace=grace) or not inactive(db, thread_id, tables):
        raise Deferred("thread_active")
    sequence = db.execute("SELECT COALESCE(MAX(sequence),0) FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id=?", (thread_id,)).fetchone()[0]
    watermark = db.execute("SELECT last_sequence FROM orchestration_v2_projection_metadata WHERE projection_name='thread-projections' AND schema_version=2").fetchone()
    if not watermark or watermark[0] < sequence:
        raise Deferred("projection_pending")
    if expected_sequence is not None and sequence != expected_sequence:
        raise Deferred("thread_changed")
    return thread, sequence


def snapshot(db, thread_id, sequence, target, tables):
    # The caller holds one consistent read transaction, released before network
    # IO. Raw JSON payloads are retained, not rendered or logged.
    count = 0
    with target.open("wb") as raw, gzip.GzipFile(filename="", fileobj=raw, mode="wb", compresslevel=1, mtime=0) as packed:
        def emit(value):
            packed.write(json.dumps(value, ensure_ascii=True, separators=(",", ":")).encode() + b"\n")
        emit({"format": "t3-settled-snapshot", "version": 1, "threadId": thread_id, "throughSequence": sequence})
        selected = {"orchestration_events": "aggregate_kind='thread' AND stream_id=? AND sequence<=" + str(int(sequence))}
        for name, columns in tables.items():
            if name.startswith(PREFIX) and "thread_id" in columns:
                selected[name] = "thread_id=?"
        for name, where in sorted(selected.items()):
            cursor = db.execute('SELECT * FROM "' + name + '" WHERE ' + where + ' ORDER BY 1', (thread_id,))
            columns = [d[0] for d in cursor.description]
            emit({"table": name, "columns": columns})
            for row in cursor:
                emit({"row": row})
                count += 1
        emit({"complete": True, "rows": count})
    with target.open("rb") as raw:
        os.fsync(raw.fileno())
    return count


def compact_thread(db, thread_id, through_sequence, max_rows=4000):
    """Keep every row plus first/latest two complete entity snapshots.

    Fields are a strict string allowlist. Structural data, prompts, references,
    statuses and timestamps remain byte-for-byte the same. Nothing here changes
    any current materialized view, ingestion receipt or event sequence.
    """
    rows = db.execute("""
      WITH ranked AS (
        SELECT sequence,
          MIN(sequence) OVER (PARTITION BY event_type,json_extract(payload_json,'$.id')) AS first_sequence,
          ROW_NUMBER() OVER (PARTITION BY event_type,json_extract(payload_json,'$.id') ORDER BY sequence DESC) AS newest
        FROM orchestration_events
        WHERE aggregate_kind='thread' AND stream_id=? AND application_event_version=2
          AND sequence<=? AND event_type IN ('turn-item.updated','message.updated')
          AND json_type(payload_json,'$.id')='text'
      )
      SELECT e.sequence,e.event_type,e.payload_json FROM ranked r
      JOIN orchestration_events e ON e.sequence=r.sequence
      WHERE r.newest>2 AND r.sequence<>r.first_sequence AND LENGTH(e.payload_json)>2048
      ORDER BY e.sequence
    """, (thread_id, through_sequence))
    changed = reclaimed = 0
    # Cursor streams large histories. Updates on the same connection preserve
    # sequence ordering; only non-indexed text fields are changed.
    for sequence, event_type, encoded in rows:
        payload = json.loads(encoded)
        fields = ("text",) if event_type == "message.updated" else FIELDS.get(payload.get("type"), ())
        modified = False
        for field in fields:
            value = payload.get(field)
            if isinstance(value, str) and len(value.encode()) > 2048:
                payload[field] = NOTICE
                modified = True
        if modified:
            replacement = json.dumps(payload, ensure_ascii=True, separators=(",", ":"))
            saving = len(encoded.encode()) - len(replacement.encode())
            if saving > 0:
                db.execute("UPDATE orchestration_events SET payload_json=? WHERE sequence=? AND payload_json=?", (replacement, sequence, encoded))
                changed += 1
                reclaimed += saving
                if changed >= max_rows:
                    break
    return {"changed": changed, "payloadBytesReclaimed": reclaimed}


def process_busy(workspace):
    """Read-only static previews can stay open; package/build/unknown jobs cannot."""
    workspace = Path(workspace)
    own = os.getpid()
    for process in Path("/proc").iterdir():
        if not process.name.isdigit() or int(process.name) == own:
            continue
        try:
            cwd = (process / "cwd").resolve(strict=True)
            if cwd.is_relative_to(workspace):
                args = (process / "cmdline").read_bytes().split(b"\0")
                static = len(args) > 2 and Path(os.fsdecode(args[0])).name.startswith("python") and args[1:3] == [b"-m", b"http.server"]
                if not static:
                    return True
            for fd in (process / "fd").iterdir():
                try:
                    path = fd.resolve(strict=True)
                    if path.is_relative_to(workspace):
                        info = (process / "fdinfo" / fd.name).read_text()
                        flags = re.search(r"^flags:\s+([0-7]+)", info, re.M)
                        if not flags or int(flags[1], 8) & os.O_ACCMODE:
                            return True
                except FileNotFoundError:
                    pass
        except FileNotFoundError:
            pass
        except (PermissionError, OSError):
            # Cannot prove the process is safe in a restricted /proc environment.
            return True
    return False


def dependency_guard(dbfile, thread_id, workspace, grace=120):
    @contextmanager
    def guard():
        with connect(dbfile, timeout=1) as db:
            db.execute("BEGIN IMMEDIATE")
            tables = schema(db)
            thread_state(db, thread_id, tables, grace=grace)
            owners = []
            for owner_id, raw in db.execute("SELECT thread_id,payload_json FROM orchestration_v2_projection_threads"):
                owner = json.loads(raw)
                bound = owner.get("worktreePath")
                if bound:
                    path = Path(bound).resolve()
                    canonical = workspace.resolve()
                    if path == canonical or path.is_relative_to(canonical) or canonical.is_relative_to(path):
                        owners.append(owner_id)
                        thread_state(db, owner_id, tables, grace=grace)
            if thread_id not in owners or process_busy(workspace):
                raise Deferred("workspace_busy")
            yield
    return guard


def archive_one(root, dbfile, thread_id, store, *, grace=120, compact_enabled=True):
    if not re.fullmatch(r"[a-fA-F0-9-]{16,64}", thread_id):
        raise Deferred("invalid_thread_id")
    manifest_file = root / "t3/archive/threads" / (thread_id + ".json")
    previous = read_json(manifest_file, {})
    current = previous
    with connect(dbfile) as db:
        tables = schema(db)
        thread, sequence = thread_state(db, thread_id, tables, grace=grace)
    result = {"archived": 0, "changed": 0, "payloadBytesReclaimed": 0}
    if previous.get("throughSequence") != sequence or not previous.get("verified"):
        with tempfile.TemporaryDirectory(prefix="t3-thread-archive-") as temporary:
            packed = Path(temporary) / "snapshot.jsonl.gz"
            with connect(dbfile) as db:
                db.execute("BEGIN")
                tables = schema(db)
                thread, sequence = thread_state(db, thread_id, tables, grace=grace)
                count = snapshot(db, thread_id, sequence, packed, tables)
            digest = sha256_file(packed)
            key = "v1/threads/" + thread_id + "/" + str(sequence) + "-" + digest + ".jsonl.gz"
            verified = store.put_verified(key, packed)
            versions = previous.get("versions", [])
            if not any(v.get("key") == key for v in versions):
                versions.append(verified)
            current = {"version": 1, "threadId": thread_id, "throughSequence": sequence,
                       "verified": True, "current": verified, "versions": versions,
                       "snapshotRows": count, "verifiedAt": datetime.now(timezone.utc).isoformat()}
            atomic_json(manifest_file, current)
            result["archived"] = 1
    if compact_enabled and not (current.get("compactionComplete") and not result["archived"]):
        if not result["archived"]:
            # A partially processed archive can span sweeps. Recheck external
            # availability before releasing any further local string snapshots.
            with tempfile.TemporaryDirectory(prefix="t3-thread-readback-") as temporary:
                obj = current["current"]
                store.get_verified(obj["key"], Path(temporary) / "verified.gz", obj["sha256"])
        with connect(dbfile, timeout=1) as db:
            db.execute("BEGIN IMMEDIATE")
            tables = schema(db)
            thread_state(db, thread_id, tables, grace=grace, expected_sequence=sequence)
            result.update(compact_thread(db, thread_id, sequence))
        current["compactionComplete"] = result["changed"] < 4000
        atomic_json(manifest_file, current)
    workspace = thread.get("worktreePath")
    if workspace:
        from dependency_cache import DependencyCacheError, offload
        path = Path(workspace)
        if path.is_dir() and path.is_relative_to(root / "t3/scratch"):
            try:
                result["dependencies"] = offload(root, path, store, dependency_guard(dbfile, thread_id, path, grace))
            except (DependencyCacheError, Deferred) as error:
                result["dependencies"] = {"offloaded": False, "deferred": type(error).__name__}
    return result


def maintain(root, *, store=None, restore=False, limit=2, grace=120):
    root = Path(root).resolve()
    result = {"enabled": False, "archived": 0, "changed": 0, "payloadBytesReclaimed": 0,
              "dependenciesBytesReclaimed": 0, "deferred": 0}
    store = make_store() if store is None else store
    if store is None:
        return result
    result["enabled"] = True
    control = root / "t3/archive"
    control.mkdir(parents=True, exist_ok=True, mode=0o700)
    if control.is_symlink():
        raise Deferred("unsafe_control_directory")
    with (control / ".lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {**result, "deferred": "worker_running"}
        result["beforeFree"] = shutil.disk_usage(root).free
        from dependency_cache import restore_all
        result["restore"] = restore_all(root, store, cold=restore)
        dbfile = root / "t3/userdata/statev2.sqlite"
        if not restore and dbfile.is_file():
            with connect(dbfile) as db:
                rows = db.execute("""SELECT t.thread_id,t.payload_json,
                  COALESCE((SELECT SUM(LENGTH(e.payload_json)) FROM orchestration_events e
                    WHERE e.aggregate_kind='thread' AND e.stream_id=t.thread_id),0) AS weight
                  FROM orchestration_v2_projection_threads t ORDER BY weight DESC""").fetchall()
            cursor_file = control / "scan.json"
            scanned = read_json(cursor_file, {})
            # Fair persistent rotation. An unchanged large conversation cannot
            # starve newer settled projects when each sweep has a small budget.
            def priority(row):
                thread_id, raw, weight = row
                deps = 0
                workspace = json.loads(raw).get("worktreePath")
                if workspace:
                    tree = Path(workspace) / "node_modules"
                    if tree.is_dir() and not tree.is_symlink():
                        for base, dirs, files in os.walk(tree, followlinks=False):
                            for name in files:
                                try:
                                    deps += (Path(base) / name).lstat().st_size
                                except OSError:
                                    pass
                return (scanned.get(thread_id, 0), -(deps + weight))
            rows.sort(key=priority)
            handled = 0
            for thread_id, raw, weight in rows:
                if not settled(json.loads(raw), grace=grace):
                    continue
                try:
                    scanned[thread_id] = time.time()
                    one = archive_one(root, dbfile, thread_id, store, grace=grace)
                    for field in ("archived", "changed", "payloadBytesReclaimed"):
                        result[field] += one.get(field, 0)
                    dependency = one.get("dependencies", {})
                    result["dependenciesBytesReclaimed"] += dependency.get("bytesReclaimed", 0)
                    handled += 1
                    if handled >= limit:
                        break
                except (Deferred, sqlite3.OperationalError):
                    result["deferred"] += 1
                except Exception as error:
                    # No raw SDK error, URL, project output or credentials in logs.
                    result["lastError"] = type(error).__name__
                    result["deferred"] += 1
                    break
            atomic_json(cursor_file, scanned)
            with connect(dbfile) as db:
                result["reclaim"] = incremental_reclaim(db, max_pages=8192)
        result["afterFree"] = shutil.disk_usage(root).free
        result["at"] = datetime.now(timezone.utc).isoformat()
        atomic_json(control / "status.json", result)
    return result


if __name__ == "__main__":
    os.umask(0o077)
    try:
        os.nice(10)
    except OSError:
        pass
    parser = argparse.ArgumentParser()
    parser.add_argument("--restore", action="store_true")
    parser.add_argument("--limit", type=int, default=2)
    args = parser.parse_args()
    try:
        print(json.dumps(maintain(os.environ.get("T3_PHONE_ROOT", "/data"), restore=args.restore,
                                  limit=max(1, min(args.limit, 200)))), flush=True)
    except Exception as error:
        print(json.dumps({"enabled": False, "deferred": type(error).__name__}), flush=True)
        raise SystemExit(1)
