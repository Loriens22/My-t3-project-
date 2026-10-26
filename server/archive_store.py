"""Streaming, verified, immutable archive objects; no credentials in URLs/logs."""
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import hmac
from http.client import HTTPException
import ipaddress
import os
from pathlib import Path
import re
import stat
import tempfile
import time
from urllib import error, parse, request

CHUNK = 1024 * 1024
MAX_BYTES = 512 * CHUNK


class ArchiveStoreError(RuntimeError):
    pass


def _key_parts(key):
    if (not isinstance(key, str) or not key or len(key.encode("utf-8")) > 1024
            or "\\" in key or any(ord(c) < 32 or ord(c) == 127 for c in key)):
        raise ValueError("Invalid archive object key")
    parts = key.split("/")
    if any(p in ("", ".", "..") for p in parts):
        raise ValueError("Invalid archive object key")
    return parts


@contextmanager
def _regular_file(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        raise ArchiveStoreError("Archive source is unavailable or unsafe") from None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ArchiveStoreError("Archive source is not a regular file")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            yield stream
    finally:
        os.close(fd)


def _hash_stream(stream, max_bytes=None):
    digest = hashlib.sha256()
    count = 0
    for chunk in iter(lambda: stream.read(CHUNK), b""):
        count += len(chunk)
        if max_bytes is not None and count > max_bytes:
            raise ArchiveStoreError("Archive exceeds the object size limit")
        digest.update(chunk)
    return digest.hexdigest()


def _identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns)


def _unchanged_source(source, stream, original):
    """A verified old descriptor cannot authorize removing a replaced source."""
    try:
        unchanged = (_identity(os.fstat(stream.fileno())) == original
                     and _identity(os.stat(source, follow_symlinks=False)) == original)
    except OSError:
        unchanged = False
    if not unchanged:
        raise ArchiveStoreError("Archive source changed during transfer")


class _BoundedReader:
    """Content-Length remains a hard bound if another process grows a file."""
    def __init__(self, stream, size):
        self.stream = stream
        self.remaining = size

    def read(self, size=CHUNK):
        if not self.remaining:
            return b""
        limit = min(self.remaining, CHUNK, size if size >= 0 else CHUNK)
        chunk = self.stream.read(limit)
        if not chunk:
            raise ArchiveStoreError("Archive source changed during transfer")
        self.remaining -= len(chunk)
        return chunk


def sha256_file(path):
    with _regular_file(path) as stream:
        return _hash_stream(stream)


def _copy_verified(stream, destination, expected, *, max_bytes=MAX_BYTES,
                   expected_bytes=None, deadline=None):
    """Never replace the caller's destination with unverified/partial bytes."""
    if not isinstance(expected, str) or not re.fullmatch(r"[a-fA-F0-9]{64}", expected):
        raise ValueError("Invalid archive checksum")
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if destination.is_symlink():
        raise ArchiveStoreError("Archive destination must not be a symlink")
    fd, temporary = tempfile.mkstemp(prefix="." + destination.name + ".partial-", dir=destination.parent)
    try:
        count = 0
        digest = hashlib.sha256()
        # read1 checks the total deadline even when a server trickles data.
        read = getattr(stream, "read1", stream.read)
        with os.fdopen(fd, "wb") as target:
            while True:
                if deadline is not None and time.monotonic() > deadline:
                    raise ArchiveStoreError("Archive transfer deadline exceeded")
                chunk = read(CHUNK)
                if not chunk:
                    break
                count += len(chunk)
                if count > max_bytes:
                    raise ArchiveStoreError("Archive exceeds the object size limit")
                digest.update(chunk)
                target.write(chunk)
            if expected_bytes is not None and count != expected_bytes:
                raise ArchiveStoreError("Archive transfer was incomplete")
            if not hmac.compare_digest(digest.hexdigest(), expected.lower()):
                raise ArchiveStoreError("Archive checksum verification failed")
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, destination)
        # Directory fsync is unsupported on some cache filesystems. The file
        # itself is fsynced; no verification/transfer error occurs after commit.
        try:
            directory = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        except OSError:
            pass
        return destination
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


class _VerifiedStore:
    def __init__(self, *, verify_directory="/tmp/t3-archive-verify", max_bytes=MAX_BYTES):
        self.verify_directory = Path(verify_directory)
        persistent = Path(os.environ.get("T3_PHONE_ROOT", "/data")).resolve()
        if self.verify_directory.resolve().is_relative_to(persistent):
            raise ValueError("Archive verification scratch must be outside persistent data")
        self.verify_directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.max_bytes = max_bytes

    def _verify_upload(self, key, digest, size):
        with tempfile.TemporaryDirectory(prefix="readback-", dir=self.verify_directory) as work:
            checked = self.get_verified(key, Path(work) / "object", digest)
            if checked.stat().st_size != size:
                raise ArchiveStoreError("Archive readback size did not match")
        return {"key": key, "sha256": digest, "bytes": size}


class LocalStore(_VerifiedStore):
    """Explicit filesystem test adapter; never selected by production env."""
    def __init__(self, directory, **options):
        super().__init__(**options)
        directory = Path(directory)
        if directory.is_symlink():
            raise ValueError("Archive store root must not be a symlink")
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.root = directory.resolve()

    @contextmanager
    def _parent(self, key, create=False):
        parts = _key_parts(key)
        fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            for part in parts[:-1]:
                if create:
                    try:
                        os.mkdir(part, mode=0o700, dir_fd=fd)
                    except FileExistsError:
                        pass
                next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = next_fd
            yield fd, parts[-1]
        except OSError:
            raise ArchiveStoreError("Archive object path is unavailable or unsafe") from None
        finally:
            os.close(fd)

    def put_verified(self, key, source):
        _key_parts(key)
        with _regular_file(source) as stream:
            original = _identity(os.fstat(stream.fileno()))
            size = original[3]
            if size > self.max_bytes:
                raise ArchiveStoreError("Archive exceeds the object size limit")
            digest = _hash_stream(stream, self.max_bytes)
            _unchanged_source(source, stream, original)
            stream.seek(0)
            with self._parent(key, create=True) as (directory, name):
                temporary = ".upload-" + os.urandom(12).hex()
                fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                             0o600, dir_fd=directory)
                try:
                    with os.fdopen(fd, "wb") as target:
                        body = _BoundedReader(stream, size)
                        for chunk in iter(lambda: body.read(CHUNK), b""):
                            target.write(chunk)
                        target.flush()
                        os.fsync(target.fileno())
                    try:
                        os.link(temporary, name, src_dir_fd=directory, dst_dir_fd=directory,
                                follow_symlinks=False)
                    except FileExistsError:
                        pass  # Never replace an existing immutable object.
                    os.fsync(directory)
                finally:
                    os.unlink(temporary, dir_fd=directory)
            result = self._verify_upload(key, digest, size)
            _unchanged_source(source, stream, original)
            return result

    def get_verified(self, key, destination, sha256):
        with self._parent(key) as (directory, name):
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            with os.fdopen(fd, "rb") as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode):
                    raise ArchiveStoreError("Archive object is not a regular file")
                return _copy_verified(stream, destination, sha256, max_bytes=self.max_bytes,
                                      expected_bytes=info.st_size)


class _NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class _HttpFailure(ArchiveStoreError):
    def __init__(self, status):
        super().__init__("Archive storage request failed (HTTP " + str(status) + ")")
        self.status = status


class S3Store(_VerifiedStore):
    def __init__(self, endpoint, bucket, access_key_id, secret_access_key, *, region="auto",
                 url_style="virtual-host", allow_insecure_local=False, timeout=60, **options):
        super().__init__(**options)
        try:
            if any(ord(c) <= 32 or ord(c) == 127 for c in endpoint):
                raise ValueError()
            endpoint = parse.urlsplit(endpoint)
            endpoint.port  # Reject invalid ports before constructing requests.
        except (TypeError, ValueError):
            raise ValueError("Invalid archive endpoint") from None
        local = endpoint.hostname == "localhost"
        try:
            local = local or ipaddress.ip_address(endpoint.hostname or "").is_loopback
        except ValueError:
            pass
        if (endpoint.scheme != "https" and not (allow_insecure_local and local and endpoint.scheme == "http")
                or not endpoint.hostname or endpoint.username or endpoint.password
                or endpoint.query or endpoint.fragment):
            raise ValueError("Archive endpoint must use HTTPS without URL credentials")
        if url_style not in ("path", "virtual-host"):
            raise ValueError("Invalid archive URL style")
        if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", bucket):
            raise ValueError("Invalid archive bucket name")
        if (not isinstance(access_key_id, str)
                or not re.fullmatch(r"[A-Za-z0-9_-]{1,256}", access_key_id)
                or not secret_access_key or not re.fullmatch(r"[A-Za-z0-9_-]+", region)):
            raise ValueError("Incomplete archive credentials or region")
        self.endpoint, self.bucket = endpoint, bucket
        self.access_key_id, self.secret_access_key = access_key_id, secret_access_key
        self.region, self.url_style, self.timeout = region, url_style, timeout
        self.opener = request.build_opener(_NoRedirect())

    @classmethod
    def from_env(cls):
        fields = {name: os.environ.get("T3_ARCHIVE_S3_" + name, "").strip()
                  for name in ["ENDPOINT", "BUCKET", "ACCESS_KEY_ID", "SECRET_ACCESS_KEY"]}
        if not all(fields.values()):
            return None
        return cls(fields["ENDPOINT"], fields["BUCKET"], fields["ACCESS_KEY_ID"],
                   fields["SECRET_ACCESS_KEY"], region=os.environ.get("T3_ARCHIVE_S3_REGION", "auto"),
                   url_style=os.environ.get("T3_ARCHIVE_S3_URL_STYLE", "virtual-host"))

    def _url(self, key):
        _key_parts(key)
        endpoint = self.endpoint
        host = endpoint.netloc
        prefix = endpoint.path.rstrip("/")
        if self.url_style == "virtual-host":
            host = self.bucket + "." + host
        else:
            prefix += "/" + self.bucket
        path = prefix + "/" + parse.quote(key, safe="/-_.~")
        return parse.urlunsplit((endpoint.scheme, host, path, "", ""))

    def _request(self, method, key, digest, *, body=None, size=None, immutable=False):
        url = self._url(key)
        target = parse.urlsplit(url)
        now = datetime.now(timezone.utc)
        date, timestamp = now.strftime("%Y%m%d"), now.strftime("%Y%m%dT%H%M%SZ")
        headers = {"host": target.netloc, "x-amz-content-sha256": digest, "x-amz-date": timestamp}
        if immutable:
            headers["if-none-match"] = "*"
        signed = ";".join(sorted(headers))
        canonical = "\n".join([method, target.path, "", "".join(k + ":" + headers[k].strip() + "\n"
                                                                  for k in sorted(headers)), signed, digest])
        scope = "/".join([date, self.region, "s3", "aws4_request"])
        to_sign = "\n".join(["AWS4-HMAC-SHA256", timestamp, scope, hashlib.sha256(canonical.encode()).hexdigest()])
        signing = ("AWS4" + self.secret_access_key).encode()
        for part in [date, self.region, "s3", "aws4_request"]:
            signing = hmac.new(signing, part.encode(), hashlib.sha256).digest()
        signature = hmac.new(signing, to_sign.encode(), hashlib.sha256).hexdigest()
        headers["Authorization"] = ("AWS4-HMAC-SHA256 Credential=" + self.access_key_id + "/" + scope
                                    + ", SignedHeaders=" + signed + ", Signature=" + signature)
        if size is not None:
            headers["Content-Length"] = str(size)
            headers["Content-Type"] = "application/octet-stream"
        req = request.Request(url, data=body, headers=headers, method=method)
        try:
            return self.opener.open(req, timeout=self.timeout)
        except error.HTTPError as failure:
            status = failure.code
            failure.close()
            raise _HttpFailure(status) from None
        except (error.URLError, OSError, TimeoutError, HTTPException, ValueError):
            raise ArchiveStoreError("Archive storage connection failed") from None

    def put_verified(self, key, source):
        with _regular_file(source) as stream:
            original = _identity(os.fstat(stream.fileno()))
            size = original[3]
            if size > self.max_bytes:
                raise ArchiveStoreError("Archive exceeds the object size limit")
            digest = _hash_stream(stream, self.max_bytes)
            _unchanged_source(source, stream, original)
            stream.seek(0)
            try:
                with self._request("PUT", key, digest, body=_BoundedReader(stream, size),
                                   size=size, immutable=True) as response:
                    if response.status not in (200, 201, 204):
                        raise _HttpFailure(response.status)
            except _HttpFailure as failure:
                if failure.status != 412:
                    raise
            result = self._verify_upload(key, digest, size)
            _unchanged_source(source, stream, original)
            return result

    def get_verified(self, key, destination, sha256):
        empty = hashlib.sha256(b"").hexdigest()
        try:
            with self._request("GET", key, empty) as response:
                size = response.headers.get("Content-Length")
                size = int(size) if size is not None else None
                if size is not None and (size < 0 or size > self.max_bytes):
                    raise ArchiveStoreError("Archive exceeds the object size limit")
                return _copy_verified(response, destination, sha256, max_bytes=self.max_bytes,
                                      expected_bytes=size, deadline=time.monotonic() + 300)
        except ArchiveStoreError:
            raise
        except (error.URLError, OSError, TimeoutError, ValueError, HTTPException):
            raise ArchiveStoreError("Archive download failed") from None


def make_store():
    return S3Store.from_env()
