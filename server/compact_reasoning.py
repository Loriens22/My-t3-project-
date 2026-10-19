"""Bound superseded reasoning snapshots, preserving event identity and current views.

Only already-projected, intermediate `reasoning.text` copies are shortened. The
first and two newest full snapshots, messages, tools, plans and all identifiers
remain untouched. Keeping event rows also keeps ingestion deduplication intact.
"""
import hashlib
import json
import sqlite3
from contextlib import contextmanager

NOTICE = "[Intermediate reasoning snapshot compacted. The complete reasoning is preserved in the latest snapshot.]"
INDEX = "t3_phone_reasoning_snapshots"


@contextmanager
def connect(file, timeout=0.5):
    db = sqlite3.connect(file, timeout=timeout)
    db.execute("PRAGMA cache_size=-2048")
    db.execute("PRAGMA temp_store=FILE")
    try:
        yield db
        db.commit()
    finally:
        db.close()


def view_fingerprint(db):
    """All durable, user-visible V2 views; metadata is checked separately."""
    result = {}
    tables = db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'orchestration_v2_projection_%' AND name <> 'orchestration_v2_projection_metadata' ORDER BY name").fetchall()
    for (table,) in tables:
        h = hashlib.sha256()
        for row in db.execute('SELECT * FROM "' + table + '" ORDER BY 1'):
            h.update(json.dumps(row, ensure_ascii=False, separators=(",", ":")).encode())
            h.update(b"\n")
        result[table] = h.hexdigest()
    return result


def compact(db, max_rows=20000, verify=False):
    columns = {r[1] for r in db.execute("PRAGMA table_info(orchestration_events)")}
    if not {"application_event_version", "payload_json", "sequence"} <= columns:
        return {"changed": 0, "reason": "unsupported_schema"}
    metadata = db.execute("SELECT last_sequence FROM orchestration_v2_projection_metadata WHERE projection_name='thread-projections' AND schema_version=2").fetchone()
    if not metadata:
        return {"changed": 0, "reason": "projection_not_ready"}
    before = view_fingerprint(db) if verify else None
    db.execute(f"""CREATE INDEX IF NOT EXISTS {INDEX}
        ON orchestration_events(json_extract(payload_json,'$.id'),sequence)
        WHERE event_type='turn-item.updated' AND application_event_version=2
        AND json_extract(payload_json,'$.type')='reasoning'""")
    db.commit()
    candidates = db.execute("""
        WITH ranked AS (
          SELECT sequence,
            MIN(sequence) OVER (PARTITION BY json_extract(payload_json,'$.id')) AS first_sequence,
            ROW_NUMBER() OVER (PARTITION BY json_extract(payload_json,'$.id') ORDER BY sequence DESC) AS newest
          FROM orchestration_events
          WHERE event_type='turn-item.updated' AND application_event_version=2
            AND json_extract(payload_json,'$.type')='reasoning'
        )
        SELECT e.sequence FROM ranked r
        JOIN orchestration_events e ON e.sequence=r.sequence
        WHERE r.newest>2 AND r.sequence<>r.first_sequence AND r.sequence<=?
          AND json_type(e.payload_json,'$.text')='text'
          AND LENGTH(json_extract(e.payload_json,'$.text'))>2048
        ORDER BY e.sequence LIMIT ?
    """, (metadata[0], max_rows)).fetchall()
    changed = 0
    text_bytes_reclaimed = 0
    for start in range(0, len(candidates), 32):
        ids = [v[0] for v in candidates[start:start + 32]]
        placeholders = ",".join("?" for _ in ids)
        with db:
            rows = db.execute(f"SELECT sequence,payload_json FROM orchestration_events WHERE sequence IN ({placeholders})", ids).fetchall()
            for sequence, encoded in rows:
                item = json.loads(encoded)
                text = item.get("text")
                if item.get("type") != "reasoning" or not isinstance(text, str) or len(text) <= 2048:
                    continue
                item["text"] = NOTICE
                replacement = json.dumps(item, ensure_ascii=True, separators=(",", ":"))
                db.execute("UPDATE orchestration_events SET payload_json=? WHERE sequence=?", (replacement, sequence))
                changed += 1
                text_bytes_reclaimed += len(text.encode()) - len(NOTICE.encode())
    if verify:
        assert before == view_fingerprint(db), "Compaction changed a durable user view"
        assert db.execute("PRAGMA quick_check").fetchone()[0] == "ok"
    return {"changed": changed, "textBytesReclaimed": text_bytes_reclaimed}


def incremental_reclaim(db, max_pages=4096):
    """Return freed pages to the volume, in bounded transactions on a live DB."""
    if db.execute("PRAGMA auto_vacuum").fetchone()[0] != 2:
        return {"incrementalVacuum": False}
    before = db.execute("PRAGMA page_count").fetchone()[0]
    for _ in range(max_pages // 128):
        if db.execute("PRAGMA freelist_count").fetchone()[0] == 0:
            break
        db.execute("PRAGMA incremental_vacuum(128)").fetchall()
        db.commit()
    checkpoint = db.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
    return {"incrementalVacuum": True, "pagesReclaimed": before - db.execute("PRAGMA page_count").fetchone()[0], "checkpointBusy": checkpoint[0]}
