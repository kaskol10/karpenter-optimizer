package api

import (
	"context"
	"os"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/karpenter-optimizer/internal/history"
)

const (
	defaultHistoryInterval = 60 * time.Second
	defaultHistoryWindow   = 6 * time.Hour
	maxHistoryWindow       = 24 * time.Hour
)

// startHistorySampler launches a background goroutine that samples cluster
// resource usage into the history store. The goroutine exits when ctx is
// cancelled. It is a no-op when there is no k8s client.
func (s *Server) startHistorySampler(ctx context.Context) {
	if s.k8sClient == nil || s.historyStore == nil {
		return
	}
	interval := historyIntervalFromEnv()

	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		// Sample once immediately so the sparkline has a first point.
		s.sampleCluster()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				s.sampleCluster()
			}
		}
	}()
}

func historyIntervalFromEnv() time.Duration {
	if secs := historyEnvInt("HISTORY_INTERVAL_SECS"); secs > 0 {
		return time.Duration(secs) * time.Second
	}
	return defaultHistoryInterval
}

// historyWindowFromEnv reads HISTORY_WINDOW_HOURS (default 6, max 24).
func historyWindowFromEnv() time.Duration {
	if h := historyEnvInt("HISTORY_WINDOW_HOURS"); h > 0 {
		d := time.Duration(h) * time.Hour
		if d > maxHistoryWindow {
			return maxHistoryWindow
		}
		return d
	}
	return defaultHistoryWindow
}

func historyEnvInt(key string) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return 0
}

// sampleCluster fetches node usage, aggregates cluster-wide, and appends a
// history point. Errors are logged (via debugLog) and skipped.
func (s *Server) sampleCluster() {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	nodes, err := s.k8sClient.GetAllNodesWithUsage(ctx)
	if err != nil {
		debugLog(s.config.Debug, "history sampler: failed to get nodes: %v\n", err)
		return
	}

	var totalCPUUsed, totalCPUAllocatable float64
	var totalMemUsed, totalMemAllocatable float64
	var totalGPUMem, totalGPUMemAllocated float64
	var totalGPUCapacity, totalGPUAllocated float64
	var totalPods int
	for _, n := range nodes {
		totalPods += n.PodCount
		if n.CPUUsage != nil {
			totalCPUUsed += n.CPUUsage.Used
			totalCPUAllocatable += n.CPUUsage.Allocatable
		}
		if n.MemoryUsage != nil {
			totalMemUsed += n.MemoryUsage.Used
			totalMemAllocatable += n.MemoryUsage.Allocatable
		}
		totalGPUMem += n.GPUMemTotalMiB
		totalGPUMemAllocated += n.GPUMemAllocatedMiB
		totalGPUCapacity += n.GPUCapacity
		totalGPUAllocated += n.GPUAllocated
	}

	// Cluster cost (hourly). Reuses the recommender's cached pricing, so this
	// is cheap once the AWS Pricing API results are cached.
	var costPerHour float64
	if s.recommender != nil {
		for _, n := range nodes {
			if n.InstanceType == "" {
				continue
			}
			capacityType := n.CapacityType
			if capacityType != "spot" {
				capacityType = "on-demand"
			}
			pricingResult, _ := s.recommender.EstimateCostWithSource(ctx, []string{n.InstanceType}, capacityType, 1)
			costPerHour += pricingResult.Cost
		}
	}

	s.historyStore.Add(history.Point{
		T:                 time.Now().Format(time.RFC3339),
		Unix:              time.Now().Unix(),
		CPUUsed:           totalCPUUsed,
		CPUAllocatable:    totalCPUAllocatable,
		MemoryUsed:        totalMemUsed,
		MemoryAllocatable: totalMemAllocatable,
		GPUMemUsedMiB:     totalGPUMemAllocated,
		GPUMemTotalMiB:    totalGPUMem,
		GPUCapacity:       totalGPUCapacity,
		GPUAllocated:      totalGPUAllocated,
		Nodes:             len(nodes),
		Pods:              totalPods,
		CostUSDPerHour:    costPerHour,
	})
}

// getHistory returns the cluster resource trend series for the requested
// window (e.g. ?window=6h). Defaults to 6h, capped at 24h.
func (s *Server) getHistory(c *gin.Context) {
	window := parseHistoryWindow(c.Query("window"))
	c.JSON(200, gin.H{
		"window": window.String(),
		"points": s.historyStore.Series(window),
	})
}

func parseHistoryWindow(raw string) time.Duration {
	if raw == "" {
		return defaultHistoryWindow
	}
	// Accept "Nh"/"Ns" durations or plain seconds.
	if d, err := time.ParseDuration(raw); err == nil && d > 0 {
		if d > maxHistoryWindow {
			return maxHistoryWindow
		}
		return d
	}
	if secs, err := strconv.Atoi(raw); err == nil && secs > 0 {
		d := time.Duration(secs) * time.Second
		if d > maxHistoryWindow {
			return maxHistoryWindow
		}
		return d
	}
	return defaultHistoryWindow
}
