FROM ghcr.io/aquasecurity/trivy:latest AS trivy-bin

FROM reg.mini.dev/node:v26.5.1-dev AS base
USER root

# Stage 1: Build the frontend
FROM reg.mini.dev/node:v26.5.1-dev AS frontend-builder
USER root
WORKDIR /app/frontend

RUN npm install -g pnpm

COPY services/frontend/package.json services/frontend/pnpm-lock.yaml services/frontend/pnpm-workspace.yaml ./
RUN pnpm install

COPY services/frontend/ ./

ARG NEXT_PUBLIC_API_URL=""
ARG APP_VERSION=dev
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_APP_VERSION=$APP_VERSION
ENV NEXT_TELEMETRY_DISABLED=1

RUN pnpm run build

# Stage 2: Build the documentation service
FROM reg.mini.dev/node:v26.5.1-dev AS docs-builder
USER root
WORKDIR /app/docs

RUN npm install -g pnpm

COPY services/docs/package.json services/docs/pnpm-lock.yaml services/docs/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY services/docs/ ./

ENV NEXT_TELEMETRY_DISABLED=1

RUN pnpm run build

# Stage 3: Build the backend
FROM reg.mini.dev/go:v1.26.5 AS backend-builder
WORKDIR /app/backend
COPY services/backend/go.mod services/backend/go.sum ./
RUN go mod download
COPY services/backend/ ./
ARG APP_VERSION=dev
RUN CGO_ENABLED=0 go build -ldflags="-X main.version=${APP_VERSION}" -o justscan-backend

# Stage 4: Create the final image
FROM base AS runner
WORKDIR /app

# Install necessary packages
RUN apk add --upgrade --no-cache \
    ca-certificates \
    git \
    helm \
    tini \
    postgresql-client \
    tzdata \
    libcrypto3 \
    libssl3

COPY --from=trivy-bin /usr/local/bin/trivy /usr/local/bin/trivy
COPY docker-entrypoint.sh /app/docker-entrypoint.sh

# Create user and group
RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs

# Copy the backend binary
COPY --from=backend-builder /app/backend/justscan-backend /app/

# Copy the frontend build
COPY --from=frontend-builder /app/frontend/public /app/public

# Set the correct permission for prerender cache
RUN mkdir .next \
    && chown nextjs:nodejs .next

# Automatically leverage output traces to reduce image size
COPY --from=frontend-builder --chown=nextjs:nodejs /app/frontend/.next/standalone ./
COPY --from=frontend-builder --chown=nextjs:nodejs /app/frontend/.next/static ./.next/static

# Copy the documentation standalone server into its own directory so it can
# run beside the frontend process on an internal port.
COPY --from=docs-builder --chown=nextjs:nodejs /app/docs/public /app/docs/public
COPY --from=docs-builder --chown=nextjs:nodejs /app/docs/.next/standalone /app/docs/
COPY --from=docs-builder --chown=nextjs:nodejs /app/docs/.next/static /app/docs/.next/static

RUN chown -R nextjs:nodejs /app

RUN mkdir -p /etc/justscan \
    && chown -R nextjs:nodejs /etc/justscan

RUN mkdir -p /app/data \
    && chown -R nextjs:nodejs /app/data

RUN chmod +x /app/docker-entrypoint.sh

# Set environment variables
ENV NODE_ENV=production
ENV TRIVY_CACHE_DIR=/app/data/trivy-cache

VOLUME [ "/etc/justscan", "/app/data" ]

# Expose ports
EXPOSE 8080 3000 3001

USER nextjs

# Use tini as the entrypoint
ENTRYPOINT ["/sbin/tini", "--", "/app/docker-entrypoint.sh"]

# Start the backend, frontend, and documentation service.
CMD ["sh", "-c", "./justscan-backend --config /etc/justscan/config.yaml & PORT=3001 HOSTNAME=0.0.0.0 node /app/docs/server.js & node /app/server.js"]
