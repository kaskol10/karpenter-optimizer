package api

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/karpenter-optimizer/internal/servingdurable"
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
	// Publish the same probe results to the /metrics snapshot (no-op when disabled).
	s.recordServingMetrics(health)
	// Append the same samples to the durable store (no-op when not configured).
	s.appendServingDurable(health)
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
	durable := s.servingDurableStore != nil
	window := parseServingHistoryWindow(c.Query("window"), durable)

	kvThreshold := 85.0
	durableRows, podsFromDurable := s.durableServingSeries(window)
	pods := s.servingHistoryStore.Pods()
	if len(podsFromDurable) > 0 {
		known := make(map[string]bool, len(pods))
		for _, k := range pods {
			known[k] = true
		}
		for k := range podsFromDurable {
			if !known[k] {
				pods = append(pods, k)
			}
		}
	}
	out := make([]servingHistoryEntry, 0, len(pods))
	for _, k := range pods {
		var namespace, name string
		if i := strings.IndexByte(k, '/'); i >= 0 {
			namespace = k[:i]
			name = k[i+1:]
		} else {
			name = k
		}
		var points []servinghistory.Point
		if durable {
			points = mergeServingHistory(durableRows[k], s.servingHistoryStore.Series(namespace, name, window), time.Now().Add(-window))
		} else {
			points = s.servingHistoryStore.Series(namespace, name, window)
		}
		out = append(out, servingHistoryEntry{
			Namespace: namespace,
			Name:      name,
			Window:    window.String(),
			Points:    points,
			LastIssue: servinghistory.LastIssueIn(points, kvThreshold),
		})
	}

	c.JSON(http.StatusOK, gin.H{
		"window": window.String(),
		"pods":   out,
	})
}

// durableServingSeries fetches the durable store's rows for the window (nil
// maps when the store is off or the query fails — callers fall back to the
// in-memory series).
func (s *Server) durableServingSeries(window time.Duration) (map[string][]servingdurable.Point, map[string]bool) {
	if s.servingDurableStore == nil {
		return nil, nil
	}
	rows, err := s.servingDurableStore.Query(time.Now().Add(-window))
	if err != nil {
		debugLog(s.config.Debug, "serving durable history: query: %v\n", err)
		return nil, nil
	}
	pods := make(map[string]bool, len(rows))
	for k := range rows {
		pods[k] = true
	}
	return rows, pods
}

type servingHistoryEntry struct {
	Namespace string                 `json:"namespace"`
	Name      string                 `json:"name"`
	Window    string                 `json:"window"`
	Points    []servinghistory.Point `json:"points"`
	LastIssue int64                  `json:"lastIssue"` // Unix seconds; 0 = none in window
}
