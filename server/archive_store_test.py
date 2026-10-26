"""Archive boundary checks, including independently authenticated HTTP traffic."""
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import re
import tempfile
import threading
import unittest
from unittest import mock
from urllib.parse import urlsplit

import archive_store
from archive_store import ArchiveStoreError, LocalStore, S3Store, make_store, sha256_file


ACCESS = "test-access-id"
SECRET = "test-secret-only-for-fixtures"


class FakeS3:
    """Reject invalid SigV4 instead of merely accepting the client's headers."""
    def __init__(self):
        self.objects = {}
        self.calls = []
        self.failures = []
        self.corrupt = False
        self.truncated = False
        self.redirect = False
        self.unavailable = False
        self.after_put = None
        self.after_get = None
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def _respond(self, status, body=b"", headers=None):
                self.send_response(status)
                self.send_header("Content-Length", str(len(body)))
                for key, value in (headers or {}).items():
                    self.send_header(key, value)
                self.end_headers()
                if body:
                    self.wfile.write(body)

            def _authenticated(self, body):
                auth = self.headers.get("Authorization", "")
                found = re.fullmatch(
                    r"AWS4-HMAC-SHA256 Credential=([^/]+)/([^,]+), SignedHeaders=([^,]+), Signature=([0-9a-f]{64})", auth)
                if not found:
                    return False
                access, scope, names, supplied = found.groups()
                parts = scope.split("/")
                if access != ACCESS or len(parts) != 4 or parts[1:] != ["auto", "s3", "aws4_request"]:
                    return False
                signed_headers = names.split(";")
                required = {"host", "x-amz-content-sha256", "x-amz-date"}
                if self.command == "PUT":
                    required.add("if-none-match")
                    if self.headers.get("If-None-Match") != "*":
                        return False
                if set(signed_headers) != required or signed_headers != sorted(signed_headers):
                    return False
                payload_hash = self.headers.get("X-Amz-Content-Sha256")
                if payload_hash != hashlib.sha256(body).hexdigest():
                    return False
                amz_date = self.headers.get("X-Amz-Date", "")
                if not re.fullmatch(r"\d{8}T\d{6}Z", amz_date) or parts[0] != amz_date[:8]:
                    return False
                target = urlsplit(self.path)
                if target.query:
                    return False
                header_lines = "".join(name + ":" + " ".join(self.headers[name].split()) + "\n"
                                       for name in signed_headers)
                canonical = (self.command + "\n" + target.path + "\n\n" + header_lines
                             + "\n" + names + "\n" + payload_hash)
                signing = ("AWS4" + SECRET).encode()
                for piece in parts:
                    signing = hmac.digest(signing, piece.encode(), "sha256")
                expected = hmac.new(signing, ("AWS4-HMAC-SHA256\n" + amz_date + "\n" + scope
                                             + "\n" + hashlib.sha256(canonical.encode()).hexdigest()).encode(),
                                    hashlib.sha256).hexdigest()
                return hmac.compare_digest(expected, supplied)

            def _handle(self):
                length = int(self.headers.get("Content-Length", "0"))
                body = self.rfile.read(length)
                outer.calls.append((self.command, self.path, dict(self.headers), body))
                if self.path == "/redirect-target":
                    outer.failures.append("Credentials reached a redirected endpoint")
                    return self._respond(200, b"redirected")
                if not self._authenticated(body):
                    outer.failures.append("Signature rejected")
                    return self._respond(403, b"fake authentication rejected")
                if outer.unavailable:
                    return self._respond(503, b"private diagnostic should never enter exception")
                if outer.redirect:
                    return self._respond(307, headers={"Location": "/redirect-target"})
                if self.command == "PUT":
                    if self.path in outer.objects:
                        return self._respond(412)
                    outer.objects[self.path] = body
                    if outer.after_put:
                        outer.after_put()
                    return self._respond(200)
                if self.path not in outer.objects:
                    return self._respond(404)
                data = outer.objects[self.path]
                if outer.corrupt:
                    data = b"X" + data[1:] if data else b"X"
                if outer.after_get:
                    outer.after_get()
                if outer.truncated:
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(data) + 7))
                    self.send_header("Connection", "close")
                    self.end_headers()
                    self.wfile.write(data)
                    self.close_connection = True
                    return
                self._respond(200, data)

            do_GET = _handle
            do_PUT = _handle

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *args):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    @property
    def endpoint(self):
        return "http://127.0.0.1:" + str(self.server.server_port) + "/s3"

    def store(self, scratch, **options):
        return S3Store(self.endpoint, "private-archive", ACCESS, SECRET, url_style="path",
                       allow_insecure_local=True, verify_directory=scratch, timeout=3, **options)


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="t3-store-test-")
        self.root = Path(self.temporary.name)
        self.source = self.root / "source.gz"
        self.data = b"archive-fixture\x00" * 140000
        self.source.write_bytes(self.data)
        self.scratch = self.root / "scratch"
        self.digest = hashlib.sha256(self.data).hexdigest()

    def tearDown(self):
        self.temporary.cleanup()

    def local(self, **options):
        return LocalStore(self.root / "objects", verify_directory=self.scratch, **options)

    def test_local_round_trip_and_idempotent_immutable_publish(self):
        store = self.local()
        result = store.put_verified("threads/immutable.gz", self.source)
        self.assertEqual(result, {"key": "threads/immutable.gz", "sha256": self.digest, "bytes": len(self.data)})
        self.assertEqual(store.put_verified(result["key"], self.source), result)
        target = self.root / "restored"
        self.assertEqual(store.get_verified(result["key"], target, self.digest), target)
        self.assertEqual(target.read_bytes(), self.data)
        self.assertFalse(any(self.scratch.iterdir()))

    def test_local_collision_never_overwrites_earlier_archive(self):
        store = self.local()
        store.put_verified("immutable", self.source)
        self.source.write_bytes(b"different data")
        with self.assertRaises(ArchiveStoreError):
            store.put_verified("immutable", self.source)
        self.assertEqual((store.root / "immutable").read_bytes(), self.data)

    def test_local_bad_download_retains_destination_and_cleans_partials(self):
        store = self.local()
        store.put_verified("immutable", self.source)
        target = self.root / "restored"
        target.write_bytes(b"keep original")
        with self.assertRaises(ArchiveStoreError):
            store.get_verified("immutable", target, "0" * 64)
        self.assertEqual(target.read_bytes(), b"keep original")
        self.assertEqual(list(self.root.glob(".restored.partial-*")), [])

    def test_local_rejects_key_traversal_and_symlink_escape(self):
        store = self.local()
        for key in ["", "../secret", "threads/../../secret", "/absolute", "a//b", "a/./b", "a\\b", "a\nb"]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                store.put_verified(key, self.source)
        outside = self.root / "outside"
        outside.mkdir()
        (store.root / "escape").symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ArchiveStoreError):
            store.put_verified("escape/object", self.source)
        self.assertEqual(list(outside.iterdir()), [])
        (store.root / "object").symlink_to(self.source)
        with self.assertRaises(ArchiveStoreError):
            store.get_verified("object", self.root / "dest", self.digest)

    def test_regular_source_and_destination_symlinks_rejected(self):
        store = self.local()
        source_link = self.root / "source-link"
        source_link.symlink_to(self.source)
        with self.assertRaises(ArchiveStoreError):
            store.put_verified("source-link", source_link)
        with self.assertRaises(ArchiveStoreError):
            store.put_verified("directory", self.root)
        store.put_verified("immutable", self.source)
        dest_link = self.root / "dest-link"
        dest_link.symlink_to(self.source)
        with self.assertRaises(ArchiveStoreError):
            store.get_verified("immutable", dest_link, self.digest)
        self.assertTrue(dest_link.is_symlink())
        self.assertEqual(self.source.read_bytes(), self.data)

    def test_local_changed_source_during_readback_is_rejected(self):
        store = self.local()
        get = store.get_verified

        def mutate(*args):
            result = get(*args)
            self.source.write_bytes(b"new version")
            return result

        with mock.patch.object(store, "get_verified", side_effect=mutate):
            with self.assertRaisesRegex(ArchiveStoreError, "source changed"):
                store.put_verified("immutable", self.source)
        self.assertEqual(self.source.read_bytes(), b"new version")

    def test_local_replaced_source_during_readback_is_rejected(self):
        store = self.local()
        get = store.get_verified

        def replace_source(*args):
            result = get(*args)
            candidate = self.root / "new"
            candidate.write_bytes(self.data)
            os.replace(candidate, self.source)
            return result

        with mock.patch.object(store, "get_verified", side_effect=replace_source):
            with self.assertRaisesRegex(ArchiveStoreError, "source changed"):
                store.put_verified("immutable", self.source)

    def test_mutation_during_hash_never_publishes_an_archive(self):
        store = self.local()
        original_hash = archive_store._hash_stream

        def mutate(stream, *args):
            digest = original_hash(stream, *args)
            self.source.write_bytes(b"changed while preparing")
            return digest

        with mock.patch.object(archive_store, "_hash_stream", side_effect=mutate):
            with self.assertRaisesRegex(ArchiveStoreError, "source changed"):
                store.put_verified("immutable", self.source)
        self.assertEqual(list(store.root.iterdir()), [])

    def test_s3_growing_source_cannot_exceed_declared_upload_size(self):
        store = S3Store("https://storage.example.com", "private-archive", ACCESS, SECRET,
                        verify_directory=self.scratch)

        class Response:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *args):
                pass

        def send(method, key, digest, *, body, size, immutable):
            with self.source.open("ab") as stream:
                stream.write(b"newly appended bytes")
            sent = b"".join(iter(lambda: body.read(65536), b""))
            self.assertEqual(sent, self.data)
            self.assertEqual(len(sent), size)
            return Response()

        with mock.patch.object(store, "_request", side_effect=send), \
                mock.patch.object(store, "_verify_upload", return_value={}):
            with self.assertRaisesRegex(ArchiveStoreError, "source changed"):
                store.put_verified("immutable", self.source)

    def test_verification_scratch_cannot_consume_persistent_volume(self):
        persistent = self.root / "persistent"
        with mock.patch.dict(os.environ, {"T3_PHONE_ROOT": str(persistent)}):
            with self.assertRaisesRegex(ValueError, "outside persistent"):
                LocalStore(self.root / "objects", verify_directory=persistent / "verification")

    def test_size_limits_apply_to_upload_and_download(self):
        store = self.local(max_bytes=len(self.data) - 1)
        with self.assertRaisesRegex(ArchiveStoreError, "size limit"):
            store.put_verified("too-big", self.source)
        normal = self.local()
        normal.put_verified("immutable", self.source)
        target = self.root / "dest"
        target.write_bytes(b"old")
        with self.assertRaisesRegex(ArchiveStoreError, "size limit"):
            store.get_verified("immutable", target, self.digest)
        self.assertEqual(target.read_bytes(), b"old")

    def test_empty_object_is_verified(self):
        self.source.write_bytes(b"")
        store = self.local()
        result = store.put_verified("empty", self.source)
        self.assertEqual(result["sha256"], hashlib.sha256(b"").hexdigest())
        self.assertEqual(result["bytes"], 0)

    def test_s3_sigv4_encoded_key_upload_and_independent_readback(self):
        with FakeS3() as server:
            store = server.store(self.scratch)
            key = "threads/разговор with + and %/snapshot.gz"
            result = store.put_verified(key, self.source)
            self.assertEqual(result["sha256"], self.digest)
            self.assertEqual([call[0] for call in server.calls], ["PUT", "GET"])
            path = server.calls[0][1]
            self.assertTrue(path.startswith("/s3/private-archive/threads/%D1%80"))
            self.assertIn("%20with%20%2B%20and%20%25/", path)
            self.assertEqual(server.calls[1][1], path)
            self.assertEqual(server.failures, [])
            self.assertFalse(any(self.scratch.iterdir()))
            target = self.root / "restored"
            store.get_verified(key, target, self.digest)
            self.assertEqual(target.read_bytes(), self.data)

    def test_s3_collision_keeps_existing_object_and_validates_it(self):
        with FakeS3() as server:
            store = server.store(self.scratch)
            first = store.put_verified("immutable", self.source)
            self.assertEqual(store.put_verified("immutable", self.source), first)
            self.source.write_bytes(b"collision")
            with self.assertRaisesRegex(ArchiveStoreError, "checksum"):
                store.put_verified("immutable", self.source)
            self.assertEqual(next(iter(server.objects.values())), self.data)
            self.assertEqual(server.failures, [])

    def test_s3_corruption_before_upload_readback_never_reports_success(self):
        with FakeS3() as server:
            server.corrupt = True
            with self.assertRaisesRegex(ArchiveStoreError, "checksum"):
                server.store(self.scratch).put_verified("immutable", self.source)
            self.assertEqual(self.source.read_bytes(), self.data)
            self.assertFalse(any(self.scratch.iterdir()))

    def test_s3_changed_source_after_upload_rejected_even_if_remote_is_valid(self):
        with FakeS3() as server:
            server.after_put = lambda: self.source.write_bytes(b"changed source")
            with self.assertRaisesRegex(ArchiveStoreError, "source changed"):
                server.store(self.scratch).put_verified("immutable", self.source)
            self.assertEqual(next(iter(server.objects.values())), self.data)
            self.assertEqual(self.source.read_bytes(), b"changed source")

    def test_s3_bad_or_short_read_preserves_existing_destination(self):
        with FakeS3() as server:
            store = server.store(self.scratch)
            store.put_verified("immutable", self.source)
            target = self.root / "dest"
            for mode in ["corrupt", "truncated"]:
                with self.subTest(mode=mode):
                    target.write_bytes(b"old bytes")
                    setattr(server, mode, True)
                    with self.assertRaises(ArchiveStoreError):
                        store.get_verified("immutable", target, self.digest)
                    setattr(server, mode, False)
                    self.assertEqual(target.read_bytes(), b"old bytes")
                    self.assertEqual(list(self.root.glob(".dest.partial-*")), [])

    def test_s3_redirect_is_rejected_without_forwarding_authorization(self):
        with FakeS3() as server:
            server.redirect = True
            with self.assertRaisesRegex(ArchiveStoreError, "HTTP 307"):
                server.store(self.scratch).put_verified("immutable", self.source)
            self.assertEqual(len(server.calls), 1)
            self.assertEqual(server.failures, [])

    def test_s3_errors_are_sanitized_and_preserve_original(self):
        with FakeS3() as server:
            server.unavailable = True
            try:
                server.store(self.scratch).put_verified("immutable", self.source)
            except ArchiveStoreError as failure:
                text = str(failure)
                self.assertEqual(text, "Archive storage request failed (HTTP 503)")
                for sensitive in [ACCESS, SECRET, "private diagnostic", server.endpoint]:
                    self.assertNotIn(sensitive, text)
            else:
                self.fail("An unavailable backend reported success")
            self.assertEqual(self.source.read_bytes(), self.data)

    def test_endpoint_security_and_virtual_host_shape(self):
        for endpoint in ["http://example.com", "http://127.0.0.1", "https://user:password@example.com", "https://example.com?a=b", "https://example.com/#fragment", "https://example.com:bad", "https://example.com/white space"]:
            with self.subTest(endpoint=endpoint), self.assertRaises(ValueError):
                S3Store(endpoint, "private-archive", ACCESS, SECRET, verify_directory=self.scratch)
        store = S3Store("https://storage.example.com", "private-archive", ACCESS, SECRET,
                        verify_directory=self.scratch)
        self.assertEqual(store._url("thread/hash.gz"), "https://private-archive.storage.example.com/thread/hash.gz")
        with self.assertRaises(ValueError):
            store._url("../escape")

    def test_env_factory_disabled_without_all_fields_and_uses_defaults(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(make_store())
        config = {"T3_ARCHIVE_S3_ENDPOINT": "https://storage.example.com",
                  "T3_ARCHIVE_S3_BUCKET": "private-archive",
                  "T3_ARCHIVE_S3_ACCESS_KEY_ID": ACCESS,
                  "T3_ARCHIVE_S3_SECRET_ACCESS_KEY": SECRET}
        with mock.patch.dict(os.environ, config, clear=True):
            store = make_store()
            self.assertIsInstance(store, S3Store)
            self.assertEqual(store.region, "auto")
            self.assertEqual(store.url_style, "virtual-host")
        self.assertEqual(sha256_file(self.source), self.digest)


if __name__ == "__main__":
    unittest.main()
