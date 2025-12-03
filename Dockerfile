# Build stage
# Using 1.23 as base, toolchain will automatically download 1.24 if needed
FROM golang:1.25-alpine AS builder

WORKDIR /app

# Enable toolchain to automatically download required Go version if needed
# This allows go.mod to require Go 1.24 even if base image is 1.23
ENV GOTOOLCHAIN=auto

# Copy go mod files first for better layer caching
COPY go.mod go.sum ./
RUN go mod download

# Install swag CLI for generating Swagger docs (cache this layer separately)
RUN go install github.com/swaggo/swag/cmd/swag@latest

# Copy source code
COPY . .

# Generate Swagger documentation before building
ENV PATH=$PATH:/go/bin
RUN swag init -g cmd/api/main.go -o ./docs/swagger

# Build both binaries in a single layer (faster than separate layers)
RUN CGO_ENABLED=0 GOOS=linux go build -o /app/bin/karpenter-optimizer-api ./cmd/api && \
    CGO_ENABLED=0 GOOS=linux go build -o /app/bin/karpenter-optimizer ./cmd/cli

# Final stage
FROM alpine:latest

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

