FROM reg.mini.dev/node:26.7.0-dev AS frontend-builder
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
FROM reg.mini.dev/go:v1.26.6 AS backend-builder
WORKDIR /app/backend
COPY services/backend/go.mod services/backend/go.sum ./
RUN go mod download
COPY services/backend/ ./
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o justai-backend

# Stage 3: Build the PDF extraction utility. The MinimOS Node base image does
# not publish Poppler in its APK repository, so keep the dependency isolated
# and copy only the utility's non-glibc shared libraries into the final image.
FROM debian:bookworm-slim AS poppler-runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/poppler/bin /opt/poppler/lib \
    && cp /usr/bin/pdftotext /opt/poppler/bin/pdftotext \
    && ldd /usr/bin/pdftotext \
        | awk '/=> \// {print $3} /^\// {print $1}' \
        | while read -r library; do \
            case "$library" in \
                */libc.so.*|*/libm.so.*|*/libpthread.so.*|*/libdl.so.*|*/librt.so.*|*/libgcc_s.so.*|*/libstdc++.so.*|*/ld-linux*) ;; \
                *) cp -L "$library" /opt/poppler/lib/ ;; \
            esac; \
        done \
    && printf '%s\n' \
        '#!/bin/sh' \
        'export LD_LIBRARY_PATH="/opt/poppler/lib${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"' \
        'exec /opt/poppler/bin/pdftotext "$@"' \
        > /usr/local/bin/pdftotext \
    && chmod 0755 /usr/local/bin/pdftotext

# Stage 4: Create the combined runtime image
FROM reg.mini.dev/node:26.7.0-dev AS runner
USER root
WORKDIR /app

RUN apk add --upgrade --no-cache \
    ca-certificates \
    tini \
    tzdata \
    wget \
    libcrypto3 \
    libssl3

COPY --from=poppler-runtime /opt/poppler /opt/poppler
COPY --from=poppler-runtime /usr/local/bin/pdftotext /usr/local/bin/pdftotext

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

VOLUME [ "/etc/justai", "/app/data" ]

EXPOSE 8080 3000

USER nextjs

ENTRYPOINT ["/sbin/tini", "--"]

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=12 \
    CMD wget -q -O - http://127.0.0.1:8080/api/v1/health/ready >/dev/null \
    && wget -q -O - http://127.0.0.1:3000/ >/dev/null || exit 1

CMD ["sh", "-c", "./justai-backend --config /etc/justai/config.yaml & backend_pid=$!; node /app/server.js; status=$?; kill $backend_pid 2>/dev/null || true; wait $backend_pid 2>/dev/null || true; exit $status"]
