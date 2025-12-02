# API Reference

Karpenter Optimizer provides a RESTful API for programmatic access to recommendations and cluster data.

## Base URL

- **Local Development**: `http://localhost:8080`
- **In-Cluster**: `http://karpenter-optimizer:8080` (service DNS)
- **Via Ingress**: `https://your-domain.com/api`

## Interactive Documentation

The API includes interactive Swagger/OpenAPI documentation:

- **Swagger UI**: `http://localhost:8080/api/swagger/index.html`
- **OpenAPI Spec**: `http://localhost:8080/api/swagger/doc.json`

## Authentication

Currently, the API does not require authentication (assumes internal network access). Future versions may add authentication.

## Endpoints

### Health Check

```http
GET /api/v1/health
```

Check API health and service status.

**Response**:
```json
{
  "status": "healthy",
  "service": "karpenter-optimizer",
  "version": "0.0.1",
  "kubernetes": "connected",
  "aws_pricing": "available",
  "ollama": "available"
}
```

### Get Cluster Summary

```http
GET /api/v1/cluster/summary
```

Get cluster-wide statistics.

**Response**:
```json
{
  "totalNodes": 10,
  "totalCPU": 40.0,
  "totalMemory": 160.0,
  "usedCPU": 25.5,
  "usedMemory": 80.0,
  "nodePools": 3
}
```

### List NodePools

```http
GET /api/v1/nodepools
```

List all NodePools with actual node data.

**Response**:
```json
[
  {
    "name": "general-pool",
    "instanceTypes": ["m5.large", "m5.xlarge"],
    "capacityType": "spot",
    "nodes": [
      {
        "name": "node-1",
        "instanceType": "m5.large",
        "cpuUsage": 1.5,
        "memoryUsage": 4.0
      }
    ]
  }
]
```

### Get NodePool Recommendations

```http
GET /api/v1/nodepools/recommendations
```

Get recommendations for all NodePools.

**Response**:
```json
[
  {
    "nodePoolName": "general-pool",
    "currentNodes": 5,
    "currentInstanceTypes": ["m5.large (3)", "m5.xlarge (2)"],
    "currentCPUUsed": 12.5,
    "currentCPUCapacity": 20.0,
    "currentMemoryUsed": 40.0,
    "currentMemoryCapacity": 80.0,
    "currentCost": 0.48,
    "recommendedNodes": 4,
    "recommendedInstanceTypes": ["m5.xlarge (4)"],
    "recommendedTotalCPU": 16.0,
    "recommendedTotalMemory": 64.0,
    "recommendedCost": 0.384,
    "costSavings": 0.096,
    "costSavingsPercent": 20.0,
    "reasoning": "AI-generated explanation...",
    "architecture": "amd64",
    "capacityType": "spot"
  }
]
```

### Get Cluster Summary Recommendations

```http
GET /api/v1/recommendations/cluster-summary
```

Get cluster-wide recommendations with AI explanations (SSE streaming).

**Query Parameters**:
- `stream` (optional): Enable Server-Sent Events streaming (default: false)

**Response** (non-streaming):
```json
{
  "recommendations": [...],
  "totalCostSavings": 0.5,
  "totalCostSavingsPercent": 15.0
}
```

**Response** (streaming):
Server-Sent Events with progress updates:
```
event: progress
data: {"message": "Analyzing NodePools...", "progress": 25.0}

event: progress
data: {"message": "Generating recommendations...", "progress": 50.0}

event: complete
data: {"recommendations": [...], "totalCostSavings": 0.5}
```

### List Nodes

```http
GET /api/v1/nodes
```

Get all nodes with usage data.

**Response**:
```json
[
  {
    "name": "node-1",
    "instanceType": "m5.large",
    "architecture": "amd64",
    "capacityType": "spot",
    "nodePool": "general-pool",
    "cpuUsage": {
      "used": 1.5,
      "capacity": 2.0,
      "percentage": 75.0
    },
    "memoryUsage": {
      "used": 4.0,
      "capacity": 8.0,
      "percentage": 50.0
    },
    "podCount": 10
  }
]
```

### Get Node Disruptions

```http
GET /api/v1/disruptions
```

Get node disruption information (on-demand nodes only).

**Response**:
```json
[
  {
    "nodeName": "node-1",
    "nodePool": "general-pool",
    "disruptionReason": "FailedDraining",
    "blocked": true,
    "blockedReason": "Pod has PDB"
  }
]
```

### Analyze Workloads

```http
POST /api/v1/analyze
```

Analyze workloads and get recommendations (legacy endpoint).

**Request Body**:
```json
{
  "workloads": [
    {
      "name": "app-1",
      "namespace": "default",
      "cpu": 2.0,
      "memory": 4.0
    }
  ]
}
```

**Response**:
```json
{
  "recommendations": [...],
  "totalCost": 0.5
}
```

## Error Responses

All errors follow this format:

```json
{
  "error": "Error message",
  "code": "ERROR_CODE"
}
```

**HTTP Status Codes**:
- `200` - Success
- `400` - Bad Request
- `404` - Not Found
- `500` - Internal Server Error

## Rate Limiting

Currently, there is no rate limiting. Future versions may add rate limiting.

## CORS

CORS is enabled for local development. For production, configure CORS appropriately.

## Examples

### Using cURL

```bash
# Health check
curl http://localhost:8080/api/v1/health

# Get recommendations
curl http://localhost:8080/api/v1/nodepools/recommendations

# Get cluster summary
curl http://localhost:8080/api/v1/cluster/summary
```

### Using JavaScript (Fetch API)

```javascript
// Get recommendations
const response = await fetch('http://localhost:8080/api/v1/nodepools/recommendations');
const recommendations = await response.json();
console.log(recommendations);
```

### Using Go

```go
import "net/http"

resp, err := http.Get("http://localhost:8080/api/v1/health")
if err != nil {
    log.Fatal(err)
}
defer resp.Body.Close()
```

## Swagger/OpenAPI

For complete API documentation with request/response schemas, see:
- **Swagger UI**: `http://localhost:8080/api/swagger/index.html`
- **OpenAPI Spec**: `http://localhost:8080/api/swagger/doc.json`

Generate Swagger docs locally:
```bash
make swagger
```

## Versioning

The API uses URL versioning (`/api/v1/`). Future breaking changes will use `/api/v2/`.

## Support

For API questions or issues:
- [GitHub Issues](https://github.com/kaskol10/karpenter-optimizer/issues)
- [GitHub Discussions](https://github.com/kaskol10/karpenter-optimizer/discussions)

