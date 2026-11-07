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

**With AWS Bedrock (via IRSA):**
```bash
helm install karpenter-optimizer karpenter-optimizer/karpenter-optimizer \
  --namespace karpenter-optimizer \
  --create-namespace \
  --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"=arn:aws:iam::ACCOUNT_ID:role/karpenter-optimizer-role \
  --set config.llm.enabled=true \
  --set config.llm.provider=bedrock \
  --set config.llm.model=eu.anthropic.claude-3-haiku-20240307-v1:0
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

#### AWS Bedrock

The `bedrock` provider calls the Bedrock Converse API and signs requests with
SigV4 via the AWS default credential chain (e.g. IRSA on EKS), so it needs no
URL or API key — just `bedrock:InvokeModel` /
`bedrock:InvokeModelWithResponseStream` permissions on the role and a model or
inference profile ID:

```yaml
config:
  llm:
    enabled: true
    provider: "bedrock"
    model: "eu.anthropic.claude-3-haiku-20240307-v1:0"
    # awsRegion: "eu-central-1"  # only if Bedrock lives in a different region
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

### Monitoring (Prometheus)

The backend can serve Prometheus gauges at `/metrics` (opt-in). The exporter
reads an atomic snapshot refreshed by the samplers the app already runs, so a
scrape makes **no extra Kubernetes or AWS pricing API calls**. Off by default;
`/metrics` 404s when disabled.

```yaml
metrics:
  enabled: true
serviceMonitor:            # only for the Prometheus Operator
  enabled: true
  interval: 30s
```

Exposed metrics (prefix `karpenter_optimizer_`): `up`,
`kubernetes_connected`, `karpenter_detected`; cluster gauges (`cluster_nodes`,
`cluster_pods`, `cluster_cpu_used` / `cluster_cpu_allocatable` in cores,
`cluster_memory_used` / `cluster_memory_allocatable` in GiB,
`cluster_cost_per_hour` in the configured region's currency,
`cluster_power_watts`); per-NodePool `nodepool_nodes` /
`nodepool_cost_per_hour` (`nodepool` label); serving pods
(`serving_pod_online`, `serving_kv_cache_pct`, `serving_ttft_p95_seconds`,
`serving_e2e_p95_seconds`, `serving_tokens_per_second`,
`serving_requests_per_second` — labels `namespace`, `pod`, `model`); LiteLLM
gateway (`gateway_pods`, `gateway_online`, `gateway_in_flight_requests`,
`gateway_admission_queued`, `gateway_admission_rejected_total`,
`gateway_error_rate_pct`, `gateway_requests_per_second`,
`gateway_spend_total`, `gateway_app_spend_total` with an `app` label); and
disruptions (`disruptions_active`, `disruptions_blocked`,
`disruptions_cost_per_hour`, plus per-node `disruption_cost_per_hour` with
`node` / `nodepool` labels).

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
| `config.llm.provider` | LLM provider (`ollama`, `litellm` or `bedrock`) | `ollama` |
| `config.llm.url` | LLM service URL (not used for Bedrock) | `""` |
| `config.llm.model` | Model name (for Bedrock: a model or inference profile ID) | `""` |
| `config.llm.apiKey` | API key (for LiteLLM; not used for Bedrock) | `""` |
| `config.llm.awsRegion` | AWS region for Bedrock, if different from the default region | `""` |
| `config.llm.maxTokens` | Response token cap for Bedrock (optional; bounds worst-case cost, unset = model default) | `""` |
| `config.ollama.enabled` | Enable Ollama integration (legacy) | `false` |
| `config.ollama.url` | Ollama URL (legacy) | `""` |
| `config.ollama.model` | Ollama model (legacy) | `granite4:latest` |
| `config.aws.region` | AWS region | `us-east-1` |
| `alerts.enabled` | Enable the alerting engine (evaluates conditions each sampler tick; channels via `alerts.urls` or the `/api/v1/alerts/config` API) | `false` |
| `alerts.urls` | Comma-separated channels, each `type=url` (type one of `ntfy`/`discord`/`slack`/`webhook`; a bare URL is a webhook). URLs are secrets — keep out of values for prod | `""` |
| `alerts.stateFile` | Where the alert state machine persists (survives restart) | `/tmp/alerts/alerts.json` |
| `metrics.enabled` | Enable the Prometheus `/metrics` exporter (served from already-sampled data; zero extra cluster calls) | `false` |
| `servingHistory.durable` | Enable durable serving-history storage in the shared CNPG instance (requires `database.enabled`; adds the 7d trend window). Without it, serving history is in-memory and capped at the 24h window | `false` |
| `servingHistory.retentionHours` | Retention for raw serving samples (`SERVING_HISTORY_RETENTION_HOURS`) | `168` |
| `placementHistory.hours` | Topology time-travel window (`PLACEMENT_HISTORY_HOURS`, max 72, `0` = off). Saved in the shared CNPG instance when `database.enabled`, so it survives restarts | `24` |
| `placementHistory.intervalSeconds` | How often placement is sampled (`PLACEMENT_HISTORY_INTERVAL_SECS`, min 30) | `120` |
| `serviceMonitor.enabled` | Create a Prometheus Operator `ServiceMonitor` for `/metrics` (only rendered when `metrics.enabled`) | `false` |
| `serviceMonitor.interval` | Scrape interval | `30s` |
| `serviceMonitor.scrapeTimeout` | Scrape timeout | `10s` |
| `database.enabled` | Provision a CNPG `PostgresCluster` for durable LiteLLM gateway cost history (requires the CNPG operator installed). `false` = in-memory history that resets on restart | `false` |
| `database.cluster.name` | CNPG cluster / service name (and credentials-secret name base) | `karpenter-optimizer-history` |
| `database.cluster.postgresImage.repository` | Postgres image | `ghcr.io/cloudnative-pg/postgresql` |
| `database.cluster.postgresImage.tag` | Postgres image tag | `16.4` |
| `database.cluster.database` | Database name | `karpenter_optimizer` |
| `database.cluster.user` | Owner user | `gateway_history` |
| `database.cluster.retentionHours` | Cost-history retention in hours (`GATEWAY_HISTORY_RETENTION_HOURS`) | `720` |
| `database.cluster.storage.size` | Data volume size | `10Gi` |
| `database.cluster.storage.storageClass` | Storage class (empty = cluster default) | `""` |
| `resources.limits.cpu` | CPU limit | `500m` |
| `resources.limits.memory` | Memory limit | `512Mi` |
| `resources.requests.cpu` | CPU request | `100m` |
| `resources.requests.memory` | Memory request | `128Mi` |
| `frontend.nginxConnectTimeout` | Nginx proxy connect timeout | `60s` |
| `frontend.nginxSendTimeout` | Nginx proxy send timeout | `60s` |
| `frontend.nginxReadTimeout` | Nginx proxy read timeout (should be >= backend timeout) | `120s` |

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

