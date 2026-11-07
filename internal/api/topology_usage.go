package api

import (
	"time"

	"github.com/karpenter-optimizer/internal/config"
	"github.com/karpenter-optimizer/internal/kubernetes"
	"github.com/karpenter-optimizer/internal/usage"
)

// usageCacheTTL bounds how often usage sources are queried, however busy the
// Topology tab is.
const usageCacheTTL = 60 * time.Second

// newUsageCollector builds the usage sources in preference order: Prometheus
// (p95 over 24h, plus DCGM GPU memory) when PROMETHEUS_URL is set, then
// metrics-server (live). nil without a Kubernetes client.
func newUsageCollector(cfg *config.Config, k8s *kubernetes.Client) *usage.Collector {
	if k8s == nil {
		return nil
	}
	var providers []usage.Provider
	if cfg.PrometheusURL != "" {
		providers = append(providers, usage.NewPrometheus(cfg.PrometheusURL))
	}
	providers = append(providers, &usage.MetricsServer{Get: k8s.RawGet})
	return usage.NewCollector(usageCacheTTL, providers...)
}

// attachTopologyUsage sets each pod's Usage from a snapshot. A nil snapshot
// (no usage source) leaves every pod without usage.
func attachTopologyUsage(nodes []TopologyNode, snap *usage.Snapshot) {
	if snap == nil {
		return
	}
	for i := range nodes {
		for j := range nodes[i].Pods {
			p := &nodes[i].Pods[j]
			if u, ok := snap.Pods[p.Namespace+"/"+p.Name]; ok {
				p.Usage = &u
			}
		}
	}
}

// gpuUsageOf returns GPU memory in use per card UUID (MiB), or nil.
func gpuUsageOf(snap *usage.Snapshot) map[string]float64 {
	if snap == nil || len(snap.GPUs) == 0 {
		return nil
	}
	return snap.GPUs
}
