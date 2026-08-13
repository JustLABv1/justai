# JustAI production images are intentionally separate: the frontend and
# backend have different lifecycle, health, and scaling requirements.

FROM node:22-alpine AS frontend-deps
WORKDIR /app
RUN corepack enable
COPY services/frontend/package.json services/frontend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM frontend-deps AS frontend-build
WORKDIR /app
COPY services/frontend/ ./
ARG NEXT_PUBLIC_API_URL=http://localhost:8080
ARG APP_VERSION=dev
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_PUBLIC_APP_VERSION=${APP_VERSION}
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm run lint && pnpm run typecheck && pnpm run build

FROM node:22-alpine AS frontend
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN addgroup -S nodejs && adduser -S nextjs -G nodejs
COPY --from=frontend-build --chown=nextjs:nodejs /app/public ./public
COPY --from=frontend-build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=frontend-build --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]

FROM golang:1.26-alpine AS backend-build
WORKDIR /app
RUN apk add --no-cache ca-certificates
COPY services/backend/go.mod services/backend/go.sum ./services/backend/
WORKDIR /app/services/backend
RUN go mod download
COPY services/backend/ ./
ARG APP_VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.version=${APP_VERSION}" -o /justai-backend .

FROM alpine:3.22 AS backend
RUN apk add --no-cache ca-certificates poppler-utils tzdata wget \
    && addgroup -S justai \
    && adduser -S justai -G justai
WORKDIR /app
COPY --from=backend-build /justai-backend ./justai-backend
RUN mkdir -p /app/data && chown -R justai:justai /app
ENV JUSTAI_ENV=production
ENV JUSTAI_PORT=8080
ENV JUSTAI_TRANSCRIPTION_LOCAL_STORAGE_PATH=/app/data/transcription
USER justai
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
  CMD wget -q -O - http://127.0.0.1:8080/api/v1/health/ready >/dev/null || exit 1
ENTRYPOINT ["/app/justai-backend"]
