ARG SETUPTOOLS_VERSION=80.10.2

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

FROM reg.mini.dev/python:3.14-dev AS builder

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
# Torch requires setuptools<82; keep the compatible release above both
# setuptools CVE fix levels and verify it before copying the venv.
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

RUN rm -rf "$VIRTUAL_ENV/lib/python3.14/site-packages/pip" \
    && rm -rf "$VIRTUAL_ENV/lib/python3.14/site-packages/pip-"*.dist-info

COPY app.py ./

RUN python -c 'import torch, torchaudio; print(f"torch={torch.__version__} torchaudio={torchaudio.__version__}")'

FROM reg.mini.dev/python:3.14 AS runtime

USER root

ARG SETUPTOOLS_VERSION
ARG APP_VERSION=dev

LABEL org.opencontainers.image.version=$APP_VERSION

ENV SETUPTOOLS_VERSION=${SETUPTOOLS_VERSION}

# Older runtime-base digests shipped pip 26.2.1 and setuptools 70.3.0 outside
# /opt/venv. pip's embedded SBOM kept that vulnerable setuptools version visible
# to image scanners even though the application venv was already fixed. Current
# base digests omit both packages, so make the cleanup work for either layout.
# This base is distroless and has no shell; use exec-form Python for the cleanup.
RUN ["python", "-c", "import importlib.util, pathlib, shutil, site; root = pathlib.Path(site.getsitepackages()[0]); [shutil.rmtree(path, ignore_errors=True) for name in ('pip', 'setuptools') for path in (root / name, *root.glob(name + '-*.dist-info'), *root.glob(name + '-*.egg-info'))]; [pathlib.Path(path).unlink(missing_ok=True) for path in ('/usr/bin/pip', '/usr/bin/pip3', '/usr/bin/pip3.14')]; importlib.invalidate_caches(); assert importlib.util.find_spec('pip') is None; assert importlib.util.find_spec('setuptools') is None"]

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    VIRTUAL_ENV=/opt/venv \
    PATH=/opt/venv/bin:/opt/ffmpeg/bin:$PATH \
    HF_HOME=/tmp/huggingface \
    HUGGINGFACE_HUB_CACHE=/tmp/huggingface/hub \
    OMP_NUM_THREADS=2 \
    MKL_NUM_THREADS=2 \
    OPENBLAS_NUM_THREADS=2

COPY --from=builder /opt/venv /opt/venv
COPY --from=ffmpeg-builder /opt/ffmpeg /opt/ffmpeg
COPY --from=builder /app/app.py /app/app.py

RUN ["/opt/venv/bin/python", "-c", "import importlib.metadata as metadata, importlib.util, os; assert metadata.version('setuptools') == os.environ['SETUPTOOLS_VERSION']; assert importlib.util.find_spec('pip') is None"]

USER 1000

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=10m --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=5)"]

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
