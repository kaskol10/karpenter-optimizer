package recommender

import (
	"fmt"
	"math"
	"strconv"
	"strings"

	"github.com/karpenter-optimizer/internal/config"
)

type Recommender struct {
	config *config.Config
}

func NewRecommender(cfg *config.Config) *Recommender {
	return &Recommender{
		config: cfg,
	}
}

type Workload struct {
	Name      string
	Namespace string
	CPU       string // e.g., "100m", "2", "1.5"
	Memory    string // e.g., "128Mi", "2Gi", "4G"
	GPU       int
	Labels    map[string]string
}

type NodePoolRecommendation struct {
	Name              string            `json:"name"`
	InstanceTypes     []string          `json:"instanceTypes"`
	CapacityType      string            `json:"capacityType"` // spot, on-demand
	Architecture      string            `json:"architecture"`  // amd64, arm64
	MinSize           int               `json:"minSize"`
	MaxSize           int               `json:"maxSize"`
	Labels            map[string]string `json:"labels"`
	Requirements      Requirements      `json:"requirements"`
	EstimatedCost     float64           `json:"estimatedCost"`
	Reasoning         string            `json:"reasoning"`
	WorkloadsMatched  []string          `json:"workloadsMatched"`
}

type Requirements struct {
	CPU    ResourceRange `json:"cpu"`
	Memory ResourceRange `json:"memory"`
	GPU    int           `json:"gpu"`
}

type ResourceRange struct {
	Min string `json:"min"`
	Max string `json:"max"`
}

func (r *Recommender) Analyze(workloads []Workload) []NodePoolRecommendation {
	if len(workloads) == 0 {
		return []NodePoolRecommendation{}
	}
	
	// Group workloads by similar characteristics
	groups := r.groupWorkloads(workloads)
	
	var recommendations []NodePoolRecommendation
	
	for i, group := range groups {
		rec := r.generateRecommendationForGroup(group, i+1)
		recommendations = append(recommendations, rec)
	}
	
	return recommendations
}

func (r *Recommender) GetRecommendations(namespace string) ([]NodePoolRecommendation, error) {
	// This would typically fetch workloads from Kubernetes API
	// For now, return empty or use mock data
	return []NodePoolRecommendation{}, nil
}

func (r *Recommender) GenerateRecommendations(namespace string) ([]NodePoolRecommendation, error) {
	// This would fetch workloads from Kubernetes and generate recommendations
	// For now, return empty
	return []NodePoolRecommendation{}, nil
}

func (r *Recommender) groupWorkloads(workloads []Workload) [][]Workload {
	// Simple grouping: by GPU requirement, then by size
	var gpuGroups [][]Workload
	var nonGpuGroups []Workload
	
	for _, w := range workloads {
		if w.GPU > 0 {
			// Find matching GPU group or create new one
			found := false
			for i := range gpuGroups {
				if len(gpuGroups[i]) > 0 && gpuGroups[i][0].GPU == w.GPU {
					gpuGroups[i] = append(gpuGroups[i], w)
					found = true
					break
				}
			}
			if !found {
				gpuGroups = append(gpuGroups, []Workload{w})
			}
		} else {
			nonGpuGroups = append(nonGpuGroups, w)
		}
	}
	
	var groups [][]Workload
	groups = append(groups, gpuGroups...)
	
	if len(nonGpuGroups) > 0 {
		// Further group non-GPU workloads by size
		groups = append(groups, r.groupBySize(nonGpuGroups)...)
	}
	
	return groups
}

func (r *Recommender) groupBySize(workloads []Workload) [][]Workload {
	// Group by CPU/Memory size ranges
	var small, medium, large []Workload
	
	for _, w := range workloads {
		cpu := r.parseCPU(w.CPU)
		memory := r.parseMemory(w.Memory)
		
		totalSize := cpu + (memory / 4) // Rough heuristic
		
		if totalSize < 2 {
			small = append(small, w)
		} else if totalSize < 8 {
			medium = append(medium, w)
		} else {
			large = append(large, w)
		}
	}
	
	var groups [][]Workload
	if len(small) > 0 {
		groups = append(groups, small)
	}
	if len(medium) > 0 {
		groups = append(groups, medium)
	}
	if len(large) > 0 {
		groups = append(groups, large)
	}
	
	return groups
}

func (r *Recommender) generateRecommendationForGroup(group []Workload, index int) NodePoolRecommendation {
	var totalCPU, totalMemory float64
	var maxGPU int
	var workloadNames []string
	
	for _, w := range group {
		totalCPU += r.parseCPU(w.CPU)
		totalMemory += r.parseMemory(w.Memory)
		if w.GPU > maxGPU {
			maxGPU = w.GPU
		}
		workloadNames = append(workloadNames, w.Name)
	}
	
	// Add buffer for overhead (30%)
	totalCPU *= 1.3
	totalMemory *= 1.3
	
	// Calculate per-node requirements
	nodesNeeded := int(math.Ceil(math.Max(totalCPU/4, totalMemory/8))) // Rough estimate
	if nodesNeeded < 1 {
		nodesNeeded = 1
	}
	
	cpuPerNode := totalCPU / float64(nodesNeeded)
	memoryPerNode := totalMemory / float64(nodesNeeded)
	
	instanceTypes := r.selectInstanceTypes(cpuPerNode, memoryPerNode, maxGPU)
	capacityType := r.selectCapacityType(group)
	architecture := r.selectArchitecture(group)
	
	rec := NodePoolRecommendation{
		Name:             fmt.Sprintf("nodepool-%d", index),
		InstanceTypes:    instanceTypes,
		CapacityType:     capacityType,
		Architecture:     architecture,
		MinSize:          0,
		MaxSize:          nodesNeeded * 2, // Allow scaling
		Labels:           r.extractCommonLabels(group),
		Requirements: Requirements{
			CPU: ResourceRange{
				Min: fmt.Sprintf("%.0f", cpuPerNode*0.8),
				Max: fmt.Sprintf("%.0f", cpuPerNode*1.2),
			},
			Memory: ResourceRange{
				Min: r.formatMemory(memoryPerNode * 0.8),
				Max: r.formatMemory(memoryPerNode * 1.2),
			},
			GPU: maxGPU,
		},
		EstimatedCost:    r.estimateCost(instanceTypes, capacityType, nodesNeeded),
		Reasoning:        r.generateReasoning(group, cpuPerNode, memoryPerNode, maxGPU),
		WorkloadsMatched: workloadNames,
	}
	
	return rec
}

func (r *Recommender) selectInstanceTypes(cpu, memory float64, gpu int) []string {
	if gpu > 0 {
		// GPU instances
		return []string{"g4dn.xlarge", "g4dn.2xlarge", "g5.xlarge", "g5.2xlarge"}
	}
	
	// CPU/Memory optimized instances
	var types []string
	
	if memory/cpu > 8 {
		// Memory optimized
		types = []string{"r6i.large", "r6i.xlarge", "r6i.2xlarge", "r6a.large", "r6a.xlarge"}
	} else if cpu > 8 {
		// CPU optimized
		types = []string{"c6i.xlarge", "c6i.2xlarge", "c6i.4xlarge", "c6a.xlarge", "c6a.2xlarge"}
	} else {
		// General purpose
		types = []string{"m6i.large", "m6i.xlarge", "m6i.2xlarge", "m6a.large", "m6a.xlarge", "t3.medium", "t3.large"}
	}
	
	// Limit to 3-5 instance types for better bin-packing
	if len(types) > 5 {
		types = types[:5]
	}
	
	return types
}

func (r *Recommender) selectCapacityType(workloads []Workload) string {
	// Prefer spot for cost savings, but can be configured
	// Check if any workload has specific requirements
	for _, w := range workloads {
		if w.Labels["karpenter.sh/capacity-type"] == "on-demand" {
			return "on-demand"
		}
	}
	return "spot"
}

func (r *Recommender) selectArchitecture(workloads []Workload) string {
	// Default to amd64, but check for arm64 preference
	for _, w := range workloads {
		if w.Labels["kubernetes.io/arch"] == "arm64" {
			return "arm64"
		}
	}
	return "amd64"
}

func (r *Recommender) extractCommonLabels(workloads []Workload) map[string]string {
	if len(workloads) == 0 {
		return map[string]string{}
	}
	
	common := make(map[string]string)
	firstLabels := workloads[0].Labels
	
	for key, value := range firstLabels {
		allMatch := true
		for _, w := range workloads[1:] {
			if w.Labels[key] != value {
				allMatch = false
				break
			}
		}
		if allMatch {
			common[key] = value
		}
	}
	
	return common
}

func (r *Recommender) estimateCost(instanceTypes []string, capacityType string, nodeCount int) float64 {
	// Rough cost estimates (USD per hour)
	costMap := map[string]float64{
		"t3.medium":     0.0416,
		"t3.large":      0.0832,
		"m6i.large":     0.096,
		"m6i.xlarge":    0.192,
		"m6i.2xlarge":   0.384,
		"m6a.large":     0.0864,
		"m6a.xlarge":    0.1728,
		"c6i.xlarge":    0.17,
		"c6i.2xlarge":   0.34,
		"c6i.4xlarge":   0.68,
		"c6a.xlarge":    0.153,
		"c6a.2xlarge":   0.306,
		"r6i.large":     0.126,
		"r6i.xlarge":    0.252,
		"r6i.2xlarge":   0.504,
		"r6a.large":     0.1134,
		"r6a.xlarge":    0.2268,
		"g4dn.xlarge":   0.526,
		"g4dn.2xlarge":  0.752,
		"g5.xlarge":     1.006,
		"g5.2xlarge":    1.212,
	}
	
	var avgCost float64
	for _, it := range instanceTypes {
		if cost, ok := costMap[it]; ok {
			avgCost += cost
		}
	}
	if len(instanceTypes) > 0 {
		avgCost /= float64(len(instanceTypes))
	}
	
	// Spot instances are typically 60-70% cheaper
	if capacityType == "spot" {
		avgCost *= 0.65
	}
	
	return avgCost * float64(nodeCount)
}

func (r *Recommender) generateReasoning(workloads []Workload, cpu, memory float64, gpu int) string {
	var parts []string
	
	parts = append(parts, fmt.Sprintf("Analyzed %d workload(s)", len(workloads)))
	parts = append(parts, fmt.Sprintf("Total requirements: %.1f CPU, %s memory", cpu, r.formatMemory(memory)))
	
	if gpu > 0 {
		parts = append(parts, fmt.Sprintf("GPU requirement: %d GPU(s)", gpu))
	}
	
	if memory/cpu > 8 {
		parts = append(parts, "Memory-optimized instance types selected")
	} else if cpu > 8 {
		parts = append(parts, "CPU-optimized instance types selected")
	}
	
	return strings.Join(parts, ". ")
}

func (r *Recommender) parseCPU(cpuStr string) float64 {
	cpuStr = strings.TrimSpace(cpuStr)
	cpuStr = strings.ToLower(cpuStr)
	
	// Remove "cpu" suffix if present
	cpuStr = strings.TrimSuffix(cpuStr, "cpu")
	cpuStr = strings.TrimSpace(cpuStr)
	
	// Handle millicores (e.g., "100m" = 0.1)
	if strings.HasSuffix(cpuStr, "m") {
		val, err := strconv.ParseFloat(strings.TrimSuffix(cpuStr, "m"), 64)
		if err != nil {
			return 0
		}
		return val / 1000.0
	}
	
	// Handle regular cores
	val, err := strconv.ParseFloat(cpuStr, 64)
	if err != nil {
		return 0
	}
	
	return val
}

func (r *Recommender) parseMemory(memStr string) float64 {
	memStr = strings.TrimSpace(memStr)
	memStr = strings.ToLower(memStr)
	
	// Remove "memory" suffix if present
	memStr = strings.TrimSuffix(memStr, "memory")
	memStr = strings.TrimSpace(memStr)
	
	var multiplier float64 = 1
	
	if strings.HasSuffix(memStr, "ki") {
		multiplier = 1024.0 / (1024.0 * 1024.0) // KiB to GiB
		memStr = strings.TrimSuffix(memStr, "ki")
	} else if strings.HasSuffix(memStr, "mi") {
		multiplier = 1.0 / 1024.0 // MiB to GiB
		memStr = strings.TrimSuffix(memStr, "mi")
	} else if strings.HasSuffix(memStr, "gi") {
		multiplier = 1 // Already GiB
		memStr = strings.TrimSuffix(memStr, "gi")
	} else if strings.HasSuffix(memStr, "ti") {
		multiplier = 1024 // TiB to GiB
		memStr = strings.TrimSuffix(memStr, "ti")
	} else if strings.HasSuffix(memStr, "k") {
		multiplier = 1000.0 / (1000.0 * 1000.0 * 1000.0) // KB to GB
		memStr = strings.TrimSuffix(memStr, "k")
	} else if strings.HasSuffix(memStr, "m") {
		multiplier = 1.0 / 1000.0 // MB to GB
		memStr = strings.TrimSuffix(memStr, "m")
	} else if strings.HasSuffix(memStr, "g") {
		multiplier = 1 // Already GB
		memStr = strings.TrimSuffix(memStr, "g")
	} else if strings.HasSuffix(memStr, "t") {
		multiplier = 1000 // TB to GB
		memStr = strings.TrimSuffix(memStr, "t")
	}
	
	val, err := strconv.ParseFloat(memStr, 64)
	if err != nil {
		return 0
	}
	
	return val * multiplier
}

func (r *Recommender) formatMemory(gb float64) string {
	if gb < 1 {
		return fmt.Sprintf("%.0fMi", gb*1024)
	}
	return fmt.Sprintf("%.1fGi", gb)
}

