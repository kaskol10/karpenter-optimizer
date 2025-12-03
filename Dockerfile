# Build stage
FROM golang:1.25-alpine AS builder

WORKDIR /app

# Copy go mod files first for better layer caching
COPY go.mod go.sum ./

# Download dependencies with cache mount for faster subsequent builds
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download

# Install swag CLI for generating Swagger docs (cache this layer separately)
RUN go install github.com/swaggo/swag/cmd/swag@latest

# Copy source code
COPY . .

# Generate Swagger documentation before building
ENV PATH=$PATH:/go/bin
RUN swag init -g cmd/api/main.go -o ./docs/swagger

# Build both binaries with BuildKit cache mounts for faster builds
# Cache mounts persist Go build cache and module cache between builds
# Using -ldflags="-s -w" strips debug info and reduces binary size
# Using -trimpath removes file system paths from binaries
RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod \
    CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -trimpath -o /app/bin/karpenter-optimizer-api ./cmd/api

RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod \
    CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -trimpath -o /app/bin/karpenter-optimizer ./cmd/cli

# Final stage
FROM alpine:3.19

RUN apk --no-cache add ca-certificates

# Create a non-root user
RUN addgroup -g 1000 appuser && \
    adduser -D -u 1000 -G appuser appuser

# Create app directory with proper permissions
WORKDIR /app
RUN chown appuser:appuser /app

# Copy binaries from builder
COPY --from=builder --chown=appuser:appuser /app/bin/karpenter-optimizer-api /app/karpenter-optimizer-api
COPY --from=builder --chown=appuser:appuser /app/bin/karpenter-optimizer /app/karpenter-optimizer

# Ensure binaries are executable
RUN chmod +x /app/karpenter-optimizer-api /app/karpenter-optimizer

# Switch to non-root user
USER appuser

EXPOSE 8080

CMD ["./karpenter-optimizer-api"]

