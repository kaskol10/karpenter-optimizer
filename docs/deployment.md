# Deployment Guide

This guide covers deploying Karpenter Optimizer in various environments.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Helm Deployment (Recommended)](#helm-deployment-recommended)
- [Docker Deployment](#docker-deployment)
- [Local Development](#local-development)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)

## Prerequisites

- Kubernetes cluster (1.24+) with Karpenter installed
- `kubectl` configured with cluster access
- Helm 3.x (for Helm deployment)
- Docker (for Docker deployment)
- (Optional) Ollama instance for AI explanations
- (Optional) IRSA (IAM Roles for Service Accounts) configured for EKS clusters - see [IRSA Setup Guide](irsa-setup.md)

## Helm Deployment (Recommended)

### Quick Start

```bash
# Add Helm repository (when published)
helm repo add karpenter-optimizer https://charts.karpenter-optimizer.io
helm repo update

# Install
helm install karpenter-optimizer karpenter-optimizer/karpenter-optimizer \
  --namespace karpenter-optimizer \
  --create-namespace
```

### From Local Chart

```bash
# Install from local chart
helm install karpenter-optimizer ./charts/karpenter-optimizer \
  --namespace karpenter-optimizer \
  --create-namespace
```

### Configuration

See [values.yaml](../charts/karpenter-optimizer/values.yaml) for all configuration options.

**Key Configuration Options**:

```yaml
config:
  # Kubernetes configuration (leave empty for in-cluster)
  kubeconfigPath: ""
  kubeContext: ""
  
  # API server port
  port: "8080"
  
  # Ollama configuration (optional)
  ollamaURL: "http://localhost:11434"
  ollamaModel: "gemma2:2b"

frontend:
  enabled: true  # Deploy frontend as sidecar
  nginxConfig: true  # Enable Nginx proxy for /api/*

ingress:
  enabled: true
  className: "nginx"
  hosts:
    - host: karpenter-optimizer.example.com
      paths:
        - path: /
          pathType: Prefix
```

### Custom Values

```bash
# Install with custom values
helm install karpenter-optimizer ./charts/karpenter-optimizer \
  --namespace karpenter-optimizer \
  --create-namespace \
  --set config.ollamaURL=http://ollama:11434 \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=optimizer.example.com
```

### Upgrade

```bash
helm upgrade karpenter-optimizer ./charts/karpenter-optimizer \
  --namespace karpenter-optimizer
```

### Uninstall

```bash
helm uninstall karpenter-optimizer --namespace karpenter-optimizer
```

## Docker Deployment

### Backend Only

```bash
docker run -d \
  --name karpenter-optimizer-api \
  -p 8080:8080 \
  -v ~/.kube/config:/root/.kube/config:ro \
  -e KUBECONFIG=/root/.kube/config \
  ghcr.io/kaskol10/karpenter-optimizer:latest
```

### With Frontend (Docker Compose)

```bash
# Use docker-compose.yml
docker-compose up -d
```

### Environment Variables

- `KUBECONFIG`: Path to kubeconfig file (default: `~/.kube/config`)
- `KUBE_CONTEXT`: Kubernetes context name (optional)
- `PORT`: API server port (default: `8080`)
- `OLLAMA_URL`: Ollama instance URL (optional)
- `OLLAMA_MODEL`: Ollama model name (default: `granite4:latest`)

## Local Development

### Backend

```bash
# Install dependencies
go mod download

# Run API server
go run ./cmd/api

# Or use Makefile
make run-backend
```

### Frontend

```bash
cd frontend

# Install dependencies
npm install

# Start development server
npm start

# Or use Makefile
make run-frontend
```

### Access

- Backend API: `http://localhost:8080`
- Frontend UI: `http://localhost:3000`
- Swagger UI: `http://localhost:8080/api/swagger/index.html`

## Configuration

### In-Cluster Configuration

When running inside Kubernetes, the application automatically uses:
- ServiceAccount credentials
- In-cluster Kubernetes API endpoint
- No kubeconfig needed

**Leave these empty in values.yaml**:
```yaml
config:
  kubeconfigPath: ""
  kubeContext: ""
```

### Out-of-Cluster Configuration

For local development or external deployment:
```yaml
config:
  kubeconfigPath: "/path/to/kubeconfig"
  kubeContext: "my-context"
```

### RBAC Requirements

The application needs read access to:
- NodePools (karpenter.sh API)
- Nodes
- Pods

See `charts/karpenter-optimizer/templates/rbac.yaml` for the default RBAC configuration.

### AWS Pricing API

The application uses AWS Pricing API for cost calculations. The pricing API uses a public endpoint and doesn't require authentication, but **IRSA (IAM Roles for Service Accounts) is recommended** for EKS clusters to follow AWS security best practices.

**For EKS clusters (Recommended)**:
1. Set up IRSA following the [IRSA Setup Guide](irsa-setup.md)
2. Configure the service account annotation in Helm values:
   ```yaml
   serviceAccount:
     annotations:
       eks.amazonaws.com/role-arn: arn:aws:iam::ACCOUNT_ID:role/karpenter-optimizer-role
   ```

**For non-EKS clusters or local development**:
- The application will work without AWS credentials (uses public pricing endpoint)
- Falls back to hardcoded pricing map if API is unavailable
- Recommendations still work but may be less accurate without API access

### Ollama Integration

Ollama is optional but enhances recommendations with AI explanations.

**To enable Ollama**:
1. Deploy Ollama instance (can be in same cluster)
2. Configure `config.ollamaURL` in values.yaml
3. Ensure network connectivity between pods

## Troubleshooting

### Pod Not Starting

```bash
# Check pod logs
kubectl logs -n karpenter-optimizer deployment/karpenter-optimizer

# Check pod status
kubectl describe pod -n karpenter-optimizer -l app=karpenter-optimizer
```

### Cannot Connect to Kubernetes

```bash
# Verify kubeconfig
kubectl get nodes

# Check RBAC permissions
kubectl auth can-i get nodepools --all-namespaces
kubectl auth can-i get nodes --all-namespaces
kubectl auth can-i get pods --all-namespaces
```

### Frontend Not Loading

```bash
# Check frontend container logs
kubectl logs -n karpenter-optimizer deployment/karpenter-optimizer -c frontend

# Verify ingress configuration
kubectl describe ingress -n karpenter-optimizer
```

### API Errors

```bash
# Check backend logs
kubectl logs -n karpenter-optimizer deployment/karpenter-optimizer -c karpenter-optimizer

# Test health endpoint
curl http://localhost:8080/api/v1/health
```

### Common Issues

1. **"No NodePools found"**: Ensure Karpenter is installed and NodePools exist
2. **"Cannot fetch pricing"**: Check AWS credentials or use fallback pricing
3. **"Ollama connection failed"**: Verify Ollama URL and network connectivity
4. **"Ingress not working"**: Check ingress controller and path configuration

For more troubleshooting, see [TROUBLESHOOTING.md](../TROUBLESHOOTING.md).

## Production Considerations

### Resource Limits

Configure appropriate resource limits:
```yaml
resources:
  limits:
    cpu: 500m
    memory: 512Mi
  requests:
    cpu: 100m
    memory: 128Mi
```

### High Availability

- Deploy multiple replicas
- Use PodDisruptionBudget
- Configure HorizontalPodAutoscaler if needed

### Security

- Use non-root user
- Enable security contexts
- Restrict RBAC permissions
- Use network policies if needed
- Enable TLS for ingress

### Monitoring

- Enable ServiceMonitor for Prometheus
- Set up alerts for health endpoint
- Monitor resource usage
- Track API response times

## Next Steps

- [Quick Start Guide](../QUICKSTART.md) - Get started in minutes
- [Architecture](architecture.md) - Understand the system
- [API Reference](api-reference.md) - API documentation
- [Contributing](../CONTRIBUTING.md) - Contribute to the project

