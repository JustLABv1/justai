"""Tests for the code-runner service (run with ``python -m unittest``).

They run without root, so per-run user separation is not exercised here; the
container checks in README.md cover it.
"""

import base64
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

# In the production container the root file system is read-only and only /work is
# writable (Docker, unlike Podman, does not add a /tmp tmpfs), so use /work there.
WORK = tempfile.mkdtemp(
    prefix="code-runner-test-", dir="/work" if os.access("/work", os.W_OK) else None
)
os.chmod(WORK, 0o755)  # per-run users must be able to reach their own directory
os.environ.update(
    CODE_RUNNER_TOKEN="test-token-0123456789",
    CODE_RUNNER_WORKDIR=WORK,
    CODE_RUNNER_ALLOW_UNPRIVILEGED="true",
    CODE_RUNNER_MAX_CONCURRENT="2",
)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import app  # noqa: E402


class RunProgramTests(unittest.TestCase):
    def test_captures_output_and_exit_code(self):
        result = app.run_program('print("hello")\nimport sys\nprint("warn", file=sys.stderr)', 10)
        self.assertEqual(result["exitCode"], 0)
        self.assertEqual(result["stdout"].strip(), "hello")
        self.assertEqual(result["stderr"].strip(), "warn")
        self.assertFalse(result["timedOut"])

    def test_traceback_shows_only_user_frames(self):
        result = app.run_program("x = 1\nraise ValueError('boom')", 10)
        self.assertEqual(result["exitCode"], 1)
        self.assertIn('File "main.py", line 2', result["stderr"])
        self.assertIn("ValueError: boom", result["stderr"])
        self.assertNotIn("bootstrap.py", result["stderr"])

    def test_syntax_error_is_reported(self):
        result = app.run_program("def broken(:\n  pass", 10)
        self.assertNotEqual(result["exitCode"], 0)
        self.assertIn("SyntaxError", result["stderr"])

    def test_sys_exit_code_is_kept(self):
        self.assertEqual(app.run_program("import sys; sys.exit(3)", 10)["exitCode"], 3)

    def test_stdin_is_forwarded(self):
        result = app.run_program("print(int(input()) + int(input()))", 10, "2\n5\n")
        self.assertEqual(result["stdout"].strip(), "7")

    def test_endless_loop_is_killed(self):
        result = app.run_program("while True:\n    pass", 1)
        self.assertTrue(result["timedOut"])
        self.assertIsNone(result["exitCode"])
        self.assertLess(result["durationMs"], 8000)

    def test_background_process_does_not_survive(self):
        code = (
            "import subprocess, sys\n"
            "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
            "print('spawned')\n"
        )
        result = app.run_program(code, 10)
        self.assertEqual(result["stdout"].strip(), "spawned")
        # The run must come back immediately instead of waiting for the child.
        self.assertLess(result["durationMs"], 8000)

    def test_output_is_truncated(self):
        result = app.run_program("print('x' * 300000)", 10)
        self.assertTrue(result["truncated"])
        self.assertLessEqual(len(result["stdout"]), app.MAX_STREAM_BYTES)

    def test_files_are_returned_with_type(self):
        code = "open('data.csv','w').write('a,b\\n1,2')\nopen('blob.bin','wb').write(b'\\x00\\x01')"
        result = app.run_program(code, 10)
        files = {item["name"]: item for item in result["files"]}
        self.assertEqual(files["data.csv"]["mime"], "text/csv")
        self.assertEqual(base64.b64decode(files["data.csv"]["data"]), b"a,b\n1,2")
        self.assertEqual(files["blob.bin"]["mime"], "application/octet-stream")
        self.assertNotIn("main.py", files)

    def test_symlinks_are_never_followed(self):
        secret = Path(WORK) / "secret.txt"
        secret.write_text("top secret")
        result = app.run_program(f"import os\nos.symlink({str(secret)!r}, 'leak.txt')", 10)
        self.assertEqual([item["name"] for item in result["files"]], [])

    def test_total_file_size_is_capped(self):
        # 3 x 4.9 MB exceeds the 12 MB total, so the third file is dropped.
        code = "for i in range(3):\n    open(f'f{i}.bin', 'wb').write(b'x' * 4_900_000)"
        result = app.run_program(code, 10)
        self.assertEqual([item["name"] for item in result["files"]], ["f0.bin", "f1.bin"])

    def test_single_file_cannot_exceed_the_size_limit(self):
        code = "try:\n    open('big.bin', 'wb').write(b'x' * 9_000_000)\nexcept OSError as error:\n    print('blocked', error.errno)"
        result = app.run_program(code, 10)
        self.assertTrue(all(item["size"] <= app.MAX_FILE_BYTES for item in result["files"]))

    def test_work_directory_is_removed_after_the_run(self):
        app.run_program("open('x.txt','w').write('x')", 10)
        self.assertEqual([entry for entry in Path(WORK).iterdir() if entry.name.startswith("run-")], [])

    def test_environment_does_not_leak_the_service_token(self):
        result = app.run_program("import os\nprint(os.environ.get('CODE_RUNNER_TOKEN'))", 10)
        self.assertEqual(result["stdout"].strip(), "None")

    @unittest.skipUnless(sys.platform == "linux", "RLIMIT_AS is only reliable on Linux")
    def test_memory_limit_is_enforced(self):
        original = app.MEMORY_BYTES
        app.MEMORY_BYTES = 256 * 1024 * 1024
        try:
            result = app.run_program("data = bytearray(1024 * 1024 * 1024)\nprint(len(data))", 10)
        finally:
            app.MEMORY_BYTES = original
        self.assertNotEqual(result["exitCode"], 0)
        self.assertIn("MemoryError", result["stderr"])


class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        app.WORK_ROOT.mkdir(parents=True, exist_ok=True)
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
        cls.server.daemon_threads = True
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def call(self, payload, token="test-token-0123456789", path="/v1/run"):
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}",
            data=json.dumps(payload).encode() if payload is not None else None,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            method="POST" if payload is not None else "GET",
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())

    def test_health_check_needs_no_token(self):
        self.assertEqual(self.call(None, token="", path="/healthz"), (200, {"status": "ok"}))

    def test_requires_the_service_token(self):
        self.assertEqual(self.call({"code": "print(1)"}, token="wrong")[0], 401)
        self.assertEqual(self.call({"code": "print(1)"}, token="")[0], 401)

    def test_runs_code(self):
        status, body = self.call({"language": "python", "code": "print(6 * 7)"})
        self.assertEqual(status, 200)
        self.assertEqual(body["stdout"].strip(), "42")

    def test_rejects_bad_requests(self):
        self.assertEqual(self.call({"code": ""})[0], 400)
        self.assertEqual(self.call({"code": 5})[0], 400)
        self.assertEqual(self.call({"language": "ruby", "code": "puts 1"})[0], 400)
        self.assertEqual(self.call({"code": "x = 1\n" * 40_000})[0], 413)

    def test_timeout_is_clamped(self):
        status, body = self.call({"code": "print(1)", "timeoutSeconds": 100000})
        self.assertEqual(status, 200)
        self.assertEqual(body["exitCode"], 0)


if __name__ == "__main__":
    unittest.main()
