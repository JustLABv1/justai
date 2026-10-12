FROM reg.mini.dev/node:26.7.0-dev AS builder

USER root
WORKDIR /app
RUN npm install -g pnpm

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --network-concurrency=4 --child-concurrency=1

COPY . .

ARG NEXT_PUBLIC_API_URL=""
ARG APP_VERSION=dev
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_APP_VERSION=$APP_VERSION
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm run build

# Patch the production filesystem using the dev image's package manager. The
# production base has no apk; keeping the tool in this stage preserves that.
FROM reg.mini.dev/node:26.7.0 AS runtime-base
FROM reg.mini.dev/node:26.7.0-dev AS runtime-patcher
USER root
COPY --from=runtime-base / /runtime/
# CVE-2026-84782: keep the OpenSSL libraries and package/SBOM metadata together.
RUN apk --root /runtime --repositories-file /etc/apk/repositories \
    --keys-dir /etc/apk/keys add --upgrade --no-cache \
    'libcrypto3>=3.5.9-r0' 'libssl3>=3.5.9-r0'

# Copy the complete patched root so removed package metadata cannot survive in
# a lower layer. Restore the production base's environment and entrypoint.
FROM scratch AS runner
COPY --from=runtime-patcher /runtime/ /
ENV IMAGE_NAME=node \
    NODE_VERSION=26.7.0 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
ENTRYPOINT ["docker-entrypoint.sh"]
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=builder --chown=1000:1000 /app/public ./public
COPY --from=builder --chown=1000:1000 /app/.next/standalone ./
COPY --from=builder --chown=1000:1000 /app/.next/static ./.next/static

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=6 \
    CMD node -e "fetch('http://127.0.0.1:3000/').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

USER 1000:1000

CMD ["node", "server.js"]
