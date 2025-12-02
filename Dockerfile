# Build stage
# Using 1.23 as base, toolchain will automatically download 1.24 if needed
FROM golang:1.23-alpine AS builder

WORKDIR /app

# Enable toolchain to automatically download required Go version if needed
# This allows go.mod to require Go 1.24 even if base image is 1.23
ENV GOTOOLCHAIN=auto

# Copy go mod files
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Build the API server
RUN CGO_ENABLED=0 GOOS=linux go build -o /app/bin/karpenter-optimizer-api ./cmd/api

# Build the CLI
RUN CGO_ENABLED=0 GOOS=linux go build -o /app/bin/karpenter-optimizer ./cmd/cli

# Final stage
FROM alpine:latest

RUN apk --no-cache add ca-certificates

WORKDIR /root/

# Copy binaries from builder
COPY --from=builder /app/bin/karpenter-optimizer-api .
COPY --from=builder /app/bin/karpenter-optimizer .

EXPOSE 8080

CMD ["./karpenter-optimizer-api"]

