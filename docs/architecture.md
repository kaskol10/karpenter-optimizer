# Architecture

Karpenter Optimizer is built with a modern microservices architecture, consisting of a React frontend, Go backend API, and integrations with Kubernetes and AWS services.

## High-Level Architecture

```
┌─────────────────┐
│   Frontend UI   │  React-based web application
│   (Port 80)     │  Served via Nginx
└────────┬────────┘
         │ HTTP/HTTPS
         │ /api/* → Backend
         │ / → Frontend
         ▼
┌─────────────────┐
│  Backend API    │  Go-based REST API
│  (Port 8080)    │  Gin framework
└────────┬────────┘
         │
    ┌────┴────┬──────────────┬─────────────┐
    │         │              │             │
    ▼         ▼              ▼             ▼
┌─────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
│K8s API  │ │AWS      │ │Ollama    │ │Swagger   │
│         │ │Pricing  │ │LLM       │ │Docs      │
└─────────┘ └──────────┘ └──────────┘ └──────────┘
```

## Component Details

### Frontend (React)
- **Location**: `frontend/src/`
- **Framework**: React 18 with functional components and hooks
- **Key Libraries**:
  - `axios` - HTTP client for API calls
  - `recharts` - Chart visualization library
  - `react-scripts` - Build tooling
- **Deployment**: Nginx container serving static files
- **Routing**: Client-side routing with React Router (implicit)

### Backend (Go)
- **Location**: `cmd/api/` (entry), `internal/` (core logic)
- **Framework**: Gin HTTP router
- **Key Components**:
  - `internal/api/server.go` - HTTP handlers and routing
  - `internal/recommender/` - Recommendation engine
  - `internal/kubernetes/` - Kubernetes API client
  - `internal/awspricing/` - AWS Pricing API client
  - `internal/ollama/` - Ollama LLM client
- **API Documentation**: Swagger/OpenAPI (generated with `swag`)

### Kubernetes Integration
- **Purpose**: Fetch NodePools, nodes, pods, and resource usage
- **Client**: `k8s.io/client-go` (official Kubernetes Go client)
- **Authentication**: 
  - In-cluster: ServiceAccount tokens
  - Out-of-cluster: kubeconfig file
- **RBAC**: Requires read access to NodePools, nodes, pods

### AWS Pricing API
- **Purpose**: Fetch real-time EC2 instance pricing
- **Client**: Custom HTTP client with caching
- **Fallback**: Hardcoded pricing map if API unavailable
- **Region**: Defaults to `us-east-1`, configurable

### Ollama Integration
- **Purpose**: Generate AI-powered explanations for recommendations
- **Optional**: Works without Ollama (recommendations still generated)
- **Model**: Configurable (default: `gemma2:2b`)
- **Usage**: Enhances recommendation reasoning text

## Data Flow

### Recommendation Generation Flow

1. **User Request**: Frontend calls `/api/v1/recommendations`
2. **Fetch NodePools**: Backend queries Kubernetes for NodePools
3. **Fetch Nodes**: Backend queries Kubernetes for nodes in each NodePool
4. **Calculate Usage**: Backend calculates CPU/Memory usage from pod requests
5. **Fetch Pricing**: Backend queries AWS Pricing API for instance costs
6. **Generate Recommendations**: Backend runs recommendation algorithm
7. **Enhance with AI** (optional): Backend calls Ollama for explanations
8. **Return Results**: Backend returns recommendations to frontend
9. **Display**: Frontend renders recommendations with charts

### Cost Calculation Flow

1. **Current Cost**: Sum of (node count × instance price × capacity type multiplier)
2. **Recommended Cost**: Calculate optimal instance types and node count
3. **Compare**: Show cost savings percentage and dollar amount
4. **Validate**: Skip recommendations that increase cost by >10%

## Deployment Architecture

### Sidecar Pattern (Default)
- **Pod**: Single pod with two containers
  - Backend container (port 8080)
  - Frontend container (port 80, Nginx)
- **Service**: Exposes both ports
- **Ingress**: Routes `/api/*` to backend, `/` to frontend
- **Benefits**: Shared network namespace, simpler deployment

### Separate Deployments (Optional)
- Can deploy frontend and backend separately
- Requires CORS configuration
- More complex but more flexible

## Security Considerations

- **RBAC**: Least privilege Kubernetes access (read-only)
- **Network**: Internal service communication via Kubernetes DNS
- **Secrets**: Kubernetes secrets for sensitive data
- **Container**: Non-root user, read-only filesystem where possible
- **API**: No authentication required (assumes internal network)

## Scalability

- **Horizontal**: Can scale backend pods independently
- **Caching**: AWS pricing cached to reduce API calls
- **Rate Limiting**: Consider adding for production
- **Resource Limits**: Configured via Helm chart

## Monitoring

- **Health Endpoint**: `/api/v1/health`
- **Metrics**: Can integrate with Prometheus (ServiceMonitor available)
- **Logging**: Structured logging via Go's log package
- **Tracing**: Not currently implemented (future enhancement)

## Future Enhancements

- Multi-region AWS pricing support
- Support for other cloud providers (GCP, Azure)
- Machine learning-based predictions
- Automated NodePool updates
- Webhook notifications
- Authentication/authorization

For more details, see:
- [API Reference](api-reference.md) - Complete API documentation
- [Deployment Guide](deployment.md) - Deployment instructions
- [AGENTS.md](../AGENTS.md) - Detailed technical documentation

