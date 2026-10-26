FROM node:26.12.1-alpine3.24 AS frontend-builder
USER root
WORKDIR /app/frontend

RUN npm install -g pnpm

COPY services/frontend/package.json services/frontend/pnpm-lock.yaml services/frontend/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --network-concurrency=4 --child-concurrency=1

COPY services/frontend/ ./

ARG NEXT_PUBLIC_API_URL=""
ARG APP_VERSION=dev
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_APP_VERSION=$APP_VERSION
ENV NEXT_TELEMETRY_DISABLED=1

RUN pnpm run build

# Stage 2: Build the backend
FROM golang:1.27.3-bookworm AS backend-builder
WORKDIR /app/backend
COPY services/backend/go.mod services/backend/go.sum ./
RUN go mod download
COPY services/backend/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o justai-backend

# Stage 3: Build a static FFmpeg 9 binary. CI overrides this named stage with
# the digest-pinned image produced by docker/ffmpeg/Dockerfile. The source build
# remains as a verified fallback for ordinary local Docker builds.
FROM alpine:3.24 AS ffmpeg-builder
ARG FFMPEG_VERSION=9.0.1
ARG OPENSSL_VERSION=3.5.9
ARG OPENSSL_SHA256=603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a
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

# Stage 4: Minimal musl runtime, matching the frontend builder's libc.
# Copy only Node rather than inheriting npm, Yarn and build headers.
# Temporary signed security backport, matching JustCD's stable-Alpine pattern.
# Keep source checksums and package metadata so scanners see the shipped version.
FROM alpine:3.24 AS expat-builder
RUN apk add --no-cache alpine-sdk
WORKDIR /src/expat
COPY services/backend/packaging/expat/APKBUILD ./
RUN abuild-keygen -a -n \
    && cp /root/.abuild/*.rsa.pub /etc/apk/keys/ \
    && apk update \
    && abuild -F -r -P /packages \
    && mkdir -p /out/keys \
    && cp /root/.abuild/*.rsa.pub /out/keys/ \
    && find /packages -name 'libexpat-*.apk' -exec cp {} /out/ \; \
    && rm -f /root/.abuild/*.rsa

FROM alpine:3.24 AS runner
COPY --from=frontend-builder /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=expat-builder /out/keys/ /etc/apk/keys/
COPY --from=expat-builder /out/libexpat-*.apk /tmp/expat/
RUN apk upgrade --no-cache \
    && apk add --no-cache /tmp/expat/*.apk \
    && rm -rf /tmp/expat

# pip is only needed while installing pypdf. Remove packaging tools in the same
# layer so neither the final image nor its layer history keeps setuptools.
RUN apk add --upgrade --no-cache \
    ca-certificates \
    libstdc++ \
    libatomic \
    poppler-utils \
    'libexpat>=2.9.0-r0' \
    tini \
    python3 \
    py3-pip \
    tzdata \
    wget \
    'libcrypto3>=3.5.9-r0' \
    'libssl3>=3.5.9-r0' \
    && python3 -m venv /opt/templates-venv \
    && /opt/templates-venv/bin/pip install --no-cache-dir pypdf==6.21.2 \
    && /opt/templates-venv/bin/python -c 'import pathlib, shutil, sysconfig; root = pathlib.Path(sysconfig.get_path("purelib")); [shutil.rmtree(path, ignore_errors=True) for name in ("pip", "setuptools", "pkg_resources", "_distutils_hack") for path in (root / name, *root.glob(name + "-*.dist-info"), *root.glob(name + "-*.egg-info"))]; (root / "distutils-precedence.pth").unlink(missing_ok=True); [path.unlink(missing_ok=True) for path in pathlib.Path("/opt/templates-venv/bin").glob("pip*")]' \
    && apk del py3-pip \
    && if apk info -e py3-setuptools >/dev/null 2>&1; then apk del py3-setuptools; fi \
    && rm -rf /usr/share/python-wheels
ENV JUSTAI_TEMPLATE_PYTHON=/opt/templates-venv/bin/python

RUN node --version && pdftotext -v
COPY --from=ffmpeg-builder /opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffmpeg
COPY --from=ffmpeg-builder /opt/ffmpeg/bin/ffprobe /opt/ffmpeg/bin/ffprobe

# Create user and group
RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs

# Copy the backend binary
COPY --from=backend-builder /app/backend/justai-backend /app/justai-backend

# Copy the frontend build
COPY --from=frontend-builder /app/frontend/public /app/public

# Set the correct permission for prerender cache
RUN mkdir .next \
    && chown nextjs:nodejs .next

# Automatically leverage output traces to reduce image size
COPY --from=frontend-builder --chown=nextjs:nodejs /app/frontend/.next/standalone ./
COPY --from=frontend-builder --chown=nextjs:nodejs /app/frontend/.next/static ./.next/static

RUN chown -R nextjs:nodejs /app

RUN mkdir -p /etc/justai \
    && chown -R nextjs:nodejs /etc/justai

RUN mkdir -p /app/data \
    && chown -R nextjs:nodejs /app/data

ENV JUSTAI_ENV=production
ENV NODE_ENV=production
ENV PATH=/opt/ffmpeg/bin:$PATH

VOLUME [ "/etc/justai", "/app/data" ]

EXPOSE 8080 3000

USER nextjs

ENTRYPOINT ["/sbin/tini", "--"]

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=12 \
    CMD wget -q -O - http://127.0.0.1:8080/api/v1/health/ready >/dev/null \
    && wget -q -O - http://127.0.0.1:3000/ >/dev/null || exit 1

CMD ["sh", "-c", "./justai-backend --config /etc/justai/config.yaml & backend_pid=$!; node /app/server.js; status=$?; kill $backend_pid 2>/dev/null || true; wait $backend_pid 2>/dev/null || true; exit $status"]
