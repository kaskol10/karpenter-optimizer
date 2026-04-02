package history

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/karpenter-optimizer/internal/recommender"
)

type CostRecord struct {
	Timestamp       time.Time `json:"timestamp"`
	ClusterName     string    `json:"clusterName"`
	NodePoolName    string    `json:"nodePoolName"`
	CurrentCost     float64   `json:"currentCost"`
	RecommendedCost float64   `json:"recommendedCost"`
	Savings         float64   `json:"savings"`
	SavingsPercent  float64   `json:"savingsPercent"`
	InstanceTypes   []string  `json:"instanceTypes"`
	CapacityType    string    `json:"capacityType"`
	NodeCount       int       `json:"nodeCount"`
}

type CostHistory struct {
	mu      sync.RWMutex
	records []CostRecord
	maxSize int
	file    string
}

func NewCostHistory(maxSize int, file string) *CostHistory {
	h := &CostHistory{
		records: make([]CostRecord, 0),
		maxSize: maxSize,
		file:    file,
	}

	h.load()

	return h
}

func (h *CostHistory) load() {
	if h.file == "" {
		return
	}

	data, err := os.ReadFile(h.file)
	if err != nil {
		return
	}

	if err := json.Unmarshal(data, &h.records); err != nil {
		fmt.Printf("Warning: failed to load cost history: %v\n", err)
	}
}

func (h *CostHistory) save() {
	if h.file == "" {
		return
	}

	data, err := json.MarshalIndent(h.records, "", "  ")
	if err != nil {
		fmt.Printf("Warning: failed to save cost history: %v\n", err)
		return
	}

	if err := os.WriteFile(h.file, data, 0644); err != nil {
		fmt.Printf("Warning: failed to write cost history: %v\n", err)
	}
}

func (h *CostHistory) Add(record CostRecord) {
	h.mu.Lock()
	defer h.mu.Unlock()

	h.records = append(h.records, record)

	if len(h.records) > h.maxSize {
		h.records = h.records[len(h.records)-h.maxSize:]
	}

	h.save()
}

func (h *CostHistory) AddFromRecommendations(clusterName string, recommendations []recommender.NodePoolRecommendation) {
	for _, rec := range recommendations {
		record := CostRecord{
			Timestamp:       time.Now(),
			ClusterName:     clusterName,
			NodePoolName:    rec.Name,
			CurrentCost:     rec.CurrentState.EstimatedCost,
			RecommendedCost: rec.EstimatedCost,
		}

		if rec.CurrentState != nil && rec.CurrentState.EstimatedCost > 0 {
			record.Savings = rec.CurrentState.EstimatedCost - rec.EstimatedCost
			record.SavingsPercent = (record.Savings / rec.CurrentState.EstimatedCost) * 100
		}

		if rec.CurrentState != nil {
			record.InstanceTypes = rec.CurrentState.InstanceTypes
			record.CapacityType = rec.CurrentState.CapacityType
			record.NodeCount = rec.CurrentState.TotalNodes
		}

		h.Add(record)
	}
}

func (h *CostHistory) Get(since time.Time) []CostRecord {
	h.mu.RLock()
	defer h.mu.RUnlock()

	result := make([]CostRecord, 0)
	for _, record := range h.records {
		if record.Timestamp.After(since) {
			result = append(result, record)
		}
	}

	return result
}

func (h *CostHistory) GetByNodePool(nodePoolName string, since time.Time) []CostRecord {
	h.mu.RLock()
	defer h.mu.RUnlock()

	result := make([]CostRecord, 0)
	for _, record := range h.records {
		if record.NodePoolName == nodePoolName && record.Timestamp.After(since) {
			result = append(result, record)
		}
	}

	return result
}

func (h *CostHistory) GetTotalSavings(since time.Time) float64 {
	h.mu.RLock()
	defer h.mu.RUnlock()

	var total float64
	for _, record := range h.records {
		if record.Timestamp.After(since) {
			total += record.Savings
		}
	}

	return total
}

func (h *CostHistory) GetSummary(since time.Time) map[string]interface{} {
	h.mu.RLock()
	defer h.mu.RUnlock()

	records := h.Get(since)

	totalCurrentCost := 0.0
	totalRecommendedCost := 0.0
	totalSavings := 0.0
	nodePools := make(map[string]bool)

	for _, record := range records {
		totalCurrentCost += record.CurrentCost
		totalRecommendedCost += record.RecommendedCost
		totalSavings += record.Savings
		nodePools[record.NodePoolName] = true
	}

	savingsPercent := 0.0
	if totalCurrentCost > 0 {
		savingsPercent = (totalSavings / totalCurrentCost) * 100
	}

	return map[string]interface{}{
		"period":               since.Format(time.RFC3339),
		"totalRecords":         len(records),
		"uniqueNodePools":      len(nodePools),
		"totalCurrentCost":     totalCurrentCost,
		"totalRecommendedCost": totalRecommendedCost,
		"totalSavings":         totalSavings,
		"savingsPercent":       savingsPercent,
		"annualSavings":        totalSavings * 24 * 365,
	}
}

func (h *CostHistory) RunPeriodicSnapshot(ctx context.Context, interval time.Duration, snapshotFunc func() []recommender.NodePoolRecommendation, clusterName string) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			recommendations := snapshotFunc()
			h.AddFromRecommendations(clusterName, recommendations)
		}
	}
}
