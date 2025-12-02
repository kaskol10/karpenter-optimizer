# Build stage
FROM golang:1.21-alpine AS builder

WORKDIR /app

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

