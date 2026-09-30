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

	pods, err := s.k8sClient.FindLLMPods(ctx)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	var health []llmhealth.PodHealth
	for _, p := range pods {
		health = append(health, servingProber.Probe(ctx, p.Namespace, p.Name, p.IP, p.Port))
	}
	storeServingCache(health)
	c.JSON(200, gin.H{"pods": health})
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
