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
    ffmpeg \
    tzdata \
    wget

COPY --from=builder /app/justai-backend /app/

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
