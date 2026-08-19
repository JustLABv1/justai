FROM alpine:3.24 AS ffmpeg-builder

ARG FFMPEG_VERSION=9.0.1
ARG OPENSSL_VERSION=3.5.7
ARG OPENSSL_SHA256=a8c0d28a529ca480f9f36cf5792e2cd21984552a3c8e4aa11a24aa31aeac98e8

# Use an upstream-verified static FFmpeg build. Alpine 3.24 packages FFmpeg
# 8.1.2, which is affected by CVE-2026-64830 and CVE-2026-64831.
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

FROM reg.mini.dev/go:v1.26.6 AS builder
USER 0
ARG APP_VERSION=dev
# Define cache locations for Go build
ENV GOCACHE=/tmp/go-cache
ENV GOPATH=/go
ENV HOME=/tmp

WORKDIR /app

COPY go.mod go.sum ./

# Run go mod download
RUN go mod download

COPY . .

# Build
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o justai-backend

FROM alpine:3.24 AS runner
ARG APP_VERSION=dev
WORKDIR /app

LABEL org.opencontainers.image.version=$APP_VERSION

RUN apk add --upgrade --no-cache \
    ca-certificates \
    libcrypto3 \
    libssl3 \
    poppler-utils \
    tzdata \
    wget

COPY --from=builder /app/justai-backend /app/
COPY --from=ffmpeg-builder /opt/ffmpeg /opt/ffmpeg

ENV PATH=/opt/ffmpeg/bin:$PATH

RUN addgroup --system --gid 1001 justai
RUN adduser --system --uid 1001 justai

RUN mkdir -p /etc/justai \
    && chown -R justai:justai /etc/justai

RUN mkdir -p /app/data \
    && chown -R justai:justai /app/data

RUN chown -R justai:justai /app

ENV JUSTAI_ENV=production
ENV JUSTAI_PORT=8080
ENV JUSTAI_TRANSCRIPTION_LOCAL_STORAGE_PATH=/app/data/transcription

VOLUME [ "/etc/justai", "/app/data" ]

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=12 \
    CMD wget -q -O - http://127.0.0.1:8080/api/v1/health/ready >/dev/null || exit 1

USER justai

CMD [ "/app/justai-backend", "--config", "/etc/justai/config.yaml" ]
