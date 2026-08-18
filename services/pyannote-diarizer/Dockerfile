FROM reg.mini.dev/python:3.14-dev AS builder

USER root

ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cpu
# PyTorch 2.5.1 predates CPython 3.14 wheels. Keep torch and torchaudio on
# the same release; 2.9.1 publishes Linux CPU wheels for cp314.
ARG TORCH_VERSION=2.9.1
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

RUN python -m venv "$VIRTUAL_ENV" \
    && python -m pip install --upgrade pip \
    && pip install --index-url "${TORCH_INDEX_URL}" \
      "torch==${TORCH_VERSION}" \
      "torchaudio==${TORCH_VERSION}" \
    && pip install -r requirements.txt

# The production Minimus image is intentionally shell-less and does not carry
# OS package tooling. Install FFmpeg only in the dev stage, then copy its
# executable and resolved shared libraries into the production image.
RUN apk add --no-cache ffmpeg \
    && mkdir -p /opt/ffmpeg/bin /opt/ffmpeg/lib \
    && cp /usr/bin/ffmpeg /opt/ffmpeg/bin/ffmpeg \
    && ldd /usr/bin/ffmpeg \
      | awk '/=> \/.*\// { print $3 } /^[[:space:]]*\// { print $1 }' \
      > /tmp/ffmpeg-libraries \
    && while read -r library; do \
         if [ -f "$library" ]; then cp -L "$library" /opt/ffmpeg/lib/; fi; \
       done < /tmp/ffmpeg-libraries \
    && rm -f /tmp/ffmpeg-libraries \
    && find /usr/lib -maxdepth 1 -type f \( \
      -name 'libav*.so*' \
      -o -name 'libsw*.so*' \
      -o -name 'libpostproc*.so*' \
      -o -name 'libx264*.so*' \
      -o -name 'libx265*.so*' \
      -o -name 'libvpx*.so*' \
      -o -name 'libopus*.so*' \
      -o -name 'libvorbis*.so*' \
      -o -name 'libmp3lame*.so*' \
      -o -name 'libsoxr*.so*' \
    \) -exec cp -L {} /opt/ffmpeg/lib/ \;

COPY app.py ./

RUN python -c 'import torch, torchaudio; print(f"torch={torch.__version__} torchaudio={torchaudio.__version__}")'

FROM reg.mini.dev/python:3.14 AS runtime

ARG APP_VERSION=dev

LABEL org.opencontainers.image.version=$APP_VERSION

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    VIRTUAL_ENV=/opt/venv \
    PATH=/opt/venv/bin:/opt/ffmpeg/bin:$PATH \
    LD_LIBRARY_PATH=/opt/ffmpeg/lib \
    HF_HOME=/tmp/huggingface \
    HUGGINGFACE_HUB_CACHE=/tmp/huggingface/hub \
    OMP_NUM_THREADS=2 \
    MKL_NUM_THREADS=2 \
    OPENBLAS_NUM_THREADS=2

COPY --from=builder /opt/venv /opt/venv
COPY --from=builder /opt/ffmpeg /opt/ffmpeg
COPY --from=builder /app/app.py /app/app.py

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=10m --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=5)"]

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
