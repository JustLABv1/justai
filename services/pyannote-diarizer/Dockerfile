ARG SETUPTOOLS_VERSION=80.10.2

# Local builds compile the verified artifact here. CI overrides this named stage
# with the digest-pinned image produced by docker/ffmpeg/Dockerfile.
FROM alpine:3.24 AS ffmpeg-builder

ARG FFMPEG_VERSION=9.0.1
ARG OPENSSL_VERSION=3.5.7
ARG OPENSSL_SHA256=a8c0d28a529ca480f9f36cf5792e2cd21984552a3c8e4aa11a24aa31aeac98e8

# Build a self-contained FFmpeg binary rather than copying Alpine's packaged
# FFmpeg 8.1.2. The 9.0 release line contains the fixes for CVE-2026-64830 and
# CVE-2026-64831. Verify the upstream release signature before compiling it.
RUN apk add --no-cache \
      build-base \
      curl \
      gnupg \
      linux-headers \
      nasm \
      perl \
      xz \
      zlib-dev \
    && mkdir -p /tmp/ffmpeg-source /tmp/gnupg /opt/ffmpeg/bin \
    && chmod 700 /tmp/gnupg \
    && curl --fail --location --silent --show-error \
      --output /tmp/ffmpeg-source/ffmpeg.tar.xz \
      "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" \
    && curl --fail --location --silent --show-error \
      --output /tmp/ffmpeg-source/ffmpeg.tar.xz.asc \
      "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz.asc" \
    && curl --fail --location --silent --show-error \
      --output /tmp/ffmpeg-source/ffmpeg-devel.asc \
      "https://ffmpeg.org/ffmpeg-devel.asc" \
    && curl --fail --location --silent --show-error \
      --output /tmp/openssl.tar.gz \
      "https://github.com/openssl/openssl/releases/download/openssl-${OPENSSL_VERSION}/openssl-${OPENSSL_VERSION}.tar.gz" \
    && echo "${OPENSSL_SHA256}  /tmp/openssl.tar.gz" | sha256sum -c - \
    && GNUPGHOME=/tmp/gnupg gpg --batch --import /tmp/ffmpeg-source/ffmpeg-devel.asc \
    && GNUPGHOME=/tmp/gnupg gpg --batch --fingerprint \
      | grep -F "FCF9 86EA 15E6 E293 A564  4F10 B432 2F04 D676 58D8" \
    && GNUPGHOME=/tmp/gnupg gpg --batch --verify \
      /tmp/ffmpeg-source/ffmpeg.tar.xz.asc /tmp/ffmpeg-source/ffmpeg.tar.xz \
    && mkdir -p /tmp/openssl-source \
    && tar -xzf /tmp/openssl.tar.gz -C /tmp/openssl-source --strip-components=1 \
    && cd /tmp/openssl-source \
    && ./config no-shared no-tests no-apps no-docs --prefix=/opt/openssl --libdir=lib \
    && make -j"$(getconf _NPROCESSORS_ONLN)" \
    && make install_sw \
    && tar -xJf /tmp/ffmpeg-source/ffmpeg.tar.xz -C /tmp/ffmpeg-source --strip-components=1 \
    && cd /tmp/ffmpeg-source \
    && PKG_CONFIG_PATH=/opt/openssl/lib/pkgconfig ./configure \
      --prefix=/opt/ffmpeg \
      --enable-static \
      --disable-shared \
      --disable-debug \
      --disable-doc \
      --disable-ffplay \
      --enable-openssl \
      --pkg-config-flags=--static \
      --extra-cflags=-I/opt/openssl/include \
      --extra-ldflags=-L/opt/openssl/lib \
      --extra-ldexeflags=-static \
    && make -j"$(getconf _NPROCESSORS_ONLN)" \
    && make install \
    && /opt/ffmpeg/bin/ffmpeg -version \
    && /opt/ffmpeg/bin/ffprobe -version

FROM reg.mini.dev/python:3.14.7-dev AS builder

USER root

ARG SETUPTOOLS_VERSION
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cpu
# Keep torch and torchaudio on the same release. PyTorch 2.11.0 publishes
# Linux CPU wheels for CPython 3.14 and is above the CVE-2026-24747 fix level.
ARG TORCH_VERSION=2.11.0
ARG APP_VERSION=dev

ENV VIRTUAL_ENV=/opt/venv \
    PATH=/opt/venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    OMP_NUM_THREADS=2 \
    MKL_NUM_THREADS=2 \
    OPENBLAS_NUM_THREADS=2

WORKDIR /app

COPY requirements.txt ./

# Pip is not needed by the runtime. Removing it also removes its vendored
# historical SBOM, which otherwise reports packages that are not installed.
# Torch declares setuptools<82, so use the compatible pinned release while pip
# resolves and validates the environment. Setuptools is a build/install tool for
# this service and is removed before the runtime venv is copied.
RUN python -m venv "$VIRTUAL_ENV" \
    && python -m pip install --upgrade pip \
    && pip install --index-url "${TORCH_INDEX_URL}" \
      "torch==${TORCH_VERSION}" \
      "torchaudio==${TORCH_VERSION}" \
    && pip install -r requirements.txt \
    && pip install --upgrade \
      "setuptools==${SETUPTOOLS_VERSION}" \
      "wheel==0.46.2" \
      "msgpack==1.2.1" \
    && pip check \
    && python -c 'import importlib.metadata as metadata, sys; assert metadata.version("setuptools") == sys.argv[1]' "${SETUPTOOLS_VERSION}"

RUN python -c 'import pathlib, shutil; root = pathlib.Path("/opt/venv/lib/python3.14/site-packages"); [shutil.rmtree(path, ignore_errors=True) for name in ("pip", "setuptools", "pkg_resources", "_distutils_hack") for path in (root / name, *root.glob(name + "-*.dist-info"), *root.glob(name + "-*.egg-info"))]; (root / "distutils-precedence.pth").unlink(missing_ok=True); [path.unlink(missing_ok=True) for path in pathlib.Path("/opt/venv/bin").glob("pip*")]'

COPY app.py model_sync.py ./

RUN python -c 'import fastapi, lightning, pyannote.audio, torch, torchaudio, uvicorn; print(f"torch={torch.__version__} torchaudio={torchaudio.__version__}")' \
    && python -c 'import importlib.metadata as metadata, importlib.util; installed = {dist.metadata["Name"].lower() for dist in metadata.distributions() if dist.metadata["Name"]}; forbidden = {"pip", "setuptools"}; assert all(importlib.util.find_spec(name) is None for name in forbidden); assert not forbidden.intersection(installed)'

FROM reg.mini.dev/python:3.14.7 AS runtime-base-prepared

USER root

# Runtime-base digests can ship pip 26.2.1 and setuptools 70.3.0 outside
# /opt/venv. The amd64 image also includes a pip bootstrap wheel under
# /usr/share/python-wheels whose embedded SBOM declares setuptools 70.3.0 even
# after the installed packages are removed. Neither pip nor its bootstrap wheel
# is needed at runtime, so remove both layouts before flattening the base.
# This base is distroless and has no shell; use exec-form Python for the cleanup.
RUN ["python", "-c", "import importlib.util, pathlib, shutil, site; roots = {pathlib.Path(path) for path in site.getsitepackages()}; [shutil.rmtree(path, ignore_errors=True) for root in roots for name in ('pip', 'setuptools', 'pkg_resources', '_distutils_hack') for path in (root / name, *root.glob(name + '-*.dist-info'), *root.glob(name + '-*.egg-info'))]; [(root / 'distutils-precedence.pth').unlink(missing_ok=True) for root in roots]; [pathlib.Path(path).unlink(missing_ok=True) for path in ('/usr/bin/pip', '/usr/bin/pip3', '/usr/bin/pip3.14')]; shutil.rmtree('/usr/share/python-wheels', ignore_errors=True); importlib.invalidate_caches(); assert all(importlib.util.find_spec(name) is None for name in ('pip', 'setuptools', 'pkg_resources', '_distutils_hack')); assert not pathlib.Path('/usr/share/python-wheels').exists()"]

# Deleting files in a later container layer only adds whiteouts; scanners that
# inspect every layer can still read pip's old embedded bom.cdx.json from the
# Minimus base layer. Copy the prepared merged filesystem onto scratch so the
# reusable runtime base contains the cleaned filesystem as one physical layer
# and no inherited pip/setuptools layer history.
FROM scratch AS runtime-base

COPY --from=runtime-base-prepared / /

FROM runtime-base AS runtime

ARG APP_VERSION=dev

LABEL org.opencontainers.image.version=$APP_VERSION

ENV IMAGE_NAME=python \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/tmp \
    XDG_CACHE_HOME=/tmp/.cache \
    MPLCONFIGDIR=/tmp/matplotlib \
    VIRTUAL_ENV=/opt/venv \
    PATH=/opt/venv/bin:/opt/ffmpeg/bin:/usr/local/sbin:/usr/local/bin:/usr/bin:/usr/sbin:/sbin:/bin \
    HF_HOME=/tmp/huggingface \
    HUGGINGFACE_HUB_CACHE=/tmp/huggingface/hub \
    OMP_NUM_THREADS=2 \
    MKL_NUM_THREADS=2 \
    OPENBLAS_NUM_THREADS=2

WORKDIR /app

COPY --from=builder /opt/venv /opt/venv
COPY --from=ffmpeg-builder /opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffmpeg
COPY --from=builder /app/app.py /app/app.py
COPY --from=builder /app/model_sync.py /app/model_sync.py

RUN ["/opt/venv/bin/python", "-c", "import importlib.metadata as metadata, importlib.util, pathlib; installed = {dist.metadata['Name'].lower() for dist in metadata.distributions() if dist.metadata['Name']}; forbidden = {'pip', 'setuptools'}; assert all(importlib.util.find_spec(name) is None for name in forbidden); assert not forbidden.intersection(installed); assert not list(pathlib.Path('/opt/venv/bin').glob('pip*')); assert not pathlib.Path('/usr/share/python-wheels').exists()"]

USER 1000

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=10m --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=5)"]

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
