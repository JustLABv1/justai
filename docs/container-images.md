# Container image maintenance

JustAI follows the JustScan/JustCD multi-stage pattern:

- Frontend: official Node 26.12.1 Alpine builder; only the Node binary and
  Next.js standalone output enter a clean Alpine 3.24 runtime. No npm, Yarn or
  Node headers are inherited.
- Backend: official Go 1.27.3 builder, CGO disabled, trimmed and stripped binary.
  Stable Alpine carries the required PDF/Python runtime. pypdf 6.21.2 includes
  the fixes missing from the previous 6.19.0 pin.
- Combined: the same Alpine/musl runtime for Node, Python and Poppler; no mixed
  Debian/glibc Poppler libraries. Tini manages child processes.
- Pyannote: official CPython 3.14.9 Debian builder for manylinux CPU wheels.
  `prepare_runtime.py` copies CPython and its resolved shared libraries,
  certificates, timezone data and selected OS package provenance into scratch.
  It includes the glibc compatibility sonames required by manylinux wheels.
  No shell, OS package manager, pip, setuptools, bootstrap wheels, Python headers
  or static archives are shipped. filelock 4.2.1 fixes CVE-2026-112940.
- FFmpeg: unchanged source-verified static 9.0.1/OpenSSL 3.5.9 artifact; CI passes
  its digest-pinned image through the named `ffmpeg-builder` build context.
- Expat: backend and combined images build the checksum-verified 2.9.0 security
  backport as a signed APK, following JustCD. All runtime repositories stay on
  stable Alpine. See `services/backend/packaging/expat/README.md`.

All images run as non-root. Keep APK/selected dpkg records and Python wheel
metadata so scanners can identify the actual runtime components. Package removal
must remove the actual files; metadata must not be removed to hide findings.

## Local verification (2026-10-26)

Built with Podman on Linux arm64. The unchanged static FFmpeg 9.0.1 artifact was
reused from a local image after checking its version. Full source FFmpeg builds
and amd64 runtime execution were not repeated for this migration.

Trivy 0.76.1 with the current database scanned the exported final images,
including OS packages, Go modules, Python packages and Next.js dependencies:

- Frontend (~220 MB uncompressed): no findings.
- Backend (~209 MB): one UNKNOWN advisory, GO-2026-5932, for the deprecated
  `golang.org/x/crypto/openpgp` package. No High/Critical/Medium/Low findings.
- Combined (~476 MB): the same UNKNOWN Go advisory; no other findings.
- Pyannote (~1.53 GB, including CPU PyTorch): 24 Medium and 11 Low findings,
  no High/Critical. The OS findings have no fixed Debian package version in this
  scan. One Low PyTorch finding, CVE-2025-3000, lists 2.13.0 as fixed; this
  migration retains the existing matched torch/torchaudio 2.11.0 pair.

The Pyannote filesystem contains 16 OS package records rather than the 88 in the
initial Python slim runtime. Scans successfully detect Debian and those packages.
No vulnerability ignore list or `--ignore-unfixed` was used.

Validation passed: seven document-template tests, twelve Pyannote audio/lifecycle
tests, Next.js HTTP startup, native Sharp processing, Node/OpenSSL checks,
Poppler/FFmpeg execution, Python imports, TLS trust roots, timezone/UUID support,
and absence of shell/package managers in Pyannote. Tests do not download models
or perform real speaker inference. Pyannote's existing optional torchcodec warning
remains; the service uses its own bounded FFmpeg decoding path.

PR image checks now scan all four application images and reject High/Critical
findings, including unfixed ones. CVE results are time- and architecture-dependent;
repeat scans on release images and both deployment architectures.

## Repeat locally with Docker

```sh
docker build -t justai-frontend:check services/frontend
docker build -t justai-backend:check services/backend
docker build -t justai-combined:check .
docker build -t justai-pyannote:check services/pyannote-diarizer
trivy image --scanners vuln justai-frontend:check
trivy image --scanners vuln justai-backend:check
trivy image --scanners vuln justai-combined:check
trivy image --scanners vuln justai-pyannote:check
```
