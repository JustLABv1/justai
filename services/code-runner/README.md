# JustAI code runner

Small internal service that runs short Python programs for the JustAI `run_code`
chat tool. The backend sends one program per request and receives stdout,
stderr and the files the program produced (for example matplotlib figures), so
the model can read the result and continue.

Python 3.13 with `pandas`, `numpy` and `matplotlib` is bundled in the image. The
service has no network access, so nothing can be installed at run time.

## API

`POST /v1/run` with `Authorization: Bearer <CODE_RUNNER_TOKEN>`:

```json
{ "language": "python", "code": "print(1 + 1)", "stdin": "", "timeoutSeconds": 20 }
```

Response: `exitCode` (null on timeout), `timedOut`, `durationMs`, `stdout`,
`stderr`, `truncated` and `files` (`name`, `mime`, `size`, base64 `data`).
`GET /healthz` needs no token. `503` means all run slots are busy.

Limits: 100 KB of code, 20 s default and 60 s maximum run time, 100 KB per
output stream, at most 6 result files with 5 MB each and 12 MB in total.

## Isolation

Running code that a language model wrote is inherently risky, so the service is
built in layers. Run it **only** with the settings in
`deploy/compose/compose.yaml`:

| Layer | What it does |
| --- | --- |
| Separate service | No database, JWT or encryption secrets; the backend is the only client. |
| No network | Attach it to an `internal: true` network. Code cannot call out or reach other services. |
| Per-run user | Every run gets its own unprivileged uid (`CODE_RUNNER_UID_BASE` + slot), a private `0700` work directory and `umask 077`. |
| Dropped capabilities | The service starts as root but keeps only `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETUID`, `SETGID`, `KILL`. Run code has none (`CapEff = 0`, `no-new-privileges`). |
| Resource limits | CPU time, address space, file size, process count and open files are set before the program starts and cannot be raised. The container adds `mem_limit`, `pids_limit` and `cpus`. |
| Read-only root | Only the size-limited `/work` tmpfs is writable. |
| Clean-up | After each run everything of that uid is killed, `/tmp`, `/var/tmp` and `/dev/shm` are purged, and the work directory is removed. |
| Safe result collection | Files are read from the top level only, without following links, after all processes are dead. |

The container is the security boundary. Run it on a host you are comfortable
exposing to this risk, keep the image up to date, and consider an additional
sandbox runtime such as gVisor (`runtime: runsc`) for stronger kernel isolation.

Known limits: concurrent runs can list each other's names in `/tmp` and
`/dev/shm` (not read them); CPU and memory abuse is bounded, not prevented; and
a kernel or container-runtime vulnerability would defeat all of this.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `CODE_RUNNER_TOKEN` | required | Shared secret, at least 16 characters. |
| `CODE_RUNNER_MAX_CONCURRENT` | `2` | Parallel runs (one uid slot each). |
| `CODE_RUNNER_MEMORY_MB` | `2048` | Address-space limit per run. |
| `CODE_RUNNER_MAX_PROCESSES` | `64` | Process limit per run. |
| `CODE_RUNNER_PORT` | `8090` | Listen port. |
| `CODE_RUNNER_ALLOW_UNPRIVILEGED` | unset | Development only: run without root and without per-run users. |

## Tests

```sh
python -m unittest discover -s tests            # local, without user separation
podman build -t justai-code-runner:test .
podman run --rm --network none --read-only --tmpfs /work:size=512m \
  --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
  --cap-add SETUID --cap-add SETGID --cap-add KILL --security-opt no-new-privileges \
  -v "$PWD/tests:/tests:ro" --entrypoint python justai-code-runner:test \
  -m unittest discover -s /tests -v                # production settings
```
