"""Internal sandbox service that runs short Python programs for JustAI chats.

The JustAI backend sends one program per request and gets stdout, stderr and the
files the program produced (for example matplotlib figures) back. The service is
not meant to be reachable from outside the deployment: put it on an internal
network and give it no outbound access.

Isolation model (defence in depth, see README.md):

* every run gets its own unprivileged uid, a private 0700 work directory on a
  size-limited tmpfs, a clean environment and hard resource limits;
* the service itself runs as root with almost all capabilities dropped, so it
  can switch users, clean up and kill leftovers, but the user code cannot read
  the service's memory, environment or other runs' files;
* after every run all processes of that uid are killed, and result files are
  only read from the top level of the work directory without following links.
"""

from __future__ import annotations

import base64
import hmac
import json
import logging
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

LOGGER = logging.getLogger("code-runner")

HERE = Path(__file__).resolve().parent
BOOTSTRAP = HERE / "bootstrap.py"
MPL_CACHE = HERE / "mpl"


def env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


TOKEN = os.environ.get("CODE_RUNNER_TOKEN", "")
WORK_ROOT = Path(os.environ.get("CODE_RUNNER_WORKDIR", "/work"))
MAX_CONCURRENT = max(1, env_int("CODE_RUNNER_MAX_CONCURRENT", 2))
UID_BASE = env_int("CODE_RUNNER_UID_BASE", 20000)
MEMORY_BYTES = env_int("CODE_RUNNER_MEMORY_MB", 2048) * 1024 * 1024
MAX_PROCESSES = env_int("CODE_RUNNER_MAX_PROCESSES", 64)
DEFAULT_TIMEOUT = 20
MAX_TIMEOUT = 60
MAX_BODY_BYTES = 256 * 1024
MAX_CODE_BYTES = 100_000
MAX_STDIN_BYTES = 10_000
MAX_STREAM_BYTES = 100_000
MAX_FILES = 6
MAX_FILE_BYTES = 5_000_000
MAX_TOTAL_FILE_BYTES = 12_000_000
# Only these types are reported as such; anything else is a plain download.
MIME_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".csv": "text/csv",
    ".tsv": "text/tab-separated-values",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
}

slots = [threading.Lock() for _ in range(MAX_CONCURRENT)]
privileged = os.geteuid() == 0 if hasattr(os, "geteuid") else False


class Busy(Exception):
    """All run slots are in use."""


def acquire_slot() -> int:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        for index, lock in enumerate(slots):
            if lock.acquire(blocking=False):
                return index
        time.sleep(0.05)
    raise Busy


def kill_user_processes(uid: int) -> None:
    """SIGKILL everything that still runs under the run's uid."""
    if not privileged:
        return
    for _ in range(3):  # a process may fork while we sweep
        found = False
        for entry in os.scandir("/proc"):
            if not entry.name.isdigit():
                continue
            try:
                if entry.stat().st_uid == uid:
                    os.kill(int(entry.name), signal.SIGKILL)
                    found = True
            except (FileNotFoundError, ProcessLookupError, PermissionError):
                continue
        if not found:
            return
        time.sleep(0.02)


SHARED_DIRECTORIES = ("/tmp", "/var/tmp", "/dev/shm")


def purge_shared_directories(uid: int) -> None:
    """Remove what a run left in directories that all runs can write to."""
    if not privileged:
        return
    for directory in SHARED_DIRECTORIES:
        try:
            entries = list(os.scandir(directory))
        except OSError:
            continue
        for entry in entries:
            try:
                if entry.stat(follow_symlinks=False).st_uid != uid:
                    continue
                if entry.is_dir(follow_symlinks=False):
                    shutil.rmtree(entry.path, ignore_errors=True)
                else:
                    os.unlink(entry.path)
            except OSError:
                continue


def read_limited(stream, sink: dict) -> None:
    """Keep the first MAX_STREAM_BYTES, keep draining so the child never blocks."""
    chunks: list[bytes] = []
    kept = 0
    while True:
        chunk = stream.read(8192)
        if not chunk:
            break
        if kept < MAX_STREAM_BYTES:
            piece = chunk[: MAX_STREAM_BYTES - kept]
            chunks.append(piece)
            kept += len(piece)
            if len(piece) < len(chunk):
                sink["truncated"] = True
        else:
            sink["truncated"] = True
    sink["data"] = b"".join(chunks)


def collect_files(workdir: Path, main_name: str) -> list[dict]:
    """Read result files from the top level only, never following links."""
    files: list[dict] = []
    total = 0
    for entry in sorted(os.scandir(workdir), key=lambda item: item.name):
        if len(files) >= MAX_FILES:
            break
        if entry.name == main_name or entry.name.startswith("."):
            continue
        if not entry.is_file(follow_symlinks=False):
            continue
        try:
            descriptor = os.open(entry.path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except OSError:
            continue
        with os.fdopen(descriptor, "rb") as handle:
            size = os.fstat(handle.fileno()).st_size
            if size > MAX_FILE_BYTES or total + size > MAX_TOTAL_FILE_BYTES:
                continue
            data = handle.read(MAX_FILE_BYTES + 1)
        if len(data) > MAX_FILE_BYTES:
            continue
        total += len(data)
        suffix = Path(entry.name).suffix.lower()
        files.append(
            {
                "name": entry.name,
                "mime": MIME_TYPES.get(suffix, "application/octet-stream"),
                "size": len(data),
                "data": base64.b64encode(data).decode("ascii"),
            }
        )
    return files


def run_program(code: str, timeout: int, stdin_text: str = "") -> dict:
    slot = acquire_slot()
    uid = UID_BASE + slot
    started = time.monotonic()
    workdir: Path | None = None
    process = None
    timed_out = False
    try:
        workdir = Path(tempfile.mkdtemp(prefix="run-", dir=WORK_ROOT))
        os.chmod(workdir, 0o700)
        main_name = "main.py"
        (workdir / main_name).write_text(code, encoding="utf-8")
        if MPL_CACHE.is_dir():
            shutil.copytree(MPL_CACHE, workdir / ".mpl")
            # The cache is read-only in the image; the run needs to write to it.
            for path in [workdir / ".mpl", *(workdir / ".mpl").rglob("*")]:
                os.chmod(path, 0o700 if path.is_dir() else 0o600)
        if privileged:
            for path in [workdir, *workdir.rglob("*")]:
                os.chown(path, uid, uid, follow_symlinks=False)

        env = {
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "HOME": str(workdir),
            "LANG": "C.UTF-8",
            "TMPDIR": str(workdir),
            "MPLBACKEND": "Agg",
            "MPLCONFIGDIR": str(workdir / ".mpl"),
            "OPENBLAS_NUM_THREADS": "1",
            "OMP_NUM_THREADS": "1",
            "MKL_NUM_THREADS": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONIOENCODING": "utf-8",
            "RUNNER_CPU_SECONDS": str(timeout + 2),
            "RUNNER_MEMORY_BYTES": str(MEMORY_BYTES),
            "RUNNER_FILE_BYTES": str(MAX_FILE_BYTES),
            "RUNNER_MAX_PROCESSES": str(MAX_PROCESSES),
            # Running as root means production: missing limits are an error.
            "RUNNER_STRICT_LIMITS": "1" if privileged else "0",
        }
        identity = {"user": uid, "group": uid, "extra_groups": []} if privileged else {}
        process = subprocess.Popen(  # noqa: S603 - fixed argv, no shell
            [sys.executable, "-I", str(BOOTSTRAP), main_name],
            cwd=workdir,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            process_group=0,
            close_fds=True,
            **identity,
        )
        out: dict = {}
        err: dict = {}
        readers = [
            threading.Thread(target=read_limited, args=(process.stdout, out), daemon=True),
            threading.Thread(target=read_limited, args=(process.stderr, err), daemon=True),
        ]
        for reader in readers:
            reader.start()
        try:
            process.stdin.write(stdin_text.encode("utf-8")[:MAX_STDIN_BYTES])
            process.stdin.close()
        except (BrokenPipeError, OSError):
            pass
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
        # Stop everything before reading results so nothing can race the reader.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        kill_user_processes(uid)
        process.wait()
        for reader in readers:
            reader.join(timeout=2)
        return {
            "exitCode": None if timed_out else process.returncode,
            "timedOut": timed_out,
            "durationMs": int((time.monotonic() - started) * 1000),
            "stdout": out.get("data", b"").decode("utf-8", "replace"),
            "stderr": err.get("data", b"").decode("utf-8", "replace"),
            "truncated": bool(out.get("truncated") or err.get("truncated")),
            "files": collect_files(workdir, main_name),
        }
    finally:
        if process is not None:
            if process.poll() is None:
                process.kill()
            for pipe in (process.stdin, process.stdout, process.stderr):
                if pipe is not None:
                    pipe.close()
        kill_user_processes(uid)
        purge_shared_directories(uid)
        if workdir is not None:
            shutil.rmtree(workdir, ignore_errors=True)
        slots[slot].release()


class Handler(BaseHTTPRequestHandler):
    server_version = "code-runner"
    timeout = 30  # slow clients cannot hold a thread forever

    def log_message(self, fmt: str, *args) -> None:  # noqa: A002
        LOGGER.info("%s %s", self.address_string(), fmt % args)

    def respond(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def authorized(self) -> bool:
        header = self.headers.get("Authorization", "")
        supplied = header[7:] if header.startswith("Bearer ") else ""
        return hmac.compare_digest(supplied.encode(), TOKEN.encode())

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/healthz":
            self.respond(200, {"status": "ok"})
        else:
            self.respond(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/v1/run":
            return self.respond(404, {"error": "not found"})
        if not self.authorized():
            return self.respond(401, {"error": "unauthorized"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self.respond(400, {"error": "invalid content length"})
        if length <= 0 or length > MAX_BODY_BYTES:
            return self.respond(413, {"error": "request body too large"})
        try:
            request = json.loads(self.rfile.read(length))
        except ValueError:
            return self.respond(400, {"error": "invalid JSON"})
        if not isinstance(request, dict):
            return self.respond(400, {"error": "invalid request"})

        code = request.get("code")
        if request.get("language", "python") != "python":
            return self.respond(400, {"error": "only python is supported"})
        if not isinstance(code, str) or not code.strip():
            return self.respond(400, {"error": "code is required"})
        if len(code.encode("utf-8")) > MAX_CODE_BYTES:
            return self.respond(413, {"error": "code is too large"})
        stdin_text = request.get("stdin", "")
        if not isinstance(stdin_text, str):
            return self.respond(400, {"error": "stdin must be a string"})
        timeout = request.get("timeoutSeconds", DEFAULT_TIMEOUT)
        if not isinstance(timeout, int) or isinstance(timeout, bool):
            timeout = DEFAULT_TIMEOUT
        timeout = max(1, min(timeout, MAX_TIMEOUT))

        try:
            result = run_program(code, timeout, stdin_text)
        except Busy:
            return self.respond(503, {"error": "all run slots are busy"})
        except Exception:  # noqa: BLE001
            LOGGER.exception("run failed")
            return self.respond(500, {"error": "the run could not be executed"})
        self.respond(200, result)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if len(TOKEN) < 16:
        sys.exit("CODE_RUNNER_TOKEN must be set to at least 16 characters")
    if not privileged and os.environ.get("CODE_RUNNER_ALLOW_UNPRIVILEGED") != "true":
        sys.exit(
            "refusing to start without root: per-run user separation needs it. "
            "Set CODE_RUNNER_ALLOW_UNPRIVILEGED=true only for local development."
        )
    WORK_ROOT.mkdir(parents=True, exist_ok=True)
    os.chmod(WORK_ROOT, 0o755)
    host = os.environ.get("CODE_RUNNER_HOST", "0.0.0.0")  # noqa: S104 - internal network
    port = env_int("CODE_RUNNER_PORT", 8090)
    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    LOGGER.info("code-runner listening on %s:%s (privileged=%s)", host, port, privileged)
    server.serve_forever()


if __name__ == "__main__":
    main()
