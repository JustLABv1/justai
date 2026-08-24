# syntax=docker/dockerfile:1

ARG FFMPEG_VERSION=9.0.1
ARG OPENSSL_VERSION=3.5.7

FROM alpine:3.24 AS openssl-builder

ARG OPENSSL_VERSION
ARG OPENSSL_SHA256=a8c0d28a529ca480f9f36cf5792e2cd21984552a3c8e4aa11a24aa31aeac98e8

# OpenSSL changes independently from FFmpeg, so keep it in its own cacheable
# stage. Only its static libraries and headers are passed to the FFmpeg build.
RUN apk add --no-cache \
      build-base \
      curl \
      linux-headers \
      perl \
    && curl --fail --location --silent --show-error \
      --output /tmp/openssl.tar.gz \
      "https://github.com/openssl/openssl/releases/download/openssl-${OPENSSL_VERSION}/openssl-${OPENSSL_VERSION}.tar.gz" \
    && echo "${OPENSSL_SHA256}  /tmp/openssl.tar.gz" | sha256sum -c - \
    && mkdir -p /tmp/openssl-source \
    && tar -xzf /tmp/openssl.tar.gz -C /tmp/openssl-source --strip-components=1 \
    && cd /tmp/openssl-source \
    && ./config no-shared no-tests no-apps no-docs --prefix=/opt/openssl --libdir=lib \
    && make -j"$(getconf _NPROCESSORS_ONLN)" \
    && make install_sw

FROM alpine:3.24 AS ffmpeg-builder

ARG FFMPEG_VERSION

COPY --from=openssl-builder /opt/openssl /opt/openssl

# Build the same source-verified static FFmpeg used by the application images.
# The final artifact contains only the two runtime binaries, not this toolchain,
# the source trees, headers, or static archives.
RUN apk add --no-cache \
      build-base \
      curl \
      gnupg \
      linux-headers \
      nasm \
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
    && GNUPGHOME=/tmp/gnupg gpg --batch --import /tmp/ffmpeg-source/ffmpeg-devel.asc \
    && GNUPGHOME=/tmp/gnupg gpg --batch --fingerprint \
      | grep -F "FCF9 86EA 15E6 E293 A564  4F10 B432 2F04 D676 58D8" \
    && GNUPGHOME=/tmp/gnupg gpg --batch --verify \
      /tmp/ffmpeg-source/ffmpeg.tar.xz.asc /tmp/ffmpeg-source/ffmpeg.tar.xz \
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

FROM scratch

ARG FFMPEG_VERSION
ARG OPENSSL_VERSION

LABEL org.opencontainers.image.title="JustAI static FFmpeg artifact" \
      org.opencontainers.image.description="Source-verified static FFmpeg binaries shared by JustAI runtime images" \
      org.opencontainers.image.version="${FFMPEG_VERSION}-openssl-${OPENSSL_VERSION}"

COPY --from=ffmpeg-builder /opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffmpeg
COPY --from=ffmpeg-builder /opt/ffmpeg/bin/ffprobe /opt/ffmpeg/bin/ffprobe

ENTRYPOINT ["/opt/ffmpeg/bin/ffmpeg"]
