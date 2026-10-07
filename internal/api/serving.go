package api

import (
	"context"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/karpenter-optimizer/internal/llmhealth"
)

const servingCacheTTL = 15 * time.Second

var (
	servingProber    = llmhealth.NewProber()
	servingCacheMu   sync.Mutex
	servingCacheLast time.Time
	servingCachePods []llmhealth.PodHealth
)

// getServing lists LLM serving pods (vLLM/sglang) and probes each for
// inference health. Results are cached for 15s to bound probe load.
func (s *Server) getServing(c *gin.Context) {
	if s.k8sClient == nil {
		c.JSON(503, gin.H{"error": "Kubernetes client not configured"})
		return
	}

	if pods, ok := servingCache(); ok {
		c.JSON(200, gin.H{"pods": pods})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 60*time.Second)
	defer cancel()

	health, err := s.probeServingPods(ctx)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	storeServingCache(health)
	c.JSON(200, gin.H{"pods": health})
}

// probeServingPods discovers LLM serving pods, probes each one, and enriches
// the result with node placement (instance type, GPU model/count). Shared by
// the on-demand endpoint and the serving history sampler.
func (s *Server) probeServingPods(ctx context.Context) ([]llmhealth.PodHealth, error) {
	pods, err := s.k8sClient.FindLLMPods(ctx)
	if err != nil {
		return nil, err
	}

	var health []llmhealth.PodHealth
	for _, p := range pods {
		h := servingProber.Probe(ctx, p.Namespace, p.Name, p.IP, p.Port)
		h.Node = p.NodeName
		// Surface the physical GPU cards (HAMi/KAI annotation) so the UI can
		// show which specific card(s) each model occupies.
		if len(p.GPUDevices) > 0 {
			devices := make([]llmhealth.GPUDevice, len(p.GPUDevices))
			for j, d := range p.GPUDevices {
				devices[j] = llmhealth.GPUDevice{UUID: d.UUID, Model: d.Model, MemoryMiB: d.MemoryMiB, Index: d.Index}
			}
			h.GPUDevices = devices
		}
		health = append(health, h)
	}

	if len(health) > 0 {
		nodeNames := make([]string, 0, len(health))
		seen := make(map[string]bool, len(health))
		for _, h := range health {
			if h.Node != "" && !seen[h.Node] {
				seen[h.Node] = true
				nodeNames = append(nodeNames, h.Node)
			}
		}
		if placements, perr := s.k8sClient.GetNodePlacement(ctx, nodeNames); perr == nil {
			for i := range health {
				if p, ok := placements[health[i].Node]; ok {
					health[i].NodeHostname = p.Hostname
					health[i].NodeInstanceType = p.InstanceType
					health[i].GPUModel = p.GPUModel
					health[i].GPUCapacity = p.GPUCapacity
				}
			}
		}
	}
	return health, nil
}

func servingCache() ([]llmhealth.PodHealth, bool) {
	servingCacheMu.Lock()
	defer servingCacheMu.Unlock()
	if time.Since(servingCacheLast) < servingCacheTTL && servingCachePods != nil {
		return servingCachePods, true
	}
	return nil, false
}

func storeServingCache(pods []llmhealth.PodHealth) {
	servingCacheMu.Lock()
	defer servingCacheMu.Unlock()
	servingCacheLast = time.Now()
	servingCachePods = pods
}
