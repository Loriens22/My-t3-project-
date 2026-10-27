from contextlib import contextmanager, nullcontext
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import dependency_cache as cache
from archive_store import ArchiveStoreError, LocalStore


class BrokenStore:
    def put_verified(self, *_args):
        raise ArchiveStoreError("unavailable")
    def get_verified(self, *_args):
        raise ArchiveStoreError("unavailable")


class DependencyCacheTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="t3-dependency-test-")
        self.base = Path(self.temp.name)
        self.root = self.base / "persistent"
        self.workspace = self.root / "t3/scratch/example"
        self.workspace.mkdir(parents=True)
        self.module = self.workspace / "node_modules"
        package = self.module / "example"
        package.mkdir(parents=True)
        (package / "index.js").write_text("module.exports = require('t3-cache-hoisted-b') + require('@t3-cache/offset');\n")
        hoisted = self.module / "t3-cache-hoisted-b"
        hoisted.mkdir()
        (hoisted / "index.js").write_text("module.exports = 40;\n")
        scoped = self.module / "@t3-cache/offset"
        scoped.mkdir(parents=True)
        (scoped / "index.js").write_text("module.exports = 2;\n")
        (package / "large.dat").write_bytes(b"library-data-" * 100000)
        (package / "bin.js").write_text("#!/usr/bin/env node\nconsole.log(42);\n")
        (package / "bin.js").chmod(0o755)
        (self.module / ".bin").mkdir()
        (self.module / ".bin/example").symlink_to("../example/bin.js")
        (self.workspace / "package.json").write_text('{"name":"fixture","version":"1.0.0"}')
        (self.workspace / "package-lock.json").write_text('{"lockfileVersion":3}')
        (self.workspace / "app.js").write_text("console.log(require('example'));\n")
        self.patch = patch.object(cache, "CACHE_ROOT", self.base / "ephemeral")
        self.patch.start()
        self.store = LocalStore(self.base / "objects", verify_directory=self.base / "verify")
        self.original = cache.fingerprint(self.module)
        self.sources = {name: (self.workspace / name).read_bytes()
                        for name in ("package.json", "package-lock.json", "app.js")}

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    def offload(self, store=None, guard=nullcontext):
        return cache.offload(self.root, self.workspace, store or self.store, guard)

    def manifest(self):
        return next((self.root / "t3/archive/dependencies").glob("*.json"))

    def node(self):
        completed = subprocess.run(["node", "app.js"], cwd=self.workspace,
                                   check=True, capture_output=True, text=True)
        self.assertEqual(completed.stdout.strip(), "42")

    def legacy(self):
        """An actual deployed-layout fixture, without interpreting it as v2."""
        identifier, manifest, _stage = cache._paths(self.root, self.workspace)
        baseline = cache.fingerprint(self.module)
        old_cache = cache._cache(identifier, baseline["treeDigest"], layout=1)
        packed = self.base / "legacy-dependencies.tar.gz"
        cache._pack(self.module, packed)
        digest = cache.sha256_file(packed)
        key = "dependencies/" + digest + ".tar.gz"
        self.store.put_verified(key, packed)
        shutil.copytree(self.module, old_cache, symlinks=True)
        shutil.rmtree(self.module)
        self.module.symlink_to(old_cache)
        record = {"version": 1, "workspace": self.workspace.relative_to(self.root).as_posix(),
                  **baseline, "archiveKey": key, "archiveSha256": digest,
                  "archiveBytes": packed.stat().st_size, "locks": cache.lock_fingerprint(self.workspace),
                  "state": "offloaded", "cleanupStarted": True, "cleanupDone": True}
        cache._write_manifest(manifest, record)
        return record, old_cache, packed

    def prepared_migration(self, exchanged=False):
        previous, old_cache, packed = self.legacy()
        identifier, manifest, stage = cache._paths(self.root, self.workspace)
        current = {**previous, "cacheLayout": 2, "state": "prepared",
                   "cleanupStarted": False, "cleanupDone": False,
                   "stageIdentity": cache._stage_identity(self.module),
                   "stageLinkTarget": str(old_cache), "previous": previous}
        new_cache = cache._ensure_cache(current, identifier, packed)
        stage.symlink_to(new_cache)
        cache._write_manifest(manifest, current)
        if exchanged:
            cache._exchange(self.module, stage)
        return old_cache, new_cache, stage

    def test_import_and_executable_work_after_offload_and_cold_restore(self):
        self.node()
        result = self.offload()
        self.assertTrue(result["offloaded"])
        self.assertGreater(result["bytesReclaimed"], cache.MIN_BYTES)
        self.assertTrue(self.module.is_symlink())
        self.assertEqual(self.module.resolve().name, "node_modules")
        self.assertEqual(json.loads(self.manifest().read_text())["cacheLayout"], 2)
        self.assertEqual(cache.fingerprint(self.module.resolve()), self.original)
        self.node()
        self.assertEqual(subprocess.check_output([str(self.module / ".bin/example")], text=True).strip(), "42")
        for name, contents in self.sources.items():
            self.assertEqual((self.workspace / name).read_bytes(), contents)
        shutil.rmtree(cache.CACHE_ROOT)
        self.assertFalse(self.module.exists())
        restored = cache.restore_all(self.root, self.store)
        self.assertEqual(restored["restored"], 1)
        self.assertEqual(restored["failed"], 0)
        self.node()
        self.assertEqual(cache.fingerprint(self.module.resolve()), self.original)
        self.assertEqual(self.offload()["reason"], "already_offloaded")

    def test_legacy_layout_is_migrated_under_guard_for_hoisted_and_scoped_imports(self):
        previous, old_cache, _packed = self.legacy()
        old_contents = cache.fingerprint(old_cache)
        # Reproduce the real defect: the package can be found through the
        # workspace symlink, but its hoisted sibling cannot be resolved after
        # Node realpaths that package into the legacy digest-named directory.
        broken = subprocess.run(["node", "app.js"], cwd=self.workspace,
                                capture_output=True, text=True)
        self.assertNotEqual(broken.returncode, 0)
        self.assertIn("MODULE_NOT_FOUND", broken.stderr)
        calls = []
        @contextmanager
        def guarded():
            calls.append(True)
            yield
        migrated = self.offload(guard=guarded)
        self.assertTrue(migrated["migrated"])
        self.assertTrue(calls)
        self.assertEqual(self.module.resolve().name, "node_modules")
        self.assertEqual(cache.fingerprint(old_cache), old_contents)
        self.assertFalse(self.module.resolve().is_relative_to(old_cache))
        self.assertEqual(json.loads(self.manifest().read_text())["cacheLayout"], 2)
        self.node()
        shutil.rmtree(cache.CACHE_ROOT)
        self.assertEqual(cache.restore_all(self.root, self.store, cold=True)["restored"], 1)
        self.node()

    def test_esm_self_reference_and_hoisted_scoped_import_survive_cold_restore(self):
        package = self.module / "t3-cache-esm-a"
        package.mkdir()
        (package / "package.json").write_text(json.dumps({
            "name": "t3-cache-esm-a", "type": "module",
            "exports": {".": "./index.js", "./self": "./self.js"}}))
        (package / "self.js").write_text("export default 40;\n")
        (package / "index.js").write_text(
            "import value from 't3-cache-esm-a/self';\n"
            "import offset from '@t3-cache/offset';\n"
            "export default value + offset;\n")
        (self.workspace / "app.mjs").write_text("import value from 't3-cache-esm-a'; console.log(value);\n")
        def run():
            completed = subprocess.run(["node", "app.mjs"], cwd=self.workspace,
                                       check=True, capture_output=True, text=True)
            self.assertEqual(completed.stdout.strip(), "42")
        run()
        self.offload()
        run()
        shutil.rmtree(cache.CACHE_ROOT)
        self.assertEqual(cache.restore_all(self.root, self.store, cold=True)["restored"], 1)
        run()

    def test_legacy_cold_restore_keeps_original_link_until_guarded_migration(self):
        _previous, old_cache, _packed = self.legacy()
        shutil.rmtree(cache.CACHE_ROOT)
        restored = cache.restore_all(self.root, self.store, cold=True)
        self.assertEqual(restored["restored"], 1)
        self.assertEqual(Path(os.readlink(self.module)), old_cache)
        self.assertNotIn("cacheLayout", json.loads(self.manifest().read_text()))
        self.assertTrue(self.offload()["migrated"])
        self.node()

    def test_failed_migration_commit_restores_legacy_pointer_and_record(self):
        previous, old_cache, _packed = self.legacy()
        old_contents = cache.fingerprint(old_cache)
        @contextmanager
        def failed_commit():
            yield
            raise RuntimeError("commit failed")
        with self.assertRaises(RuntimeError):
            self.offload(guard=failed_commit)
        self.assertEqual(Path(os.readlink(self.module)), old_cache)
        self.assertEqual(json.loads(self.manifest().read_text()), previous)
        self.assertEqual(cache.fingerprint(old_cache), old_contents)
        self.assertFalse(list(self.workspace.glob(".t3-deps-original-*")))
        self.assertTrue(self.offload()["migrated"])
        self.node()

    def test_interrupted_migration_before_exchange_recovers_previous_layout(self):
        old_cache, _new_cache, stage = self.prepared_migration(exchanged=False)
        shutil.rmtree(cache.CACHE_ROOT)
        result = cache.restore_all(self.root, self.store, cold=True)
        self.assertEqual(result["restored"], 1)
        self.assertEqual(Path(os.readlink(self.module)), old_cache)
        self.assertFalse(stage.is_symlink())
        self.assertNotIn("cacheLayout", json.loads(self.manifest().read_text()))
        self.assertTrue(self.offload()["migrated"])
        self.node()

    def test_interrupted_migration_after_exchange_restores_new_layout(self):
        old_cache, new_cache, stage = self.prepared_migration(exchanged=True)
        self.assertFalse(new_cache.is_relative_to(old_cache))
        shutil.rmtree(cache.CACHE_ROOT)
        result = cache.restore_all(self.root, self.store, cold=True)
        self.assertEqual(result["restored"], 1)
        self.assertEqual(Path(os.readlink(self.module)), new_cache)
        self.assertFalse(stage.is_symlink())
        current = json.loads(self.manifest().read_text())
        self.assertEqual(current["cacheLayout"], 2)
        self.assertNotIn("previous", current)
        self.node()

    def test_upload_outage_preserves_original(self):
        with self.assertRaises(ArchiveStoreError):
            self.offload(BrokenStore())
        self.assertFalse(self.module.is_symlink())
        self.assertEqual(cache.fingerprint(self.module), self.original)
        self.node()

    def test_download_corruption_never_replaces_or_discards_data(self):
        self.offload()
        record = json.loads(self.manifest().read_text())
        (self.store.root / record["archiveKey"]).write_bytes(b"corrupt")
        shutil.rmtree(cache.CACHE_ROOT)
        result = cache.restore_all(self.root, self.store)
        self.assertEqual(result["failed"], 1)
        self.assertTrue(self.module.is_symlink())
        self.assertFalse(self.module.exists())
        for name, content in self.sources.items():
            self.assertEqual((self.workspace / name).read_bytes(), content)

    def test_eligibility_failure_at_commit_preserves_original(self):
        @contextmanager
        def denied():
            raise RuntimeError("active run")
            yield
        with self.assertRaises(RuntimeError):
            self.offload(guard=denied)
        self.assertFalse(self.module.is_symlink())
        self.assertEqual(cache.fingerprint(self.module), self.original)
        self.assertFalse(list(self.workspace.glob(".t3-deps-original-*")))

    def test_source_mutation_after_upload_preserves_new_original(self):
        outer = self
        class MutatingStore:
            def put_verified(self, *args):
                result = outer.store.put_verified(*args)
                (outer.module / "example/index.js").write_text("module.exports = 43;\n")
                return result
        with self.assertRaises(cache.DependencyCacheError):
            self.offload(MutatingStore())
        self.assertFalse(self.module.is_symlink())
        self.assertEqual((self.module / "example/index.js").read_text(), "module.exports = 43;\n")

    def test_lock_mutation_at_commit_preserves_original(self):
        @contextmanager
        def mutate():
            (self.workspace / "package-lock.json").write_text('{"changed":true}')
            yield
        with self.assertRaises(cache.DependencyCacheError):
            self.offload(guard=mutate)
        self.assertFalse(self.module.is_symlink())
        self.assertEqual(cache.fingerprint(self.module), self.original)

    def test_stale_lock_never_restores_an_older_archive(self):
        self.offload()
        shutil.rmtree(cache.CACHE_ROOT)
        (self.workspace / "package-lock.json").write_text('{"new":true}')
        restored = cache.restore_all(self.root, self.store)
        self.assertEqual(restored["reasons"].get("needs_reinstall"), 1)
        self.assertFalse(self.module.exists())
        self.assertEqual((self.workspace / "package-lock.json").read_text(), '{"new":true}')

    def test_newer_npm_install_wins_over_manifest(self):
        self.offload()
        self.module.unlink()
        self.module.mkdir()
        (self.module / "new-install").write_text("new dependency")
        restored = cache.restore_all(self.root, self.store)
        self.assertEqual(restored["retained"], 1)
        self.assertFalse(self.module.is_symlink())
        self.assertEqual((self.module / "new-install").read_text(), "new dependency")

    def test_escaping_symlink_and_non_scratch_workspace_are_rejected(self):
        (self.module / "escape").symlink_to(self.workspace / "app.js")
        with self.assertRaises(cache.DependencyCacheError):
            self.offload()
        self.assertFalse(self.module.is_symlink())
        with self.assertRaises(cache.DependencyCacheError):
            cache.offload(self.root, self.root / "t3/scratch", self.store, nullcontext)
        with self.assertRaises(cache.DependencyCacheError):
            cache.offload(self.root, self.root / "t3/scratch/../../projects", self.store, nullcontext)

    def test_atomic_exchange_unavailable_retains_original_without_path_gap(self):
        with patch.object(cache, "_exchange", side_effect=cache.DependencyCacheError("unsupported")):
            with self.assertRaises(cache.DependencyCacheError):
                self.offload()
        self.assertFalse(self.module.is_symlink())
        self.assertEqual(cache.fingerprint(self.module), self.original)
        self.assertFalse(list(self.workspace.glob(".t3-deps-original-*")))

    def test_cold_recovery_of_prepared_swap_and_partial_cleanup(self):
        # Stop immediately after commit, before unlinking the swapped original.
        with patch.object(cache, "_discard_original", return_value=False):
            result = self.offload()
        self.assertTrue(result["cleanupPending"])
        record = json.loads(self.manifest().read_text())
        record.update({"state": "prepared", "cleanupStarted": False})
        self.manifest().write_text(json.dumps(record))
        shutil.rmtree(cache.CACHE_ROOT)
        restored = cache.restore_all(self.root, self.store, cold=True)
        self.assertEqual(restored["restored"], 1)
        self.assertFalse(list(self.workspace.glob(".t3-deps-original-*")))
        self.node()
        # A kill during cleanup may leave a partial original. Committed cache
        # data wins; partial original is never restored over the full cache.
        record = json.loads(self.manifest().read_text())
        stage = self.workspace / (".t3-deps-original-" + self.manifest().stem[:20])
        stage.mkdir()
        (stage / "partial").write_text("incomplete original")
        self.assertTrue(record["cleanupStarted"])
        self.assertEqual(cache.restore_all(self.root, self.store, cold=True)["deferred"], 1)
        self.assertTrue(stage.exists(), "A later unowned directory must never be deleted")
        self.node()

    def test_refresh_changed_owned_cache_is_archived_and_restored(self):
        self.offload()
        (self.module / "example/extra.txt").write_text("new installed data")
        (self.workspace / "package-lock.json").write_text('{"newInstall":true}')
        changed = cache.fingerprint(self.module.resolve())
        refreshed = self.offload()
        self.assertTrue(refreshed["refreshed"])
        self.assertEqual(refreshed["bytesReclaimed"], 0)
        shutil.rmtree(cache.CACHE_ROOT)
        self.assertEqual(cache.restore_all(self.root, self.store)["restored"], 1)
        self.assertEqual(cache.fingerprint(self.module.resolve()), changed)
        self.node()

    def test_periodic_restore_does_not_hash_active_cache_or_swap_originals(self):
        with patch.object(cache, "_discard_original", return_value=False):
            self.offload()
        record = json.loads(self.manifest().read_text())
        record.update({"state": "prepared", "cleanupStarted": False})
        self.manifest().write_text(json.dumps(record))
        stage = self.workspace / (".t3-deps-original-" + self.manifest().stem[:20])
        (stage / "example/index.js").write_text("module.exports = 43;\n")
        with patch.object(cache, "fingerprint", side_effect=AssertionError("periodic hash")):
            self.assertEqual(cache.restore_all(self.root, self.store)["ready"], 1)
        self.assertTrue(self.module.is_symlink())
        self.assertTrue(stage.is_dir())
        self.node()
        # Cold recovery may safely restore the still-complete changed original
        # before any native/agent process has started using its workspace.
        cold = cache.restore_all(self.root, self.store, cold=True)
        self.assertEqual(cold["reasons"].get("retained_mutated_original"), 1)
        self.assertFalse(self.module.is_symlink())
        self.assertEqual((self.module / "example/index.js").read_text(), "module.exports = 43;\n")

    def test_cold_cleanup_never_removes_replaced_same_name_original(self):
        with patch.object(cache, "_discard_original", return_value=False):
            self.offload()
        stage = self.workspace / (".t3-deps-original-" + self.manifest().stem[:20])
        saved = self.workspace / "saved-original"
        stage.rename(saved)
        stage.mkdir()
        (stage / "user-file").write_text("keep")
        outcome = cache.restore_all(self.root, self.store, cold=True)
        self.assertEqual(outcome["reasons"].get("cleanup_pending"), 1)
        self.assertEqual((stage / "user-file").read_text(), "keep")
        self.assertTrue(saved.is_dir())
        self.node()

    def test_cold_recovery_resumes_partial_cleanup_of_exact_original_inode(self):
        with patch.object(cache, "_discard_original", return_value=False):
            self.offload()
        stage = self.workspace / (".t3-deps-original-" + self.manifest().stem[:20])
        (stage / "example/large.dat").unlink()
        self.assertEqual(cache.restore_all(self.root, self.store, cold=True)["ready"], 1)
        self.assertFalse(stage.exists())
        self.node()

    def test_backend_failure_stops_later_download_attempts(self):
        self.offload()
        first = self.manifest()
        second_workspace = self.root / "t3/scratch/other"
        shutil.copytree(self.workspace, second_workspace, symlinks=False)
        cache.offload(self.root, second_workspace, self.store, nullcontext)
        shutil.rmtree(cache.CACHE_ROOT)
        class CountingBrokenStore(BrokenStore):
            calls = 0
            def get_verified(self, *args):
                self.calls += 1
                return super().get_verified(*args)
        unavailable = CountingBrokenStore()
        result = cache.restore_all(self.root, unavailable, cold=True)
        self.assertEqual(unavailable.calls, 1)
        self.assertTrue(result["storageUnavailable"])
        self.assertEqual(result["failed"], 1)
        self.assertEqual(result["reasons"].get("archive_unavailable"), 1)

    def test_archive_rejects_parent_traversal_hardlinks_and_link_chain(self):
        for name, kind, target in [("node_modules/../../escape", tarfile.REGTYPE, ""),
                                   ("node_modules/hard", tarfile.LNKTYPE, "/etc/passwd"),
                                   ("node_modules/link", tarfile.SYMTYPE, "../../escape")]:
            with self.subTest(name=name):
                archive = self.base / "unsafe.tar.gz"
                with tarfile.open(archive, "w:gz") as out:
                    parent = tarfile.TarInfo("node_modules")
                    parent.type = tarfile.DIRTYPE
                    parent.mode = 0o755
                    out.addfile(parent)
                    member = tarfile.TarInfo(name)
                    member.type, member.linkname = kind, target
                    member.mode = 0o644
                    out.addfile(member, io.BytesIO(b""))
                with tempfile.TemporaryDirectory(dir=self.base) as dest:
                    with self.assertRaises(cache.DependencyCacheError):
                        cache._unpack(archive, Path(dest))
        self.assertFalse((self.base / "escape").exists())

    def test_archive_rejects_oversized_pax_before_reading_metadata_body(self):
        archive = self.base / "oversized-pax.tar.gz"
        with tarfile.open(archive, "w:gz") as out:
            header = tarfile.TarInfo("pax-metadata")
            header.type, header.size = tarfile.XHDTYPE, 65537
            out.addfile(header, io.BytesIO(b"x" * header.size))
        with tempfile.TemporaryDirectory(dir=self.base) as dest:
            with self.assertRaisesRegex(cache.DependencyCacheError, "metadata is oversized"):
                cache._unpack(archive, Path(dest))

    def test_safe_internal_hardlinked_files_restore_as_complete_files(self):
        os.link(self.module / "example/large.dat", self.module / "example/large2.dat")
        baseline = cache.fingerprint(self.module)
        self.offload()
        shutil.rmtree(cache.CACHE_ROOT)
        self.assertEqual(cache.restore_all(self.root, self.store)["restored"], 1)
        self.assertEqual(cache.fingerprint(self.module.resolve()), baseline)


if __name__ == "__main__":
    unittest.main()
