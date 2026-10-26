ARG SETUPTOOLS_VERSION=80.10.2

# Local builds compile the verified artifact here. CI overrides this named stage
# with the digest-pinned image produced by docker/ffmpeg/Dockerfile.
FROM alpine:3.24 AS ffmpeg-builder

ARG FFMPEG_VERSION=9.0.1
ARG OPENSSL_VERSION=3.5.9
ARG OPENSSL_SHA256=603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a

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

FROM python:3.14.9-slim-trixie AS builder

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

# Security update for filelock CVE-2026-112940; torch accepts this version.
RUN pip install --upgrade "filelock==4.2.1" && pip check

RUN python -c 'import pathlib, shutil; root = pathlib.Path("/opt/venv/lib/python3.14/site-packages"); [shutil.rmtree(path, ignore_errors=True) for name in ("pip", "setuptools", "pkg_resources", "_distutils_hack") for path in (root / name, *root.glob(name + "-*.dist-info"), *root.glob(name + "-*.egg-info"))]; (root / "distutils-precedence.pth").unlink(missing_ok=True); [path.unlink(missing_ok=True) for path in pathlib.Path("/opt/venv/bin").glob("pip*")]'

COPY app.py model_sync.py ./

RUN python -c 'import fastapi, lightning, pyannote.audio, torch, torchaudio, uvicorn; print(f"torch={torch.__version__} torchaudio={torchaudio.__version__}")' \
    && python -c 'import importlib.metadata as metadata, importlib.util; installed = {dist.metadata["Name"].lower() for dist in metadata.distributions() if dist.metadata["Name"]}; forbidden = {"pip", "setuptools"}; assert all(importlib.util.find_spec(name) is None for name in forbidden); assert not forbidden.intersection(installed)'

# Use the same glibc/Python ABI as the wheel builder. Only runtime libraries
# are installed; pip, headers, static archives and caches are removed before
# copying the merged filesystem, so they do not survive in lower layers.
FROM python:3.14.9-slim-trixie AS runtime-base-prepared
RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends ca-certificates libgomp1 libstdc++6 \
    && python -m pip uninstall -y pip setuptools wheel \
    && rm -rf /usr/local/include /usr/local/lib/pkgconfig \
      /usr/local/lib/python3.14/ensurepip /usr/local/lib/python3.14/test \
      /root/.cache /var/lib/apt/lists/* \
    && find /usr/local/lib -name '*.a' -delete \
    && groupadd --gid 1000 app \
    && useradd --uid 1000 --gid 1000 --no-create-home --home-dir /tmp app

COPY prepare_runtime.py /tmp/prepare_runtime.py
RUN python /tmp/prepare_runtime.py

FROM scratch AS runtime-base

COPY --from=runtime-base-prepared /runtime/ /

FROM runtime-base AS runtime

ARG APP_VERSION=dev

LABEL org.opencontainers.image.version=$APP_VERSION

ENV LANG=C.UTF-8 \
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

RUN ["/opt/venv/bin/python", "-c", "import fastapi, lightning, pyannote.audio, torch, torchaudio, uvicorn; import importlib.metadata as metadata, importlib.util, pathlib; installed = {dist.metadata['Name'].lower() for dist in metadata.distributions() if dist.metadata['Name']}; forbidden = {'pip', 'setuptools'}; assert all(importlib.util.find_spec(name) is None for name in forbidden); assert not forbidden.intersection(installed); assert not list(pathlib.Path('/opt/venv/bin').glob('pip*')); assert not pathlib.Path('/usr/share/python-wheels').exists()"]

USER 1000:1000

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=10m --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=5)"]

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
