# Quick Start Guide

## Prerequisites

- Go 1.21+
- Node.js 16+ and npm
- (Optional) Docker and docker-compose

## Option 1: Local Development

### 1. Start the Backend API

```bash
# Install Go dependencies
go mod download

# Run the API server
go run ./cmd/api
```

The API will be available at `http://localhost:8080`

### 2. Start the Frontend

In a new terminal:

```bash
cd frontend
npm install
npm start
```

The frontend will be available at `http://localhost:3000`

### 3. Use the CLI

In another terminal:

```bash
# Build the CLI
go build -o bin/karpenter-optimizer ./cmd/cli

# Analyze example workloads
cat examples/workloads.json | ./bin/karpenter-optimizer analyze

# Or with JSON output
./bin/karpenter-optimizer analyze examples/workloads.json --json
```

## Option 2: Docker Compose

```bash
# Build and start all services
docker-compose up --build

# The frontend will be at http://localhost:3000
# The API will be at http://localhost:8080
```

## Testing the API

```bash
# Health check
curl http://localhost:8080/api/v1/health

# Analyze workloads
curl -X POST http://localhost:8080/api/v1/analyze \
  -H "Content-Type: application/json" \
  -d @examples/workloads.json
```

## Example Workload Format

```json
[
  {
    "name": "my-app",
    "namespace": "default",
    "cpu": "500m",
    "memory": "512Mi",
    "gpu": 0,
    "labels": {}
  }
]
```

## Next Steps

1. Open the web UI at `http://localhost:3000`
2. Add your workloads or use the example file
3. Click "Analyze Workloads" to get recommendations
4. Review the nodepool recommendations with cost estimates

