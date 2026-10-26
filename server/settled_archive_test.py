import gzip
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from archive_store import LocalStore
from compact_reasoning import view_fingerprint
import settled_archive as archive

A = "11111111-1111-4111-8111-111111111111"
B = "22222222-2222-4222-8222-222222222222"
OLD = "2020-01-01T00:00:00.000Z"


class Fixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name)
        self.root = self.base / "data"
        self.dbfile = self.root / "t3/userdata/statev2.sqlite"
        self.dbfile.parent.mkdir(parents=True)
        self.store = LocalStore(self.base / "external")
        with sqlite3.connect(self.dbfile) as db:
            db.executescript("""
            CREATE TABLE orchestration_events(sequence INTEGER PRIMARY KEY,event_id TEXT,
              aggregate_kind TEXT,stream_id TEXT,stream_version INTEGER,event_type TEXT,
              payload_json TEXT,application_event_version INTEGER);
            CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY,payload_json TEXT);
            CREATE TABLE orchestration_v2_projection_metadata(projection_name TEXT,schema_version INTEGER,last_sequence INTEGER);
            INSERT INTO orchestration_v2_projection_metadata VALUES('thread-projections',2,1000000);
            CREATE TABLE orchestration_v2_effect_outbox(thread_id TEXT,status TEXT);
            """)
            for name in ["runs", "subagents", "runtime_requests", "provider_threads", "turn_items"]:
                db.execute('CREATE TABLE "' + archive.PREFIX + name + '" (thread_id TEXT,status TEXT,payload_json TEXT,type TEXT)')
        self.thread(A)

    def tearDown(self):
        self.temp.cleanup()

    def thread(self, ident, **override):
        payload = {"id": ident, "updatedAt": OLD, "settledAt": OLD,
                   "settledOverride": "settled", "deletedAt": None, "worktreePath": None, **override}
        with sqlite3.connect(self.dbfile) as db:
            db.execute("INSERT OR REPLACE INTO orchestration_v2_projection_threads VALUES(?,?)", (ident, json.dumps(payload)))

    def events(self, ident=A, kind="dynamic_tool", field="output", count=7):
        with sqlite3.connect(self.dbfile) as db:
            start = db.execute("SELECT COALESCE(MAX(sequence),0) FROM orchestration_events").fetchone()[0]
            for n in range(count):
                payload = {"id": ident + "-item", "threadId": ident, "type": kind,
                           field: "snapshot " + str(n) + " " + "x" * 5000,
                           "ordinal": 4, "status": "completed", "updatedAt": OLD,
                           "prompt": "Never shorten prompts"}
                db.execute("INSERT INTO orchestration_events VALUES(?,?,?,?,?,?,?,2)",
                           (start+n+1, "event-"+str(start+n+1), "thread", ident, n+1,
                            "turn-item.updated", json.dumps(payload)))

    def payloads(self):
        with sqlite3.connect(self.dbfile) as db:
            return list(db.execute("SELECT sequence,payload_json FROM orchestration_events ORDER BY sequence"))

    def test_verified_archive_preserves_views_identity_first_and_latest(self):
        self.events()
        with sqlite3.connect(self.dbfile) as db:
            before = view_fingerprint(db)
            identities = list(db.execute("SELECT sequence,event_id,stream_id,stream_version,event_type FROM orchestration_events"))
        original = self.payloads()
        result = archive.archive_one(self.root, self.dbfile, A, self.store)
        self.assertEqual(result["changed"], 4)
        after = self.payloads()
        for index in [0, 5, 6]:
            self.assertEqual(after[index], original[index])
        for index in [1, 2, 3, 4]:
            current = json.loads(after[index][1])
            expected = json.loads(original[index][1])
            expected["output"] = archive.NOTICE
            self.assertEqual(current, expected)
        with sqlite3.connect(self.dbfile) as db:
            self.assertEqual(view_fingerprint(db), before)
            self.assertEqual(list(db.execute("SELECT sequence,event_id,stream_id,stream_version,event_type FROM orchestration_events")), identities)
        manifest = json.loads((self.root / "t3/archive/threads" / (A + ".json")).read_text())
        obj = self.base / "external" / manifest["current"]["key"]
        with gzip.open(obj, "rt") as stream:
            lines = [json.loads(line) for line in stream]
        self.assertEqual(lines[-1]["complete"], True)
        saved = [r["row"] for r in lines if "row" in r and len(r["row"]) == 8]
        self.assertEqual([r[6] for r in saved], [r[1] for r in original])
        # Idempotence: first immutable version remains available, no reupload.
        self.assertEqual(archive.archive_one(self.root, self.dbfile, A, self.store)["archived"], 0)
        self.assertEqual(archive.archive_one(self.root, self.dbfile, A, self.store)["changed"], 0)

    def test_upload_failure_leaves_every_original(self):
        self.events()
        before = self.payloads()
        with patch.object(self.store, "put_verified", side_effect=OSError("offline")):
            with self.assertRaises(OSError):
                archive.archive_one(self.root, self.dbfile, A, self.store)
        self.assertEqual(before, self.payloads())
        self.assertFalse((self.root / "t3/archive/threads" / (A + ".json")).exists())

    def test_resume_during_upload_prevents_compaction(self):
        self.events()
        before = self.payloads()
        original = self.store.put_verified
        def resume(key, source):
            result = original(key, source)
            self.thread(A, settledOverride="active", settledAt=None)
            return result
        with patch.object(self.store, "put_verified", side_effect=resume):
            with self.assertRaises(archive.Deferred):
                archive.archive_one(self.root, self.dbfile, A, self.store)
        self.assertEqual(before, self.payloads())

    def test_pending_background_blocks_but_idle_provider_does_not(self):
        with sqlite3.connect(self.dbfile) as db:
            db.execute("INSERT INTO orchestration_v2_projection_provider_threads VALUES(?,?,?,NULL)", (A, "active", '{}'))
            self.assertTrue(archive.inactive(db, A, archive.schema(db)))
            db.execute("UPDATE orchestration_v2_projection_provider_threads SET payload_json=?", (json.dumps({"pendingBackgroundTasks": [{"id": "live"}]}),))
            self.assertFalse(archive.inactive(db, A, archive.schema(db)))

    def test_pending_completion_and_unknown_status_block(self):
        with sqlite3.connect(self.dbfile) as db:
            db.execute("INSERT INTO orchestration_v2_projection_subagents VALUES(?,?,?,NULL)", (A, "completed", '{"completionDelivery":{"state":"pending"}}'))
            self.assertFalse(archive.inactive(db, A, archive.schema(db)))
            db.execute("DELETE FROM orchestration_v2_projection_subagents")
            db.execute("INSERT INTO orchestration_v2_projection_runs VALUES(?,?,?,NULL)", (A, "future_state", '{}'))
            self.assertFalse(archive.inactive(db, A, archive.schema(db)))

    def test_live_command_blocks_stale_legacy_reasoning_does_not(self):
        with sqlite3.connect(self.dbfile) as db:
            db.execute("INSERT INTO orchestration_v2_projection_turn_items VALUES(?,?,?,?)", (A, "running", '{}', "reasoning"))
            self.assertTrue(archive.inactive(db, A, archive.schema(db)))
            db.execute("INSERT INTO orchestration_v2_projection_turn_items VALUES(?,?,?,?)", (A, "running", '{}', "command_execution"))
            self.assertFalse(archive.inactive(db, A, archive.schema(db)))

    def test_active_shared_owner_with_alias_blocks_swap(self):
        workspace = self.root / "t3/scratch/project"
        (workspace / "child").mkdir(parents=True)
        self.thread(A, worktreePath=str(workspace))
        self.thread(B, worktreePath=str(workspace / "child/.."), settledOverride="active", settledAt=None)
        with patch.object(archive, "process_busy", return_value=False):
            with self.assertRaises(archive.Deferred):
                with archive.dependency_guard(self.dbfile, A, workspace)():
                    self.fail("Active owner was ignored")

    def test_fair_rotation_processes_more_than_largest_thread(self):
        self.thread(B)
        self.events(A, count=10)
        self.events(B, count=3)
        visits = []
        with patch.object(archive, "archive_one", side_effect=lambda root, db, tid, store, **kw: visits.append(tid) or {}), patch("dependency_cache.restore_all", return_value={}):
            archive.maintain(self.root, store=self.store, limit=1)
            archive.maintain(self.root, store=self.store, limit=1)
        self.assertEqual(visits, [A, B])

    def test_strings_only_and_last_small_snapshot_retained(self):
        self.events(kind="dynamic_tool", field="input", count=5)
        with sqlite3.connect(self.dbfile) as db:
            payload = json.loads(db.execute("SELECT payload_json FROM orchestration_events WHERE sequence=2").fetchone()[0])
            payload["input"] = {"nested": "x" * 6000}
            db.execute("UPDATE orchestration_events SET payload_json=? WHERE sequence=2", (json.dumps(payload),))
        before = self.payloads()[1]
        archive.archive_one(self.root, self.dbfile, A, self.store)
        self.assertEqual(self.payloads()[1], before)


if __name__ == "__main__":
    unittest.main()
