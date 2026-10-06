package api

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/karpenter-optimizer/internal/servinghistory"
)

// startServingHistorySampler launches a background goroutine that probes LLM
// serving pods on the history interval and records a per-pod sample into the
// serving history store. It is a no-op when there is no k8s client or no
// serving history store. It runs on the same interval as the cluster sampler.
func (s *Server) startServingHistorySampler(ctx context.Context) {
	if s.k8sClient == nil || s.servingHistoryStore == nil {
		return
	}
	interval := historyIntervalFromEnv()

	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		// Sample once immediately so the sparkline has a first point.
		s.sampleServing()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				s.sampleServing()
			}
		}
	}()
}

// sampleServing probes each LLM serving pod and appends a serving-history
// sample. Errors are logged and skipped so a transient probe failure never
// aborts the sampler.
func (s *Server) sampleServing() {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	health, err := s.probeServingPods(ctx)
	if err != nil {
		debugLog(s.config.Debug, "serving sampler: failed to probe pods: %v\n", err)
		return
	}
	for _, h := range health {
		s.servingHistoryStore.Add(h.Namespace, h.Name, servinghistory.Point{
			T:              time.Now().Format(time.RFC3339),
			Unix:           time.Now().Unix(),
			Online:         h.Online,
			KVCachePercent: h.KVCachePercent,
			Running:        h.Running,
			Waiting:        h.Waiting,
			Preemptions:    h.Preemptions,
			TTFTSeconds:    h.TTFTSeconds,
			TTFTP95Seconds: h.TTFTP95Seconds,
			E2ESeconds:     h.E2ESeconds,
			E2EP95Seconds:  h.E2EP95Seconds,
			TokensPerSec:   h.TokensPerSec,
			RequestsPerSec: h.RequestsPerSec,
		})
	}
}

// getServingHistory returns the per-pod serving trend series for the
// requested window (e.g. ?window=6h), plus the last time each known pod was
// observed unhealthy. Defaults to 6h, capped at 24h.
func (s *Server) getServingHistory(c *gin.Context) {
	window := parseHistoryWindow(c.Query("window"))

	kvThreshold := 85.0
	pods := s.servingHistoryStore.Pods()
	out := make([]servingHistoryEntry, 0, len(pods))
	for _, k := range pods {
		var namespace, name string
		if i := strings.IndexByte(k, '/'); i >= 0 {
			namespace = k[:i]
			name = k[i+1:]
		} else {
			name = k
		}
		out = append(out, servingHistoryEntry{
			Namespace: namespace,
			Name:      name,
			Window:    window.String(),
			Points:    s.servingHistoryStore.Series(namespace, name, window),
			LastIssue: s.servingHistoryStore.LastIssue(namespace, name, window, kvThreshold),
		})
	}

	c.JSON(http.StatusOK, gin.H{
		"window": window.String(),
		"pods":   out,
	})
}

type servingHistoryEntry struct {
	Namespace string                 `json:"namespace"`
	Name      string                 `json:"name"`
	Window    string                 `json:"window"`
	Points    []servinghistory.Point `json:"points"`
	LastIssue int64                  `json:"lastIssue"` // Unix seconds; 0 = none in window
}
