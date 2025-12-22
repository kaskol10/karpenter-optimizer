package recommender

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/karpenter-optimizer/internal/kubernetes"
)

// NodePoolCapacityRecommendation represents a recommendation based on actual node capacity
type NodePoolCapacityRecommendation struct {
	NodePoolName             string   `json:"nodePoolName"`
	CurrentNodes             int      `json:"currentNodes"`
	CurrentInstanceTypes     []string `json:"currentInstanceTypes"`
	CurrentCPUUsed           float64  `json:"currentCPUUsed"`        // Total CPU used across all nodes
	CurrentCPUCapacity       float64  `json:"currentCPUCapacity"`    // Total CPU allocatable across all nodes
	CurrentMemoryUsed         float64  `json:"currentMemoryUsed"`     // Total Memory used across all nodes
	CurrentMemoryCapacity    float64  `json:"currentMemoryCapacity"` // Total Memory allocatable across all nodes
	CurrentCost              float64  `json:"currentCost"`           // Current hourly cost
	RecommendedNodes         int      `json:"recommendedNodes"`
	RecommendedInstanceTypes []string `json:"recommendedInstanceTypes"`
	RecommendedTotalCPU      float64  `json:"recommendedTotalCPU"`
	RecommendedTotalMemory   float64  `json:"recommendedTotalMemory"`
	RecommendedCost          float64  `json:"recommendedCost"`
	CostSavings              float64  `json:"costSavings"`        // Hourly cost savings
	CostSavingsPercent       float64  `json:"costSavingsPercent"` // Percentage savings
	Reasoning                string   `json:"reasoning"`
	AIReasoning              string   `json:"aiReasoning,omitempty"` // AI-enhanced explanation (if Ollama is available)
	Architecture             string   `json:"architecture"`
	CapacityType             string   `json:"capacityType"`
	Taints                   []kubernetes.Taint `json:"taints,omitempty"` // Node taints
	HasRecommendation        bool     `json:"hasRecommendation"` // true if a cost-saving recommendation exists
}

// GenerateRecommendationsFromNodePools generates recommendations based on actual node capacity data
func (r *Recommender) GenerateRecommendationsFromNodePools(ctx context.Context, nodePools []kubernetes.NodePoolInfo, progressCallback func(string, float64)) ([]NodePoolCapacityRecommendation, error) {
	var recommendations []NodePoolCapacityRecommendation
	totalNodePools := len(nodePools)

	for i, np := range nodePools {
		if progressCallback != nil {
			// Calculate progress: map from 0% to 100% based on NodePool index
			// Use (i+1) to ensure first NodePool shows some progress, and last shows 100%
			progress := float64(i+1) / float64(totalNodePools) * 100.0
			progressCallback(fmt.Sprintf("Analyzing NodePool '%s' (%d/%d)", np.Name, i+1, totalNodePools), progress)
		}

		if len(np.ActualNodes) == 0 {
			// Include NodePools with no nodes but mark as no recommendation
			recommendations = append(recommendations, NodePoolCapacityRecommendation{
				NodePoolName:             np.Name,
				CurrentNodes:             0,
				CurrentInstanceTypes:     []string{},
				CurrentCPUUsed:           0,
				CurrentCPUCapacity:       0,
				CurrentMemoryUsed:        0,
				CurrentMemoryCapacity:    0,
				CurrentCost:              0,
				RecommendedNodes:         0,
				RecommendedInstanceTypes: []string{},
				RecommendedTotalCPU:      0,
				RecommendedTotalMemory:   0,
				RecommendedCost:          0,
				CostSavings:              0,
				CostSavingsPercent:       0,
				Reasoning:                "No nodes currently exist in this NodePool.",
				Architecture:             np.Architecture,
				CapacityType:             np.CapacityType,
				Taints:                   np.Taints,
				HasRecommendation:        false,
			})
			if progressCallback != nil {
				// Calculate progress: ensure it's based on completion, not just index
				progress := float64(i+1) / float64(totalNodePools) * 100.0
				progressCallback(fmt.Sprintf("NodePool '%s' has no nodes", np.Name), progress)
			}
			continue
		}

		// Calculate current total capacity and usage from actual nodes
		var currentCPUUsed, currentCPUCapacity, currentMemoryUsed, currentMemoryCapacity float64
		currentInstanceTypes := make(map[string]int) // instance type -> count
		currentCost := 0.0
		architecture := np.Architecture
		capacityType := np.CapacityType

		for _, node := range np.ActualNodes {
			// Sum CPU usage and capacity (allocatable)
			if node.CPUUsage != nil {
				currentCPUUsed += node.CPUUsage.Used
				currentCPUCapacity += node.CPUUsage.Allocatable
			}
			// Sum Memory usage and capacity (allocatable)
			if node.MemoryUsage != nil {
				currentMemoryUsed += node.MemoryUsage.Used
				currentMemoryCapacity += node.MemoryUsage.Allocatable
			}

			// Track instance types and their counts
			if node.InstanceType != "" {
				currentInstanceTypes[node.InstanceType]++
			}

			// Calculate current cost
			if node.InstanceType != "" {
				nodeCapacityType := node.CapacityType
				if nodeCapacityType == "" {
					nodeCapacityType = capacityType
				}
				if nodeCapacityType == "" {
					nodeCapacityType = "on-demand" // Default
				}
				nodeCost := r.estimateCost(ctx, []string{node.InstanceType}, nodeCapacityType, 1)
				currentCost += nodeCost
			}

			// Use node's architecture if available
			if node.Architecture != "" {
				architecture = node.Architecture
			}
		}

		// Convert instance type map to slice
		currentTypesList := make([]string, 0, len(currentInstanceTypes))
		for it, count := range currentInstanceTypes {
			currentTypesList = append(currentTypesList, fmt.Sprintf("%s (%d)", it, count))
		}

		// Analyze actual node capacity types to determine best recommendation
		// Count spot vs on-demand nodes
		spotNodes := 0
		onDemandNodes := 0
		for _, node := range np.ActualNodes {
			nodeCapacityType := node.CapacityType
			if nodeCapacityType == "" {
				nodeCapacityType = capacityType
			}
			if nodeCapacityType == "" {
				nodeCapacityType = "on-demand" // Default
			}
			if nodeCapacityType == "spot" {
				spotNodes++
			} else {
				onDemandNodes++
			}
		}

		// Try both spot and on-demand to find the best cost option
		// If all nodes are already spot, prefer spot. If there are on-demand nodes, try converting to spot for savings.
		bestTypes, bestNodes, bestCost, bestCapacityType := r.findOptimalInstanceTypesWithCapacityType(ctx,
			currentCPUCapacity,
			currentMemoryCapacity,
			architecture,
			spotNodes > 0,     // Prefer spot if already using spot
			onDemandNodes > 0, // Consider converting on-demand to spot
		)

		// Calculate recommended capacity (distribute nodes across instance types)
		var recommendedTotalCPU, recommendedTotalMemory float64
		if len(bestTypes) > 0 && bestNodes > 0 {
			nodesPerType := bestNodes / len(bestTypes)
			remainder := bestNodes % len(bestTypes)
			for i, it := range bestTypes {
				cpu, mem := r.estimateInstanceCapacity(it)
				nodesForThisType := nodesPerType
				if i < remainder {
					nodesForThisType++
				}
				recommendedTotalCPU += cpu * float64(nodesForThisType)
				recommendedTotalMemory += mem * float64(nodesForThisType)
			}
		} else {
			// If no recommendation, use current capacity
			recommendedTotalCPU = currentCPUCapacity
			recommendedTotalMemory = currentMemoryCapacity
		}

		// Calculate utilization percentages
		cpuUtilization := 0.0
		if currentCPUCapacity > 0 {
			cpuUtilization = (currentCPUUsed / currentCPUCapacity) * 100
		}
		memoryUtilization := 0.0
		if currentMemoryCapacity > 0 {
			memoryUtilization = (currentMemoryUsed / currentMemoryCapacity) * 100
		}

		// Check if there's cost savings
		hasRecommendation := bestCost < currentCost
		var costSavings, costSavingsPercent float64
		var reasoning string

		if hasRecommendation {
			costSavings = currentCost - bestCost
			costSavingsPercent = (costSavings / currentCost) * 100

			capacityTypeNote := ""
			if bestCapacityType == "spot" && onDemandNodes > 0 {
				capacityTypeNote = fmt.Sprintf(" Converting %d on-demand nodes to spot for additional savings. ", onDemandNodes)
			} else if bestCapacityType == "spot" && spotNodes > 0 {
				capacityTypeNote = " Maintaining spot instances. "
			}

			reasoning = fmt.Sprintf("Current setup: %d nodes providing %.1f CPU cores (%.1f%% used) and %.1f GiB memory (%.1f%% used) at $%.2f/hr. ",
				np.CurrentNodes, currentCPUCapacity, cpuUtilization, currentMemoryCapacity, memoryUtilization, currentCost)
			reasoning += fmt.Sprintf("Recommended: %d nodes with %v (%s) providing %.1f CPU cores and %.1f GiB memory at $%.2f/hr.%s",
				bestNodes, bestTypes, bestCapacityType, recommendedTotalCPU, recommendedTotalMemory, bestCost, capacityTypeNote)
			reasoning += fmt.Sprintf("Potential savings: $%.2f/hr (%.1f%%).",
				costSavings, costSavingsPercent)

			if progressCallback != nil {
				// Calculate progress: ensure it's based on completion
				progress := float64(i+1) / float64(totalNodePools) * 100.0
				progressCallback(fmt.Sprintf("Found recommendation for NodePool '%s': %d nodes -> %d nodes, savings: $%.2f/hr (%.1f%%)", np.Name, np.CurrentNodes, bestNodes, costSavings, costSavingsPercent), progress)
			}
		} else {
			// No cost savings - use current values as recommended
			bestNodes = np.CurrentNodes
			bestTypes = currentTypesList
			bestCost = currentCost
			bestCapacityType = capacityType
			if bestCapacityType == "" {
				bestCapacityType = "on-demand"
			}
			recommendedTotalCPU = currentCPUCapacity
			recommendedTotalMemory = currentMemoryCapacity

			reasoning = fmt.Sprintf("Current setup: %d nodes providing %.1f CPU cores (%.1f%% used) and %.1f GiB memory (%.1f%% used) at $%.2f/hr. ",
				np.CurrentNodes, currentCPUCapacity, cpuUtilization, currentMemoryCapacity, memoryUtilization, currentCost)
			reasoning += "No cost-saving recommendations available. Current configuration is already optimal."

			if progressCallback != nil {
				// Calculate progress: ensure it's based on completion
				progress := float64(i+1) / float64(totalNodePools) * 100.0
				progressCallback(fmt.Sprintf("No recommendation for NodePool '%s' - current cost ($%.2f/hr) is already optimal", np.Name, currentCost), progress)
			}
		}

		rec := NodePoolCapacityRecommendation{
			NodePoolName:             np.Name,
			CurrentNodes:             np.CurrentNodes,
			CurrentInstanceTypes:     currentTypesList,
			CurrentCPUUsed:           currentCPUUsed,
			CurrentCPUCapacity:       currentCPUCapacity,
			CurrentMemoryUsed:        currentMemoryUsed,
			CurrentMemoryCapacity:    currentMemoryCapacity,
			CurrentCost:              currentCost,
			RecommendedNodes:         bestNodes,
			RecommendedInstanceTypes: bestTypes,
			RecommendedTotalCPU:      recommendedTotalCPU,
			RecommendedTotalMemory:   recommendedTotalMemory,
			RecommendedCost:          bestCost,
			CostSavings:              costSavings,
			CostSavingsPercent:       costSavingsPercent,
			Reasoning:                reasoning,
			Architecture:             architecture,
			CapacityType:             bestCapacityType,
			Taints:                   np.Taints,
			HasRecommendation:        hasRecommendation,
		}

		// Generate AI-enhanced reasoning if Ollama is available
		if r.ollamaClient != nil {
			aiReasoning := r.generateAIReasoning(ctx, reasoning, rec)
			rec.AIReasoning = aiReasoning
		}

		recommendations = append(recommendations, rec)
	}

	return recommendations, nil
}

// generateAIReasoning generates an AI-enhanced explanation from the base reasoning
func (r *Recommender) generateAIReasoning(ctx context.Context, baseReasoning string, rec NodePoolCapacityRecommendation) string {
	if r.ollamaClient == nil {
		return ""
	}

	// Build prompt to enhance the reasoning
	prompt := fmt.Sprintf(`You are a Kubernetes infrastructure expert. Enhance and improve this NodePool optimization explanation to make it more clear, professional, and actionable.

Original Explanation:
%s

NodePool Details:
- Name: %s
- Current: %d nodes, $%.2f/hr
- Recommended: %d nodes, $%.2f/hr
- Savings: $%.2f/hr (%.1f%%)
- Architecture: %s
- Capacity Type: %s

Provide an enhanced explanation (2-4 sentences) that:
1. Makes the explanation more clear and professional
2. Highlights the key benefits and impact
3. Provides actionable insights
4. Maintains accuracy of the technical details

Return only the enhanced explanation text, no additional formatting.`,
		baseReasoning,
		rec.NodePoolName,
		rec.CurrentNodes,
		rec.CurrentCost,
		rec.RecommendedNodes,
		rec.RecommendedCost,
		rec.CostSavings,
		rec.CostSavingsPercent,
		rec.Architecture,
		rec.CapacityType,
	)

	// Use a shorter timeout for AI reasoning (it's an enhancement, not critical)
	aiCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	response, err := r.ollamaClient.Chat(aiCtx, prompt)
	if err != nil {
		// If Ollama fails, return empty string (field will be omitted from JSON)
		return ""
	}

	// Clean up the response - remove any JSON formatting if present
	aiReasoning := strings.TrimSpace(response)

	// Try to extract JSON if response is wrapped in JSON
	if strings.HasPrefix(aiReasoning, "{") {
		var jsonResp struct {
			Explanation string `json:"explanation"`
			Response    string `json:"response"`
			Text        string `json:"text"`
		}
		if err := json.Unmarshal([]byte(aiReasoning), &jsonResp); err == nil {
			if jsonResp.Explanation != "" {
				aiReasoning = jsonResp.Explanation
			} else if jsonResp.Response != "" {
				aiReasoning = jsonResp.Response
			} else if jsonResp.Text != "" {
				aiReasoning = jsonResp.Text
			}
		}
	}

	return strings.TrimSpace(aiReasoning)
}

// EnhanceRecommendationsWithOllama enhances recommendations with AI-generated explanations
func (r *Recommender) EnhanceRecommendationsWithOllama(ctx context.Context, recommendations []NodePoolCapacityRecommendation) ([]NodePoolCapacityRecommendation, error) {
	if r.ollamaClient == nil {
		return recommendations, nil // Return original if Ollama not available
	}

	enhanced := make([]NodePoolCapacityRecommendation, len(recommendations))
	for i, rec := range recommendations {
		enhanced[i] = rec

		// Build prompt for Ollama to explain the recommendation
		prompt := fmt.Sprintf(`You are a Kubernetes infrastructure expert. Explain the benefits and impact of this NodePool optimization recommendation.

Current State:
- NodePool: %s
- Nodes: %d
- Instance Types: %v
- CPU Capacity: %.1f cores (%.1f%% used)
- Memory Capacity: %.1f GiB (%.1f%% used)
- Current Cost: $%.2f/hr
- Capacity Type: %s

Recommended State:
- Nodes: %d
- Instance Types: %v
- CPU Capacity: %.1f cores
- Memory Capacity: %.1f GiB
- Recommended Cost: $%.2f/hr
- Capacity Type: %s
- Cost Savings: $%.2f/hr (%.1f%%)

Provide a concise explanation (2-3 sentences) focusing on:
1. Why this change is beneficial
2. What improvements it brings (cost, efficiency, performance)
3. Any considerations or risks

Respond with JSON:
{
  "explanation": "Your explanation here"
}`, rec.NodePoolName, rec.CurrentNodes, rec.CurrentInstanceTypes,
			rec.CurrentCPUCapacity, (rec.CurrentCPUUsed/rec.CurrentCPUCapacity)*100,
			rec.CurrentMemoryCapacity, (rec.CurrentMemoryUsed/rec.CurrentMemoryCapacity)*100,
			rec.CurrentCost, rec.CapacityType,
			rec.RecommendedNodes, rec.RecommendedInstanceTypes,
			rec.RecommendedTotalCPU, rec.RecommendedTotalMemory,
			rec.RecommendedCost, rec.CapacityType,
			rec.CostSavings, rec.CostSavingsPercent)

		ollamaCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		response, err := r.ollamaClient.Chat(ollamaCtx, prompt)
		cancel()

		if err == nil {
			// Parse Ollama response
			var ollamaResp struct {
				Explanation string `json:"explanation"`
			}
			if err := json.Unmarshal([]byte(response), &ollamaResp); err != nil {
				// Try to extract JSON from markdown
				jsonStart := strings.Index(response, "{")
				jsonEnd := strings.LastIndex(response, "}")
				if jsonStart >= 0 && jsonEnd > jsonStart {
					jsonStr := response[jsonStart : jsonEnd+1]
					_ = json.Unmarshal([]byte(jsonStr), &ollamaResp) // Ignore unmarshal error, use original response
				}
			}
			if ollamaResp.Explanation != "" {
				enhanced[i].Reasoning = ollamaResp.Explanation
			}
		}
	}

	return enhanced, nil
}

// findOptimalInstanceTypesWithCapacityType finds the best instance type combination and capacity type
// It tries both spot and on-demand to find the optimal cost
func (r *Recommender) findOptimalInstanceTypesWithCapacityType(ctx context.Context, requiredCPU, requiredMemory float64, architecture string, preferSpot, hasOnDemand bool) ([]string, int, float64, string) {
	// Add 10% headroom for bin-packing efficiency
	targetCPU := requiredCPU * 1.1
	targetMemory := requiredMemory * 1.1

	// Get candidate instance types based on architecture
	candidates := r.getCandidateInstanceTypes(architecture, requiredCPU, requiredMemory)

	if len(candidates) == 0 {
		return []string{}, 0, 0.0, "on-demand"
	}

	bestCost := math.MaxFloat64
	bestTypes := []string{}
	bestNodes := 0
	bestCapacityType := "on-demand"

	// Try both spot and on-demand capacity types
	capacityTypesToTry := []string{"on-demand"}
	if preferSpot || hasOnDemand {
		// If already using spot or have on-demand nodes, try spot for cost savings
		capacityTypesToTry = append([]string{"spot"}, capacityTypesToTry...)
	}

	for _, capType := range capacityTypesToTry {
		// Try different combinations of instance types (1-3 types)
		// Try single instance type
		for _, it := range candidates {
			cpu, mem := r.estimateInstanceCapacity(it)
			if cpu == 0 || mem == 0 {
				continue
			}
			nodesNeeded := int(math.Ceil(math.Max(targetCPU/cpu, targetMemory/mem)))
			cost := r.estimateCost(ctx, []string{it}, capType, nodesNeeded)
			if cost < bestCost {
				bestCost = cost
				bestTypes = []string{it}
				bestNodes = nodesNeeded
				bestCapacityType = capType
			}
		}

		// Try combinations of 2-3 instance types
		for numTypes := 2; numTypes <= 3 && numTypes <= len(candidates); numTypes++ {
			combinations := r.generateCombinations(candidates, numTypes)
			for _, combo := range combinations {
				// Calculate average capacity per instance type
				avgCPU, avgMemory := 0.0, 0.0
				for _, it := range combo {
					cpu, mem := r.estimateInstanceCapacity(it)
					avgCPU += cpu
					avgMemory += mem
				}
				avgCPU /= float64(len(combo))
				avgMemory /= float64(len(combo))

				if avgCPU == 0 || avgMemory == 0 {
					continue
				}

				nodesNeeded := int(math.Ceil(math.Max(targetCPU/avgCPU, targetMemory/avgMemory)))
				cost := r.estimateCost(ctx, combo, capType, nodesNeeded)
				if cost < bestCost {
					bestCost = cost
					bestTypes = combo
					bestNodes = nodesNeeded
					bestCapacityType = capType
				}
			}
		}
	}

	return bestTypes, bestNodes, bestCost, bestCapacityType
}

// findOptimalInstanceTypes finds the best instance type combination to match required capacity at lowest cost
// Deprecated: Use findOptimalInstanceTypesWithCapacityType instead
//nolint:unused // Kept for backward compatibility
func (r *Recommender) findOptimalInstanceTypes(requiredCPU, requiredMemory float64, architecture, capacityType string) ([]string, int, float64) {
	types, nodes, cost, _ := r.findOptimalInstanceTypesWithCapacityType(context.Background(), requiredCPU, requiredMemory, architecture, capacityType == "spot", capacityType != "spot")
	return types, nodes, cost
}

// getCandidateInstanceTypes returns candidate instance types based on architecture and requirements
// Queries AWS Pricing API for available instance types instead of hardcoding
func (r *Recommender) getCandidateInstanceTypes(architecture string, cpu, memory float64) []string {
	// Try to get instance types from AWS Pricing API
	if r.awsPricing != nil {
		// Increase timeout to 60 seconds - the pricing index file can be very large (several MB)
		// The AWS Pricing API client now uses a 60-second HTTP timeout and caches results
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()

		availableTypes, err := r.awsPricing.GetAvailableEC2InstanceTypes(ctx, architecture)
		if err == nil && len(availableTypes) > 0 {
			// Filter by CPU/Memory ratio and requirements
			return r.filterInstanceTypesByRequirements(availableTypes, architecture, cpu, memory)
		}
		// If AWS API fails, fall back to hardcoded list
		if err != nil {
			// Only log if it's not a context timeout (which is expected on slow connections)
			if !strings.Contains(err.Error(), "context deadline exceeded") && !strings.Contains(err.Error(), "timeout") {
				fmt.Printf("Warning: Failed to get instance types from AWS API: %v. Using fallback list.\n", err)
			} else {
				fmt.Printf("Info: AWS Pricing API timeout (index file is large). Using fallback instance types list. Subsequent requests will use cached data.\n")
			}
		} else if len(availableTypes) == 0 {
			fmt.Printf("Warning: AWS API returned empty instance types list for architecture %s. Using fallback list.\n", architecture)
		}
	}

	// Fallback to hardcoded list if AWS API is unavailable
	return r.getHardcodedCandidateInstanceTypes(architecture, cpu, memory)
}

// filterInstanceTypesByRequirements filters AWS instance types based on CPU/Memory requirements
func (r *Recommender) filterInstanceTypesByRequirements(availableTypes []string, architecture string, cpu, memory float64) []string {
	memoryToCPURatio := memory / cpu
	var candidates []string

	for _, it := range availableTypes {
		itLower := strings.ToLower(it)

		// Skip GPU instances
		if strings.HasPrefix(itLower, "g") || strings.HasPrefix(itLower, "p") || strings.HasPrefix(itLower, "inf") {
			continue
		}

		// Get instance capacity
		instanceCPU, instanceMemory := r.estimateInstanceCapacity(it)
		if instanceCPU == 0 || instanceMemory == 0 {
			continue
		}

		// Filter based on CPU/Memory ratio
		instanceRatio := instanceMemory / instanceCPU

		if memoryToCPURatio > 8 {
			// Memory optimized: ratio > 8
			if instanceRatio > 6 {
				candidates = append(candidates, it)
			}
		} else if cpu > 8 {
			// CPU optimized: high CPU requirement
			if instanceCPU >= 4 && instanceRatio < 4 {
				candidates = append(candidates, it)
			}
		} else {
			// General purpose: balanced
			if instanceRatio >= 2 && instanceRatio <= 8 {
				candidates = append(candidates, it)
			}
		}
	}

	// Limit to reasonable number of candidates and sort by cost efficiency
	if len(candidates) > 20 {
		// Sort by cost efficiency and take top 20
		sort.Slice(candidates, func(i, j int) bool {
			cpuI, memI := r.estimateInstanceCapacity(candidates[i])
			cpuJ, memJ := r.estimateInstanceCapacity(candidates[j])
			costI := r.estimateCost(context.Background(), []string{candidates[i]}, "on-demand", 1)
			costJ := r.estimateCost(context.Background(), []string{candidates[j]}, "on-demand", 1)

			efficiencyI := costI / (cpuI*0.7 + memI*0.3)
			efficiencyJ := costJ / (cpuJ*0.7 + memJ*0.3)
			return efficiencyI < efficiencyJ
		})
		candidates = candidates[:20]
	} else {
		// Sort by cost efficiency
		sort.Slice(candidates, func(i, j int) bool {
			cpuI, memI := r.estimateInstanceCapacity(candidates[i])
			cpuJ, memJ := r.estimateInstanceCapacity(candidates[j])
			costI := r.estimateCost(context.Background(), []string{candidates[i]}, "on-demand", 1)
			costJ := r.estimateCost(context.Background(), []string{candidates[j]}, "on-demand", 1)

			efficiencyI := costI / (cpuI*0.7 + memI*0.3)
			efficiencyJ := costJ / (cpuJ*0.7 + memJ*0.3)
			return efficiencyI < efficiencyJ
		})
	}

	return candidates
}

// getHardcodedCandidateInstanceTypes returns hardcoded instance types as fallback
func (r *Recommender) getHardcodedCandidateInstanceTypes(architecture string, cpu, memory float64) []string {
	var candidates []string
	memoryToCPURatio := memory / cpu

	if architecture == "arm64" {
		// ARM/Graviton instances
		if memoryToCPURatio > 8 {
			// Memory optimized
			candidates = []string{"r6g.xlarge", "r6g.2xlarge", "r6g.4xlarge", "r7g.xlarge", "r7g.2xlarge", "r7g.4xlarge", "x2gd.xlarge", "x2gd.2xlarge", "x2gd.4xlarge", "x8g.xlarge", "x8g.2xlarge", "x8g.4xlarge"}
		} else if cpu > 8 {
			// CPU optimized
			candidates = []string{"c6g.xlarge", "c6g.2xlarge", "c6g.4xlarge", "c7g.xlarge", "c7g.2xlarge", "c7g.4xlarge", "c6gn.xlarge", "c6gn.2xlarge"}
		} else {
			// General purpose
			candidates = []string{"m6g.xlarge", "m6g.2xlarge", "m6g.4xlarge", "m7g.xlarge", "m7g.2xlarge", "m7g.4xlarge", "m8g.xlarge", "m8g.2xlarge", "t4g.xlarge", "t4g.2xlarge"}
		}
	} else {
		// x86/AMD64 instances
		if memoryToCPURatio > 8 {
			// Memory optimized
			candidates = []string{"r6i.xlarge", "r6i.2xlarge", "r6i.4xlarge", "r6a.xlarge", "r6a.2xlarge", "r6a.4xlarge", "r8i.xlarge", "r8i.2xlarge"}
		} else if cpu > 8 {
			// CPU optimized
			candidates = []string{"c6i.xlarge", "c6i.2xlarge", "c6i.4xlarge", "c6a.xlarge", "c6a.2xlarge", "c6a.4xlarge"}
		} else {
			// General purpose
			candidates = []string{"m6i.xlarge", "m6i.2xlarge", "m6i.4xlarge", "m6i.8xlarge", "m6a.xlarge", "m6a.2xlarge", "m6a.4xlarge", "t3.xlarge", "t3.2xlarge"}
		}
	}

	// Filter out invalid instance types and sort by cost efficiency
	validCandidates := []string{}
	for _, it := range candidates {
		instCPU, instMem := r.estimateInstanceCapacity(it)
		if instCPU > 0 && instMem > 0 {
			validCandidates = append(validCandidates, it)
		}
	}

	// Sort by cost efficiency (cost per unit of capacity)
	sort.Slice(validCandidates, func(i, j int) bool {
		cpuI, memI := r.estimateInstanceCapacity(validCandidates[i])
		cpuJ, memJ := r.estimateInstanceCapacity(validCandidates[j])
		costI := r.estimateCost(context.Background(), []string{validCandidates[i]}, "on-demand", 1)
		costJ := r.estimateCost(context.Background(), []string{validCandidates[j]}, "on-demand", 1)

		// Cost per unit of capacity (weighted: 70% CPU, 30% Memory)
		efficiencyI := costI / (cpuI*0.7 + memI*0.3)
		efficiencyJ := costJ / (cpuJ*0.7 + memJ*0.3)
		return efficiencyI < efficiencyJ
	})

	// Return top 10 most cost-efficient candidates
	if len(validCandidates) > 10 {
		return validCandidates[:10]
	}
	return validCandidates
}

// generateCombinations generates all combinations of n items from the candidates list
func (r *Recommender) generateCombinations(candidates []string, n int) [][]string {
	if n > len(candidates) {
		return [][]string{}
	}
	if n == 0 {
		return [][]string{{}}
	}
	if n == len(candidates) {
		return [][]string{candidates}
	}

	var result [][]string
	var helper func([]string, int, int, []string)

	helper = func(arr []string, start, depth int, current []string) {
		if depth == n {
			combo := make([]string, n)
			copy(combo, current)
			result = append(result, combo)
			return
		}
		for i := start; i < len(arr); i++ {
			current[depth] = arr[i]
			helper(arr, i+1, depth+1, current)
		}
	}

	current := make([]string, n)
	helper(candidates, 0, 0, current)
	return result
}
