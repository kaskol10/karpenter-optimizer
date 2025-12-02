# Karpenter Optimizer Helm Chart

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](https://github.com/kaskol10/karpenter-optimizer/blob/main/LICENSE)

This Helm chart deploys [Karpenter Optimizer](https://github.com/kaskol10/karpenter-optimizer) on a Kubernetes cluster. Karpenter Optimizer analyzes your cluster usage and provides cost-optimized NodePool recommendations.

## Prerequisites

- Kubernetes 1.20+
- Helm 3.0+
- Karpenter installed (optional, for NodePool analysis)
- RBAC permissions for reading nodes, pods, and NodePools

## Installation

### Add the Helm repository

```bash
helm repo add karpenter-optimizer https://charts.karpenter-optimizer.io
helm repo update
```

### Install the chart

```bash
helm install karpenter-optimizer karpenter-optimizer/karpenter-optimizer \
  --namespace karpenter-optimizer \
  --create-namespace
```

### Install with custom values

**With Ollama (Legacy):**
```bash
helm install karpenter-optimizer karpenter-optimizer/karpenter-optimizer \
  --namespace karpenter-optimizer \
  --create-namespace \
  --set config.ollama.enabled=true \
  --set config.ollama.url=http://ollama:11434 \
  --set config.ollama.model=granite4:latest
```

**With IRSA (IAM Roles for Service Accounts) on EKS:**
```bash
helm install karpenter-optimizer karpenter-optimizer/karpenter-optimizer \
  --namespace karpenter-optimizer \
  --create-namespace \
  --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"=arn:aws:iam::ACCOUNT_ID:role/karpenter-optimizer-role \
  --set config.aws.region=us-east-1
```

See [IRSA Setup Guide](../../docs/irsa-setup.md) for detailed instructions.

**With LiteLLM:**
```bash
helm install karpenter-optimizer karpenter-optimizer/karpenter-optimizer \
  --namespace karpenter-optimizer \
  --create-namespace \
  --set config.llm.enabled=true \
  --set config.llm.provider=litellm \
  --set config.llm.url=http://litellm-service:4000 \
  --set config.llm.model=gpt-3.5-turbo \
  --set config.llm.apiKey=your-api-key
```

## Configuration

### LLM Provider Configuration

Karpenter Optimizer supports multiple LLM providers for AI-enhanced explanations:

#### LiteLLM (Recommended)

LiteLLM provides a unified interface to multiple LLM providers (OpenAI, Anthropic, Azure OpenAI, etc.):

```yaml
config:
  llm:
    enabled: true
    provider: "litellm"
    url: "http://litellm-service:4000"
    model: "gpt-3.5-turbo"
    apiKey: "your-api-key"  # Optional, if LiteLLM requires authentication
```

#### Ollama (Legacy)

Ollama is still supported for backward compatibility:

```yaml
config:
  ollama:
    enabled: true
    url: "http://ollama-service:11434"
    model: "granite4:latest"
```

Or use the new unified LLM configuration:

```yaml
config:
  llm:
    enabled: true
    provider: "ollama"
    url: "http://ollama-service:11434"
    model: "granite4:latest"
```

### Configuration Parameters

The following table lists the configurable parameters and their default values:

| Parameter | Description | Default |
|-----------|-------------|---------|
| `replicaCount` | Number of replicas | `1` |
| `image.repository` | Image repository | `ghcr.io/kaskol10/karpenter-optimizer` |
| `image.tag` | Image tag | `""` (uses appVersion) |
| `image.pullPolicy` | Image pull policy | `IfNotPresent` |
| `service.type` | Service type | `ClusterIP` |
| `service.port` | Service port | `8080` |
| `ingress.enabled` | Enable ingress | `false` |
| `config.llm.enabled` | Enable LLM integration | `false` |
| `config.llm.provider` | LLM provider (`ollama` or `litellm`) | `ollama` |
| `config.llm.url` | LLM service URL | `""` |
| `config.llm.model` | Model name | `""` |
| `config.llm.apiKey` | API key (for LiteLLM) | `""` |
| `config.ollama.enabled` | Enable Ollama integration (legacy) | `false` |
| `config.ollama.url` | Ollama URL (legacy) | `""` |
| `config.ollama.model` | Ollama model (legacy) | `granite4:latest` |
| `config.aws.region` | AWS region | `us-east-1` |
| `resources.limits.cpu` | CPU limit | `500m` |
| `resources.limits.memory` | Memory limit | `512Mi` |
| `resources.requests.cpu` | CPU request | `100m` |
| `resources.requests.memory` | Memory request | `128Mi` |

## Values

See [values.yaml](values.yaml) for all available configuration options.

## Uninstallation

```bash
helm uninstall karpenter-optimizer --namespace karpenter-optimizer
```

## Upgrading

```bash
helm repo update
helm upgrade karpenter-optimizer karpenter-optimizer/karpenter-optimizer \
  --namespace karpenter-optimizer
```

## Troubleshooting

### Check pod status

```bash
kubectl get pods -n karpenter-optimizer
```

### View logs

```bash
kubectl logs -n karpenter-optimizer -l app.kubernetes.io/name=karpenter-optimizer
```

### Check service

```bash
kubectl get svc -n karpenter-optimizer
```

## RBAC

The chart creates a ClusterRole and ClusterRoleBinding with the following permissions:

- Read nodes, pods, namespaces
- Read Karpenter NodePools
- Read events and PodDisruptionBudgets

## Security

- Runs as non-root user (UID 1000)
- Read-only root filesystem
- Dropped capabilities
- Pod Security Context configured

## Additional Resources

- [Karpenter Optimizer Documentation](https://github.com/kaskol10/karpenter-optimizer#readme)
- [Contributing Guide](https://github.com/kaskol10/karpenter-optimizer/blob/main/CONTRIBUTING.md)
- [Security Policy](https://github.com/kaskol10/karpenter-optimizer/blob/main/SECURITY.md)

## Support

For issues and questions:
- 🐛 [Open an Issue](https://github.com/kaskol10/karpenter-optimizer/issues)
- 💬 [Start a Discussion](https://github.com/kaskol10/karpenter-optimizer/discussions)
- 📖 [Read the Docs](https://github.com/kaskol10/karpenter-optimizer#readme)

