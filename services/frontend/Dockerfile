FROM node:26.12.1-alpine3.24 AS builder

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

# Copy only Node: npm, Yarn and build headers never enter runtime layers.
FROM alpine:3.24 AS runner
RUN apk upgrade --no-cache \
    && apk add --no-cache ca-certificates libstdc++ libatomic \
    && addgroup -g 1000 node \
    && adduser -D -u 1000 -G node node
COPY --from=builder /usr/local/bin/node /usr/local/bin/node
RUN node --version
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
