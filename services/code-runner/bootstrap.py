"""Entry point for one sandboxed run; executed as an unprivileged user.

The service starts this file with ``python -I bootstrap.py main.py``. It applies
hard resource limits first, then runs the user's program with a clean
traceback and saves open matplotlib figures as PNG files so they come back as
results.
"""

import os
import resource
import sys
import traceback


def limit(kind: int, value: int) -> None:
    # Soft and hard limit are lowered together; an unprivileged process can
    # never raise a hard limit again.
    try:
        resource.setrlimit(kind, (value, value))
    except (ValueError, OSError):
        # Production (strict) must never run without its limits. Local
        # development on systems that lack some limits (macOS) may continue.
        if os.environ.get("RUNNER_STRICT_LIMITS") == "1":
            raise


def apply_limits() -> None:
    limit(resource.RLIMIT_CPU, int(os.environ["RUNNER_CPU_SECONDS"]))
    limit(resource.RLIMIT_AS, int(os.environ["RUNNER_MEMORY_BYTES"]))
    limit(resource.RLIMIT_FSIZE, int(os.environ["RUNNER_FILE_BYTES"]))
    # NPROC counts every process of the uid. That is only meaningful when each
    # run has its own uid (strict/production mode), not for a developer's login.
    if os.environ.get("RUNNER_STRICT_LIMITS") == "1":
        limit(resource.RLIMIT_NPROC, int(os.environ["RUNNER_MAX_PROCESSES"]))
    limit(resource.RLIMIT_NOFILE, 256)
    limit(resource.RLIMIT_CORE, 0)


def save_figures() -> None:
    pyplot = sys.modules.get("matplotlib.pyplot")
    if pyplot is None:
        return
    # A program that saved its own image does not need an extra copy.
    if any(name.lower().endswith((".png", ".jpg", ".jpeg", ".svg")) for name in os.listdir(".")):
        return
    try:
        for number in pyplot.get_fignums()[:6]:
            pyplot.figure(number).savefig(
                f"figure-{number}.png", dpi=100, bbox_inches="tight"
            )
    except Exception:  # noqa: BLE001 - a broken plot must not hide the output
        traceback.print_exc()


def main() -> int:
    script = sys.argv[1]
    # Files and shared directories (/dev/shm) stay private to this run's user.
    os.umask(0o077)
    apply_limits()
    with open(script, encoding="utf-8") as handle:
        source = handle.read()
    code = compile(source, script, "exec")
    scope = {"__name__": "__main__", "__file__": script}
    sys.argv = [script]
    status = 0
    try:
        exec(code, scope)  # noqa: S102 - running user code is the purpose
    except SystemExit as exit_request:
        status = exit_request.code if isinstance(exit_request.code, int) else 1
        if exit_request.code is not None and not isinstance(exit_request.code, int):
            print(exit_request.code, file=sys.stderr)
    except BaseException:  # noqa: BLE001
        kind, value, tb = sys.exc_info()
        # Drop this file's own frame so only the user's lines are shown.
        traceback.print_exception(kind, value, tb.tb_next if tb else None)
        status = 1
    finally:
        save_figures()
        sys.stdout.flush()
        sys.stderr.flush()
    return status


if __name__ == "__main__":
    # os._exit skips interpreter teardown, which can hang on leftover threads.
    code = main()
    os._exit(code)
