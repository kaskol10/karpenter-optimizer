package recommender

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/karpenter-optimizer/internal/awspricing"
	"github.com/karpenter-optimizer/internal/config"
	"github.com/karpenter-optimizer/internal/kubernetes"
	"github.com/karpenter-optimizer/internal/ollama"
)

// ProgressCallback is a function type for reporting progress during recommendation generation
type ProgressCallback func(message string, progress float64)

// PricingSource indicates where the price came from
type PricingSource string

const (
	PricingSourceAWSPricingAPI PricingSource = "aws-pricing-api"
	PricingSourceHardcoded     PricingSource = "hardcoded"
	PricingSourceOllamaCache    PricingSource = "ollama-cache"
	PricingSourceFamilyEstimate PricingSource = "family-estimate"
	PricingSourceOllama         PricingSource = "ollama"
	PricingSourceUnknown        PricingSource = "unknown"
)

// PricingResult contains cost information and its source
type PricingResult struct {
	Cost   float64       `json:"cost"`
	Source PricingSource `json:"source"`
}

type Recommender struct {
	config       *config.Config
	k8sClient    *kubernetes.Client
	ollamaClient *ollama.Client
	awsPricing   *awspricing.Client // AWS Pricing API client
	priceCache   map[string]float64 // Cache for Ollama-fetched pricing
	priceCacheMu sync.RWMutex       // Mutex for thread-safe cache access
}

func NewRecommender(cfg *config.Config) *Recommender {
	var ollamaClient *ollama.Client
	// Use new LLM config if available, otherwise fall back to legacy Ollama config
	llmURL := cfg.LLMURL
	llmModel := cfg.LLMModel
	if llmURL == "" {
		llmURL = cfg.OllamaURL
		llmModel = cfg.OllamaModel
	}
	
	if llmURL != "" {
		ollamaClient = ollama.NewClient(llmURL, llmModel, cfg.LLMProvider, cfg.LLMAPIKey, cfg.Debug)
		if cfg.Debug {
			fmt.Printf("LLM client initialized: provider=%s, url=%s, model=%s\n", cfg.LLMProvider, llmURL, llmModel)
		}
	}

	// Initialize AWS Pricing client
	// REQUIRES AWS credentials - uses GetProducts API (queries specific instance types, no 400MB download)
	awsPricingClient, err := awspricing.NewClient(
		cfg.AWSRegion,
		cfg.AWSAccessKeyID,
		cfg.AWSSecretAccessKey,
		cfg.AWSSessionToken,
	)
	if err != nil {
		fmt.Printf("Error: Failed to initialize AWS Pricing API client: %v\n", err)
		fmt.Printf("AWS credentials are required. Set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and optionally AWS_SESSION_TOKEN environment variables,\n")
		fmt.Printf("or configure AWS credentials via IAM role, ~/.aws/credentials, or AWS SDK default credential chain.\n")
		// Don't continue without AWS credentials - pricing queries will fail
		awsPricingClient = nil
	} else {
		// Always log successful initialization (not just in debug mode)
		if cfg.AWSAccessKeyID != "" {
			fmt.Printf("AWS Pricing API client initialized with explicit credentials (using GetProducts API)\n")
		} else {
			fmt.Printf("AWS Pricing API client initialized with default credentials (using GetProducts API)\n")
		}
		if cfg.Debug {
			fmt.Printf("Debug: AWS Region=%s, Pricing API endpoint=us-east-1\n", cfg.AWSRegion)
		}
	}

	return &Recommender{
		config:       cfg,
		ollamaClient: ollamaClient,
		awsPricing:   awsPricingClient,
		priceCache:   make(map[string]float64),
	}
}

func (r *Recommender) SetK8sClient(client *kubernetes.Client) {
	r.k8sClient = client
}

type Workload struct {
	Name          string
	Namespace     string
	CPU           string // e.g., "100m", "2", "1.5" - can be request or limit
	Memory        string // e.g., "128Mi", "2Gi", "4G" - can be request or limit
	GPU           int
	Labels        map[string]string
	CPUUsage      *float64 // Reserved for future use (not currently used)
	MemoryUsage   *float64 // Reserved for future use (not currently used)
	CPURequest    string   // CPU request if different from CPU
	MemoryRequest string   // Memory request if different from Memory
	WorkloadType  string   // deployment, statefulset, daemonset
}

type NodePoolRecommendation struct {
	Name             string            `json:"name"`
	InstanceTypes    []string          `json:"instanceTypes"`
	CapacityType     string            `json:"capacityType"` // spot, on-demand
	Architecture     string            `json:"architecture"` // amd64, arm64
	MinSize          int               `json:"minSize"`
	MaxSize          int               `json:"maxSize"`
	Labels           map[string]string `json:"labels"`
	Requirements     Requirements      `json:"requirements"`
	EstimatedCost    float64           `json:"estimatedCost"`
	Reasoning        string            `json:"reasoning"`
	WorkloadsMatched []string          `json:"workloadsMatched"`
	CurrentState     *CurrentState     `json:"currentState,omitempty"` // Before state
}

type CurrentState struct {
	EstimatedCost float64           `json:"estimatedCost"`
	TotalNodes    int               `json:"totalNodes"`
	TotalCPU      float64           `json:"totalCPU"`
	TotalMemory   float64           `json:"totalMemory"`
	InstanceTypes []string          `json:"instanceTypes"`
	CapacityType  string            `json:"capacityType"`
	MinSize       int               `json:"minSize"`
	MaxSize       int               `json:"maxSize"`
	Architecture  string            `json:"architecture"`
	Labels        map[string]string `json:"labels"`
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

// enrichWithMetrics removed - Prometheus is no longer used for recommendations
// Recommendations are now based on Kubernetes resource requests and node usage data

// GenerateRecommendationsFromClusterSummary generates recommendations based on cluster-wide
// CPU and Memory usage (from node usage data)
// progressCallback is optional - if provided, it will be called with progress updates
func (r *Recommender) GenerateRecommendationsFromClusterSummary(clusterCPUUsed, clusterCPUAllocatable, clusterMemoryUsed, clusterMemoryAllocatable float64, totalNodes, spotNodes, onDemandNodes, totalPods int, progressCallback ProgressCallback) ([]NodePoolRecommendation, error) {
	if r.k8sClient == nil {
		return nil, fmt.Errorf("kubernetes client not configured")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// Progress: Starting
	if progressCallback != nil {
		progressCallback("Starting recommendation generation...", 0.0)
	}

	// Get all existing NodePools
	if progressCallback != nil {
		progressCallback("Fetching NodePools from cluster...", 5.0)
	}
	nodePools, err := r.k8sClient.ListNodePools(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to list NodePools: %w", err)
	}

	if len(nodePools) == 0 {
		if progressCallback != nil {
			progressCallback("No NodePools found in cluster", 100.0)
		}
		return []NodePoolRecommendation{}, nil
	}

	// Get disruptions for NodePool-specific analysis
	if progressCallback != nil {
		progressCallback("Analyzing node disruptions...", 10.0)
	}
	disruptionCtx, disruptionCancel := context.WithTimeout(context.Background(), 30*time.Second)
	disruptions, err := r.k8sClient.GetNodeDisruptions(disruptionCtx, 168) // Last 7 days
	disruptionCancel()
	if err != nil {
		disruptions = []kubernetes.NodeDisruptionInfo{} // Use empty list if fetch fails
	}

	var recommendations []NodePoolRecommendation

	// Cluster-wide metrics are kept for context only, but each NodePool will be analyzed individually

	// Get actual nodes with usage data to get accurate current state
	if progressCallback != nil {
		progressCallback("Fetching node usage data...", 15.0)
	}
	allNodesWithUsage, err := r.k8sClient.GetAllNodesWithUsage(ctx)
	if err != nil {
		// Fallback to using NodePool data if we can't get node usage
		fmt.Printf("Warning: Could not fetch node usage data: %v\n", err)
		allNodesWithUsage = []kubernetes.NodeInfo{}
	}

	// Group nodes by NodePool for accurate counting
	nodesByNodePool := make(map[string][]kubernetes.NodeInfo)
	for _, node := range allNodesWithUsage {
		if node.NodePool != "" {
			nodesByNodePool[node.NodePool] = append(nodesByNodePool[node.NodePool], node)
		}
	}

	// For each NodePool, generate recommendations based on cluster-wide usage
	totalNodePools := len(nodePools)
	for i, np := range nodePools {
		// Progress: Processing NodePool
		if progressCallback != nil {
			progress := 20.0 + (float64(i)/float64(totalNodePools))*70.0 // 20% to 90%
			progressCallback(fmt.Sprintf("Analyzing NodePool '%s' (%d/%d)...", np.Name, i+1, totalNodePools), progress)
		}
		// Get actual nodes for this NodePool from node usage data
		// Explicitly check if the NodePool exists in the map to avoid nil slice issues
		actualNodes, exists := nodesByNodePool[np.Name]
		if !exists {
			actualNodes = []kubernetes.NodeInfo{} // Ensure it's an empty slice, not nil
		}
		actualNodeCount := len(actualNodes)

		// Skip NodePools with 0 nodes - no data to base recommendations on
		if actualNodeCount == 0 {
			if progressCallback != nil {
				progress := 20.0 + (float64(i)/float64(totalNodePools))*70.0
				progressCallback(fmt.Sprintf("Skipping NodePool '%s' (0 nodes, no usage data)", np.Name), progress)
			}
			continue
		}

		// Calculate actual CPU/Memory usage from actual nodes for THIS NodePool
		// Explicitly initialize all variables to zero to prevent values from previous iterations
		npCPUUsed := 0.0
		npMemoryUsed := 0.0
		npCPUAllocatable := 0.0
		npMemoryAllocatable := 0.0
		actualInstanceTypes := []string{} // Initialize as empty slice
		instanceTypeSet := make(map[string]bool)

		// Use actual node data for this NodePool (actualNodeCount > 0 already checked above)
		for _, node := range actualNodes {
			if node.CPUUsage != nil {
				npCPUUsed += node.CPUUsage.Used
				npCPUAllocatable += node.CPUUsage.Allocatable
			}
			if node.MemoryUsage != nil {
				npMemoryUsed += node.MemoryUsage.Used
				npMemoryAllocatable += node.MemoryUsage.Allocatable
			}
			// Collect unique instance types
			if node.InstanceType != "" && !instanceTypeSet[node.InstanceType] {
				actualInstanceTypes = append(actualInstanceTypes, node.InstanceType)
				instanceTypeSet[node.InstanceType] = true
			}
		}

		// Calculate NodePool-specific utilization metrics
		// If there are 0 nodes, utilization is 0% (no usage data)
		npCPUUtilization := 0.0
		npMemoryUtilization := 0.0
		if actualNodeCount > 0 && npCPUAllocatable > 0 {
			npCPUUtilization = (npCPUUsed / npCPUAllocatable) * 100
		}
		if actualNodeCount > 0 && npMemoryAllocatable > 0 {
			npMemoryUtilization = (npMemoryUsed / npMemoryAllocatable) * 100
		}

		// Determine if THIS NodePool is overprovisioned (based on its own metrics)
		// Get disruptions specific to this NodePool
		var npDisruptionInsights DisruptionInsights
		for _, disruption := range disruptions {
			if disruption.NodePool == np.Name {
				// Count disruptions for this NodePool
				switch disruption.Reason {
				case "Consolidation":
					npDisruptionInsights.ConsolidationCount++
				case "Expiration", "Drift":
					npDisruptionInsights.ExpirationCount++
				case "Termination":
					npDisruptionInsights.TerminationCount++
				}
				npDisruptionInsights.TotalDisruptions++
			}
		}
		// Calculate consolidation rate for this NodePool (per day, assuming 7 days of data)
		if npDisruptionInsights.ConsolidationCount > 0 {
			npDisruptionInsights.ConsolidationRate = float64(npDisruptionInsights.ConsolidationCount) / 7.0
			npDisruptionInsights.HasHighConsolidation = npDisruptionInsights.ConsolidationRate > 2.0
		}
		npDisruptionInsights.HasExpirationIssues = npDisruptionInsights.ExpirationCount > 5

		// Skip utilization-based calculations if there are no nodes
		// If there are 0 nodes, there's no usage data, so we can't calculate utilization
		var isNPOverprovisioned bool
		var requiredCPU, requiredMemory float64
		var targetUtilization float64

		if actualNodeCount == 0 {
			// No nodes = no usage = no utilization calculations
			isNPOverprovisioned = false
			requiredCPU = 0
			requiredMemory = 0
			targetUtilization = 0.75 // Default
		} else {
			// Determine if THIS NodePool is overprovisioned based on its own metrics
			isNPOverprovisioned = npCPUUtilization < 50 || npMemoryUtilization < 50 || npDisruptionInsights.HasHighConsolidation

			// Calculate target CPU/Memory based on desired utilization (70-80% for efficiency)
			// Use NodePool-specific overprovisioning status
			targetUtilization = 0.75 // 75% target utilization
			if isNPOverprovisioned {
				targetUtilization = 0.85 // Higher utilization if this NodePool is overprovisioned
			}

			// Calculate required resources to achieve target utilization
			requiredCPU = npCPUUsed / targetUtilization
			requiredMemory = npMemoryUsed / targetUtilization

			// Add 20% buffer for overhead
			requiredCPU *= 1.2
			requiredMemory *= 1.2

			// Safety check: Prevent drastic node reductions unless utilization is extremely low
			// Calculate estimated nodes needed BEFORE we calculate avgCPUPerNode
			if npCPUUsed > 0 && npMemoryUsed > 0 {
				// Rough estimate of average node capacity for safety check
				roughAvgCPU := 4.0
				roughAvgMemory := 8.0
				if len(actualInstanceTypes) > 0 {
					totalCPU, totalMem := 0.0, 0.0
					for _, it := range actualInstanceTypes {
						cpu, mem := r.estimateInstanceCapacity(it)
						totalCPU += cpu
						totalMem += mem
					}
					roughAvgCPU = totalCPU / float64(len(actualInstanceTypes))
					roughAvgMemory = totalMem / float64(len(actualInstanceTypes))
				}

				roughNodesNeeded := int(math.Ceil(math.Max(requiredCPU/roughAvgCPU, requiredMemory/roughAvgMemory)))

				// Maximum reduction: 50% unless utilization is extremely low (<25%)
				maxReductionPercent := 0.5
				if npCPUUtilization < 25 && npMemoryUtilization < 25 {
					maxReductionPercent = 0.7 // Allow up to 70% reduction only if utilization is very low
				}

				minNodes := int(math.Max(1, float64(actualNodeCount)*(1.0-maxReductionPercent)))
				if roughNodesNeeded < minNodes {
					// Adjust required resources to meet minimum node count (more conservative)
					requiredCPU = roughAvgCPU * float64(minNodes) * targetUtilization * 1.2
					requiredMemory = roughAvgMemory * float64(minNodes) * targetUtilization * 1.2
				}
			}
		}

		// Use actual instance types from nodes, fallback to NodePool config
		currentTypes := actualInstanceTypes
		if len(currentTypes) == 0 {
			// Use NodePool's configured instance types (from spec)
			currentTypes = np.InstanceTypes
			// If still empty, we can't make assumptions - leave empty and handle later
		}

		// Calculate nodes needed
		// Estimate average node capacity from current instance types
		avgCPUPerNode := 4.0 // Default estimate
		avgMemoryPerNode := 8.0
		if len(currentTypes) > 0 {
			totalCPU, totalMem := 0.0, 0.0
			for _, it := range currentTypes {
				cpu, mem := r.estimateInstanceCapacity(it)
				totalCPU += cpu
				totalMem += mem
			}
			avgCPUPerNode = totalCPU / float64(len(currentTypes))
			avgMemoryPerNode = totalMem / float64(len(currentTypes))
		}

		// If there are 0 nodes and no usage, recommend 0 nodes
		var nodesNeeded int
		var cpuPerNode, memoryPerNode float64
		var recommendedInstanceTypes []string

		if actualNodeCount == 0 && npCPUUsed == 0 && npMemoryUsed == 0 {
			nodesNeeded = 0
			cpuPerNode = 0
			memoryPerNode = 0
			recommendedInstanceTypes = currentTypes // Use current types (from NodePool config)
		} else {
			nodesNeeded = int(math.Ceil(math.Max(requiredCPU/avgCPUPerNode, requiredMemory/avgMemoryPerNode)))
			if nodesNeeded < 1 {
				nodesNeeded = 1
			}

			// Calculate per-node requirements
			cpuPerNode = requiredCPU / float64(nodesNeeded)
			memoryPerNode = requiredMemory / float64(nodesNeeded)

			// Select instance types
			recommendedInstanceTypes = r.selectInstanceTypes(cpuPerNode, memoryPerNode, 0)
			if len(recommendedInstanceTypes) == 0 {
				recommendedInstanceTypes = currentTypes // Fallback to current types
			}
		}

		// Determine capacity type based on actual nodes
		// Check what capacity types are actually being used
		spotNodeCount := 0
		onDemandNodeCount := 0
		for _, node := range actualNodes {
			capacityType := node.CapacityType
			if capacityType == "" {
				capacityType = np.CapacityType
			}
			// Normalize capacity type
			switch capacityType {
			case "on-demand", "onDemand", "ondemand", "":
				onDemandNodeCount++
			case "spot":
				spotNodeCount++
			default:
				// Unknown, default to on-demand
				onDemandNodeCount++
			}
		}

		// Determine recommended capacity type
		// If all nodes are already spot, keep spot
		// If there are on-demand nodes, recommend converting to spot for cost savings
		recommendedCapacityType := np.CapacityType
		if len(actualNodes) > 0 {
			if spotNodeCount == len(actualNodes) {
				// All nodes are already spot - keep spot
				recommendedCapacityType = "spot"
			} else if onDemandNodeCount > 0 {
				// There are on-demand nodes - recommend converting to spot
				recommendedCapacityType = "spot"
			} else {
				// Fallback to NodePool setting or default to spot
				if recommendedCapacityType == "" {
					recommendedCapacityType = "spot"
				}
			}
		} else {
			// No actual nodes - use NodePool default or recommend spot
			if recommendedCapacityType == "" {
				recommendedCapacityType = "spot"
			}
		}

		// Calculate min/max sizes
		recommendedMinSize := 0
		recommendedMaxSize := int(math.Ceil(float64(nodesNeeded) * 1.5)) // 50% headroom

		// Use Ollama to enhance recommendations if available
		// Use NodePool-specific metrics in reasoning
		reasoning := fmt.Sprintf("Based on NodePool '%s' usage: %.1f%% CPU, %.1f%% Memory utilization. ", np.Name, npCPUUtilization, npMemoryUtilization)
		if isNPOverprovisioned {
			reasoning += "This NodePool appears overprovisioned - recommending optimization. "
		}
		// Add capacity type recommendation context
		if len(actualNodes) > 0 && onDemandNodeCount > 0 && recommendedCapacityType == "spot" {
			reasoning += fmt.Sprintf("Found %d on-demand node(s) - recommend converting to spot instances for cost savings. ", onDemandNodeCount)
		} else if len(actualNodes) > 0 && spotNodeCount == len(actualNodes) && recommendedCapacityType == "spot" {
			reasoning += "All nodes are already spot instances - maintaining spot configuration. "
		}

		if r.ollamaClient != nil {
			if progressCallback != nil {
				progressCallback(fmt.Sprintf("Generating AI recommendations for '%s'...", np.Name), 20.0+(float64(i)/float64(totalNodePools))*60.0)
			}
			ollamaCtx, ollamaCancel := context.WithTimeout(context.Background(), 90*time.Second)
			enhancedReasoning, enhancedTypes, minSize, maxSize, ollamaCapacityType := r.enhanceWithOllamaFromClusterSummary(
				ollamaCtx, np, currentTypes, npCPUUsed, npMemoryUsed, npCPUAllocatable, npMemoryAllocatable,
				actualNodeCount, totalNodes, spotNodes, onDemandNodes, totalPods,
				npCPUUtilization, npMemoryUtilization, isNPOverprovisioned, npDisruptionInsights, actualNodes)
			ollamaCancel()

			if enhancedReasoning != "" {
				reasoning = enhancedReasoning
			}
			if len(enhancedTypes) > 0 {
				recommendedInstanceTypes = enhancedTypes
			}
			if minSize != nil {
				recommendedMinSize = *minSize
			}
			if maxSize != nil {
				recommendedMaxSize = *maxSize
			}
			if ollamaCapacityType != "" {
				recommendedCapacityType = ollamaCapacityType
			}
		}

		// Calculate cost
		recommendedCost := r.estimateCost(context.Background(), recommendedInstanceTypes, recommendedCapacityType, nodesNeeded)

		// Calculate total CPU/Memory that would be provisioned with recommended configuration
		// Distribute nodes evenly across instance types (like Karpenter does)
		var totalProvisionedCPU, totalProvisionedMemory float64
		if len(recommendedInstanceTypes) > 0 && nodesNeeded > 0 {
			nodesPerType := nodesNeeded / len(recommendedInstanceTypes)
			remainder := nodesNeeded % len(recommendedInstanceTypes)
			for i, it := range recommendedInstanceTypes {
				cpu, mem := r.estimateInstanceCapacity(it)
				nodesForThisType := nodesPerType
				if i < remainder {
					nodesForThisType++
				}
				totalProvisionedCPU += cpu * float64(nodesForThisType)
				totalProvisionedMemory += mem * float64(nodesForThisType)
			}
		}

		// Current state - use actual node data
		// Calculate cost based on actual instance types and counts
		currentCost := 0.0
		if len(actualNodes) > 0 {
			// Count nodes by instance type and capacity type
			type nodeCount struct {
				count        int
				capacityType string
			}
			instanceTypeCounts := make(map[string]nodeCount)
			for _, node := range actualNodes {
				if node.InstanceType != "" {
					// Determine capacity type: prefer node's capacity type, then NodePool's, then default to on-demand
					capacityType := node.CapacityType
					if capacityType == "" {
						capacityType = np.CapacityType
					}
					if capacityType == "" {
						capacityType = "on-demand" // Default to on-demand (more conservative, avoids underestimating cost)
					}

					// Normalize capacity type values
					switch capacityType {
					case "on-demand", "onDemand", "ondemand":
						capacityType = "on-demand"
					case "spot":
						capacityType = "spot"
					default:
						// Unknown value, default to on-demand
						capacityType = "on-demand"
					}

					// Accumulate counts per instance type and capacity type
					key := fmt.Sprintf("%s:%s", node.InstanceType, capacityType)
					if existing, ok := instanceTypeCounts[key]; ok {
						existing.count++
						instanceTypeCounts[key] = existing
					} else {
						instanceTypeCounts[key] = nodeCount{count: 1, capacityType: capacityType}
					}
				}
			}
			// Calculate cost per instance type and capacity type combination
			for key, nc := range instanceTypeCounts {
				parts := strings.Split(key, ":")
				instanceType := parts[0]
				capacityType := nc.capacityType
				nodeCost := r.estimateCost(context.Background(), []string{instanceType}, capacityType, 1)
				currentCost += nodeCost * float64(nc.count)
			}
		} else {
			// No actual nodes - cost is 0 (same calculation as recommended cost)
			// Use NodePool's instance types and capacity type for consistency
			capacityType := np.CapacityType
			if capacityType == "" {
				capacityType = "on-demand" // Default to on-demand for accurate cost
			}
			// Normalize capacity type
			if capacityType == "on-demand" || capacityType == "onDemand" || capacityType == "ondemand" {
				capacityType = "on-demand"
			} else if capacityType != "spot" {
				capacityType = "on-demand"
			}

			// Use NodePool's configured instance types (currentTypes should already be set from np.InstanceTypes)
			typesForCost := currentTypes
			if len(typesForCost) == 0 {
				typesForCost = np.InstanceTypes
			}

			// Calculate cost using the same method as recommended cost: distribute nodes across instance types
			// For 0 nodes, this will return 0 (estimateCost handles 0 nodes correctly)
			if len(typesForCost) > 0 {
				currentCost = r.estimateCost(context.Background(), typesForCost, capacityType, actualNodeCount)
			} else {
				// No instance types configured - cost is 0
				currentCost = 0.0
			}
		}

		// Calculate current total CPU/Memory capacity from current instance types
		// If there are 0 nodes, capacity is 0 (no nodes = no capacity)
		var currentTotalCPU, currentTotalMemory float64
		if actualNodeCount == 0 {
			// No nodes = no capacity
			currentTotalCPU = 0.0
			currentTotalMemory = 0.0
		} else if len(currentTypes) > 0 {
			// Estimate capacity from current instance types based on actual node count
			for _, it := range currentTypes {
				cpu, mem := r.estimateInstanceCapacity(it)
				currentTotalCPU += cpu * float64(actualNodeCount) / float64(len(currentTypes))
				currentTotalMemory += mem * float64(actualNodeCount) / float64(len(currentTypes))
			}
		} else {
			// No instance types - use actual allocatable as capacity estimate
			currentTotalCPU = npCPUAllocatable
			currentTotalMemory = npMemoryAllocatable
		}

		// Validate that recommendation doesn't significantly increase costs
		// If recommended cost is more than 10% higher than current cost, skip this recommendation
		// Recommendations should aim to reduce costs, not increase them
		if currentCost > 0 && recommendedCost > currentCost*1.1 {
			if progressCallback != nil {
				progressCallback(fmt.Sprintf("Skipping NodePool '%s' - recommendation would increase costs (current: $%.2f/hr, recommended: $%.2f/hr)", np.Name, currentCost, recommendedCost), 20.0+(float64(i)/float64(totalNodePools))*70.0)
			}
			continue // Skip this recommendation as it would increase costs
		}

		currentState := &CurrentState{
			InstanceTypes: currentTypes,
			CapacityType:  np.CapacityType,
			TotalNodes:    actualNodeCount,    // Use actual node count from node usage
			TotalCPU:      currentTotalCPU,    // Total CPU capacity, not just used
			TotalMemory:   currentTotalMemory, // Total Memory capacity, not just used
			EstimatedCost: currentCost,
			MinSize:       np.MinSize,
			MaxSize:       np.MaxSize,
			Architecture:  np.Architecture,
			Labels:        np.Labels,
		}

		recommendations = append(recommendations, NodePoolRecommendation{
			Name:          np.Name,
			InstanceTypes: recommendedInstanceTypes,
			CapacityType:  recommendedCapacityType,
			Architecture:  np.Architecture,
			MinSize:       recommendedMinSize,
			MaxSize:       recommendedMaxSize,
			Labels:        np.Labels,
			Requirements: Requirements{
				CPU: ResourceRange{
					Min: fmt.Sprintf("%.1f", requiredCPU*0.8),
					Max: fmt.Sprintf("%.1f", requiredCPU*1.2),
				},
				Memory: ResourceRange{
					Min: fmt.Sprintf("%.1fGi", requiredMemory*0.8),
					Max: fmt.Sprintf("%.1fGi", requiredMemory*1.2),
				},
				GPU: 0,
			},
			EstimatedCost:    recommendedCost,
			Reasoning:        reasoning + fmt.Sprintf(" Recommended configuration would provision %.1f CPU cores and %.1f GiB memory across %d node(s).", totalProvisionedCPU, totalProvisionedMemory, nodesNeeded),
			WorkloadsMatched: []string{fmt.Sprintf("NodePool '%s': %d nodes, %.1f%% CPU, %.1f%% Memory", np.Name, actualNodeCount, npCPUUtilization, npMemoryUtilization)},
			CurrentState:     currentState,
		})
	}

	// Progress: Complete
	if progressCallback != nil {
		progressCallback(fmt.Sprintf("Generated recommendations for %d NodePool(s)", len(recommendations)), 100.0)
	}

	return recommendations, nil
}

// enhanceWithOllamaFromClusterSummary uses Ollama to generate recommendations based on cluster summary
func (r *Recommender) enhanceWithOllamaFromClusterSummary(ctx context.Context, np kubernetes.NodePoolInfo, currentTypes []string,
	npCPUUsed, npMemoryUsed, npCPUAllocatable, npMemoryAllocatable float64,
	currentNodes, totalNodes, spotNodes, onDemandNodes, totalPods int,
	cpuUtilization, memoryUtilization float64, isOverprovisioned bool, disruptionInsights DisruptionInsights,
	actualNodes []kubernetes.NodeInfo) (string, []string, *int, *int, string) {

	prompt := r.buildOllamaPromptFromClusterSummary(np, currentTypes, npCPUUsed, npMemoryUsed, npCPUAllocatable, npMemoryAllocatable,
		currentNodes, totalNodes, spotNodes, onDemandNodes, totalPods, cpuUtilization, memoryUtilization, isOverprovisioned, disruptionInsights, actualNodes)

	response, err := r.ollamaClient.Chat(ctx, prompt)
	if err != nil {
		fmt.Printf("Ollama request failed: %v\n", err)
		return "", currentTypes, nil, nil, ""
	}

	// Parse Ollama response
	var ollamaRec struct {
		Reasoning     string   `json:"reasoning"`
		InstanceTypes []string `json:"instanceTypes"`
		Explanation   string   `json:"explanation"`
		MinSize       *int     `json:"minSize,omitempty"`
		MaxSize       *int     `json:"maxSize,omitempty"`
		CapacityType  string   `json:"capacityType,omitempty"`
	}

	if err := json.Unmarshal([]byte(response), &ollamaRec); err != nil {
		// Try to extract JSON from markdown code blocks
		jsonStart := strings.Index(response, "{")
		jsonEnd := strings.LastIndex(response, "}")
		if jsonStart >= 0 && jsonEnd > jsonStart {
			jsonStr := response[jsonStart : jsonEnd+1]
			if err := json.Unmarshal([]byte(jsonStr), &ollamaRec); err != nil {
				return response, currentTypes, nil, nil, ""
			}
		} else {
			return response, currentTypes, nil, nil, ""
		}
	}

	instanceTypes := currentTypes
	if len(ollamaRec.InstanceTypes) > 0 {
		instanceTypes = ollamaRec.InstanceTypes
	}

	reasoning := ollamaRec.Explanation
	if ollamaRec.Reasoning != "" {
		if reasoning != "" {
			reasoning += ". " + ollamaRec.Reasoning
		} else {
			reasoning = ollamaRec.Reasoning
		}
	}

	return reasoning, instanceTypes, ollamaRec.MinSize, ollamaRec.MaxSize, ollamaRec.CapacityType
}

// buildOllamaPromptFromClusterSummary creates a prompt for Ollama based on cluster summary data
func (r *Recommender) buildOllamaPromptFromClusterSummary(np kubernetes.NodePoolInfo, currentTypes []string,
	npCPUUsed, npMemoryUsed, npCPUAllocatable, npMemoryAllocatable float64,
	currentNodes, totalNodes, spotNodes, onDemandNodes, totalPods int,
	cpuUtilization, memoryUtilization float64, isOverprovisioned bool, disruptionInsights DisruptionInsights,
	actualNodes []kubernetes.NodeInfo) string {

	// Determine actual capacity type distribution
	actualSpotCount := 0
	actualOnDemandCount := 0
	for _, node := range actualNodes {
		capType := node.CapacityType
		if capType == "" {
			capType = np.CapacityType
		}
		if capType == "spot" {
			actualSpotCount++
		} else {
			actualOnDemandCount++
		}
	}

	capacityTypeContext := ""
	if len(actualNodes) > 0 {
		if actualSpotCount == len(actualNodes) {
			capacityTypeContext = fmt.Sprintf("\nIMPORTANT: All %d nodes in this NodePool are already using SPOT instances. DO NOT recommend changing capacity type - keep it as 'spot'.", len(actualNodes))
		} else if actualOnDemandCount > 0 {
			capacityTypeContext = fmt.Sprintf("\nIMPORTANT: This NodePool has %d on-demand node(s) and %d spot node(s). Recommend converting on-demand nodes to SPOT instances for cost savings (75%% discount).", actualOnDemandCount, actualSpotCount)
		}
	}

	// Build concise disruption summary
	disruptionSummary := ""
	if disruptionInsights.HasHighConsolidation {
		disruptionSummary = fmt.Sprintf("High consolidation (%d/day) - reduce nodes.", int(disruptionInsights.ConsolidationRate))
	} else if disruptionInsights.TotalDisruptions > 0 {
		disruptionSummary = fmt.Sprintf("%d disruptions (consolidations: %d)", disruptionInsights.TotalDisruptions, disruptionInsights.ConsolidationCount)
	}

	prompt := fmt.Sprintf(`Karpenter NodePool optimization for: %s

Current: %d nodes, types: %v, capacity: %s, arch: %s, size: %d-%d
Usage: CPU %.1f%% (%.2f/%.2f cores), Memory %.1f%% (%.2f/%.2f GiB)
%s%s

Rules:
- No GPU unless required
- Low util (<50%%) or high consolidation → reduce nodes, smaller types
- Capacity: %s
- Diversity: 3-5 types (c/m/r/t families)
- Headroom: 20-30%% normal, 10-15%% if consolidating

Return JSON only:
{"reasoning":"brief why","instanceTypes":["m6i.2xlarge"],"minSize":0,"maxSize":10,"capacityType":"spot","explanation":"concise explanation"}`,
		np.Name,
		currentNodes,
		currentTypes,
		np.CapacityType,
		np.Architecture,
		np.MinSize,
		np.MaxSize,
		cpuUtilization,
		npCPUUsed,
		npCPUAllocatable,
		memoryUtilization,
		npMemoryUsed,
		npMemoryAllocatable,
		func() string {
			if disruptionSummary != "" {
				return "Disruptions: " + disruptionSummary + " "
			}
			return ""
		}(),
		capacityTypeContext,
		func() string {
			if actualSpotCount == len(actualNodes) && len(actualNodes) > 0 {
				return "Keep spot (all nodes already spot)"
			} else if actualOnDemandCount > 0 {
				return fmt.Sprintf("Convert %d on-demand to spot", actualOnDemandCount)
			}
			return "Spot preferred for cost"
		}(),
	)

	return prompt
}

// GenerateClusterRecommendations analyzes all workloads in the cluster and recommends
// optimizations for existing Karpenter NodePools
func (r *Recommender) GenerateClusterRecommendations() ([]NodePoolRecommendation, error) {
	if r.k8sClient == nil {
		return nil, fmt.Errorf("kubernetes client not configured")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// Get all existing NodePools
	nodePools, err := r.k8sClient.ListNodePools(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to list NodePools: %w", err)
	}

	if len(nodePools) == 0 {
		return []NodePoolRecommendation{}, nil
	}

	// Get all workloads across all namespaces
	allWorkloads, err := r.k8sClient.ListAllWorkloads(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to list workloads: %w", err)
	}

	// Convert WorkloadInfo to Workload
	// Use requests (not limits) to match node usage calculation approach (eks-node-viewer style)
	workloads := make([]Workload, len(allWorkloads))
	for i, w := range allWorkloads {
		// Prefer requests over limits to match node usage calculation
		// This ensures recommendations are based on the same metric as node usage display
		cpu := w.CPURequest
		memory := w.MemoryRequest

		// Fallback to limits only if requests are not set (for backward compatibility)
		if cpu == "" {
			cpu = w.CPULimit
		}
		if memory == "" {
			memory = w.MemoryLimit
		}

		workloads[i] = Workload{
			Name:          w.Name,
			Namespace:     w.Namespace,
			CPU:           cpu,    // Use requests (matching node usage)
			Memory:        memory, // Use requests (matching node usage)
			CPURequest:    w.CPURequest,
			MemoryRequest: w.MemoryRequest,
			GPU:           w.GPU,
			Labels:        w.Labels,
			WorkloadType:  w.Type,
		}
	}

	// Get disruption data to inform recommendations
	// This returns live disruptions (nodes currently marked for deletion)
	// The hours parameter is only used for historical events of already-deleted nodes
	var disruptions []kubernetes.NodeDisruptionInfo
	if r.k8sClient != nil {
		disruptionCtx, disruptionCancel := context.WithTimeout(context.Background(), 30*time.Second)
		disruptions, _ = r.k8sClient.GetNodeDisruptions(disruptionCtx, 168) // Hours only for historical deleted nodes
		disruptionCancel()
	}

	// Match workloads to NodePools and generate recommendations for ALL NodePools
	var recommendations []NodePoolRecommendation
	for _, np := range nodePools {
		// Find workloads that match this NodePool
		matchedWorkloads := r.matchWorkloadsToNodePool(workloads, np)

		// Get disruptions for this NodePool
		nodePoolDisruptions := r.filterDisruptionsByNodePool(disruptions, np)

		// Generate recommendation for this NodePool even if no workloads match
		// (this allows us to see all NodePools and recommend optimizations or removal)
		rec := r.optimizeNodePool(np, matchedWorkloads, nodePoolDisruptions)
		recommendations = append(recommendations, rec)
	}

	return recommendations, nil
}

// filterDisruptionsByNodePool filters disruptions for a specific NodePool
func (r *Recommender) filterDisruptionsByNodePool(disruptions []kubernetes.NodeDisruptionInfo, np kubernetes.NodePoolInfo) []kubernetes.NodeDisruptionInfo {
	var filtered []kubernetes.NodeDisruptionInfo
	for _, d := range disruptions {
		if d.NodePool == np.Name {
			filtered = append(filtered, d)
		}
	}
	return filtered
}

// matchWorkloadsToNodePool matches workloads to a NodePool based on actual node assignments
// This ensures we only consider workloads that are actually running on nodes from this NodePool
func (r *Recommender) matchWorkloadsToNodePool(workloads []Workload, np kubernetes.NodePoolInfo) []Workload {
	if r.k8sClient == nil {
		// Fallback to label-based matching if k8s client not available
		return r.matchWorkloadsByLabels(workloads, np)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Get nodes that belong to this NodePool
	nodePoolNodes := make(map[string]bool)
	if len(np.ActualNodes) > 0 {
		// Use actual nodes from NodePool
		for _, node := range np.ActualNodes {
			nodePoolNodes[node.Name] = true
		}
	} else {
		// Fallback: try to get nodes by label
		nodes, err := r.k8sClient.GetNodesByNodePool(ctx, np.Name)
		if err == nil {
			for _, nodeName := range nodes {
				nodePoolNodes[nodeName] = true
			}
		}
	}

	if len(nodePoolNodes) == 0 {
		// No nodes found - fallback to label-based matching
		return r.matchWorkloadsByLabels(workloads, np)
	}

	// Get pods running on these nodes and match to workloads
	matchedWorkloads := r.matchWorkloadsByNodes(ctx, workloads, nodePoolNodes, np.Name)

	fmt.Printf("DEBUG: NodePool %s: matched %d workloads from %d total workloads\n", np.Name, len(matchedWorkloads), len(workloads))
	return matchedWorkloads
}

// matchWorkloadsByNodes matches workloads by finding pods running on NodePool nodes
func (r *Recommender) matchWorkloadsByNodes(ctx context.Context, workloads []Workload, nodePoolNodes map[string]bool, nodePoolName string) []Workload {
	if r.k8sClient == nil {
		return []Workload{}
	}

	// Get all pods across all namespaces
	allPods, err := r.k8sClient.GetPodsOnNodes(ctx, nodePoolNodes)
	if err != nil {
		fmt.Printf("DEBUG: Failed to get pods for NodePool %s: %v, falling back to label matching\n", nodePoolName, err)
		return []Workload{}
	}

	// Create a map of workload identifiers (namespace/name) to workloads
	workloadMap := make(map[string]Workload)
	for _, w := range workloads {
		key := fmt.Sprintf("%s/%s", w.Namespace, w.Name)
		workloadMap[key] = w
	}

	// Match pods to workloads
	matchedSet := make(map[string]bool)
	for _, pod := range allPods {
		// Extract workload name from pod (remove pod-specific suffix)
		workloadName := pod.WorkloadName
		key := fmt.Sprintf("%s/%s", pod.Namespace, workloadName)

		if _, exists := workloadMap[key]; exists {
			matchedSet[key] = true
		}
	}

	// Build matched workloads list
	var matched []Workload
	for key := range matchedSet {
		if w, exists := workloadMap[key]; exists {
			matched = append(matched, w)
		}
	}

	return matched
}

// matchWorkloadsByLabels fallback matching based on labels (less accurate)
func (r *Recommender) matchWorkloadsByLabels(workloads []Workload, np kubernetes.NodePoolInfo) []Workload {
	var matched []Workload

	for _, w := range workloads {
		// Match if workload has nodeSelector matching NodePool selector
		if len(np.Selector) == 0 {
			// No selector means NodePool accepts all workloads - but be conservative
			// Only match if NodePool name suggests it's a default/general pool
			if np.Name == "default" || strings.Contains(strings.ToLower(np.Name), "default") {
				matched = append(matched, w)
			}
		} else {
			// Check if workload labels match NodePool selector
			matches := true
			for k, v := range np.Selector {
				if w.Labels[k] != v {
					matches = false
					break
				}
			}
			if matches {
				matched = append(matched, w)
			}
		}
	}

	return matched
}

// DisruptionInsights contains insights derived from disruption patterns
type DisruptionInsights struct {
	ConsolidationCount    int     // Number of consolidation disruptions
	ExpirationCount       int     // Number of expiration/drift disruptions
	TerminationCount      int     // Number of termination disruptions
	TotalDisruptions      int     // Total disruptions
	ConsolidationRate     float64 // Consolidations per day (if data available)
	HasHighConsolidation  bool    // True if frequent consolidations indicate over-provisioning
	HasExpirationIssues   bool    // True if expirations indicate configuration issues
	AverageNodesDisrupted float64 // Average nodes disrupted per event
}

// analyzeDisruptions analyzes disruption patterns to derive insights
func (r *Recommender) analyzeDisruptions(disruptions []kubernetes.NodeDisruptionInfo) DisruptionInsights {
	insights := DisruptionInsights{
		TotalDisruptions: len(disruptions),
	}

	if len(disruptions) == 0 {
		return insights
	}

	// Count disruptions by type
	for _, d := range disruptions {
		reasonLower := strings.ToLower(d.Reason)
		if strings.Contains(reasonLower, "consolidat") {
			insights.ConsolidationCount++
		} else if strings.Contains(reasonLower, "expir") || strings.Contains(reasonLower, "drift") {
			insights.ExpirationCount++
		} else if strings.Contains(reasonLower, "terminat") || strings.Contains(reasonLower, "delet") {
			insights.TerminationCount++
		}
	}

	// Calculate consolidation rate (assuming 7 days of data)
	// If we have disruptions, estimate rate
	if insights.ConsolidationCount > 0 {
		insights.ConsolidationRate = float64(insights.ConsolidationCount) / 7.0 // Per day
		// High consolidation rate (>2 per day) suggests over-provisioning
		insights.HasHighConsolidation = insights.ConsolidationRate > 2.0
	}

	// Expiration issues if >20% of disruptions are expirations
	if insights.TotalDisruptions > 0 {
		expirationRatio := float64(insights.ExpirationCount) / float64(insights.TotalDisruptions)
		insights.HasExpirationIssues = expirationRatio > 0.2
	}

	insights.AverageNodesDisrupted = float64(insights.TotalDisruptions) / 7.0 // Per day estimate

	return insights
}

// optimizeNodePool generates optimization recommendations for an existing NodePool
func (r *Recommender) optimizeNodePool(np kubernetes.NodePoolInfo, workloads []Workload, disruptions []kubernetes.NodeDisruptionInfo) NodePoolRecommendation {
	// Calculate current state from actual nodes
	currentNodeCount := np.CurrentNodes
	var currentCost float64
	var actualInstanceTypes []string

	// Calculate cost from actual nodes if available
	if len(np.ActualNodes) > 0 {
		currentNodeCount = len(np.ActualNodes)
		instanceTypeCounts := make(map[string]int)

		for _, node := range np.ActualNodes {
			if node.InstanceType != "" {
				instanceTypeCounts[node.InstanceType]++
				// Track unique instance types
				found := false
				for _, it := range actualInstanceTypes {
					if it == node.InstanceType {
						found = true
						break
					}
				}
				if !found {
					actualInstanceTypes = append(actualInstanceTypes, node.InstanceType)
				}
			}
		}

		// Calculate cost based on actual nodes and their instance types
		for instanceType, count := range instanceTypeCounts {
			// Find capacity type for nodes of this instance type
			capacityType := np.CapacityType
			// Try to get capacity type from actual nodes
			for _, node := range np.ActualNodes {
				if node.InstanceType == instanceType && node.CapacityType != "" {
					capacityType = node.CapacityType
					break
				}
			}
			// Normalize and default capacity type
			if capacityType == "" {
				capacityType = "on-demand" // Default to on-demand (more conservative, avoids underestimating cost)
			}
			// Normalize capacity type values
			if capacityType == "on-demand" || capacityType == "onDemand" || capacityType == "ondemand" {
				capacityType = "on-demand"
			} else if capacityType != "spot" {
				// Unknown value, default to on-demand
				capacityType = "on-demand"
			}
			nodeCost := r.estimateCost(context.Background(), []string{instanceType}, capacityType, 1)
			currentCost += nodeCost * float64(count)
		}
	} else {
		// Fallback: estimate based on NodePool configuration
		if currentNodeCount == 0 {
			currentNodeCount = 1
		}
		if len(np.InstanceTypes) > 0 {
			// Use NodePool capacity type or default to on-demand
			capacityType := np.CapacityType
			if capacityType == "" {
				capacityType = "on-demand" // Default to on-demand for accurate cost
			}
			// Normalize capacity type
			if capacityType == "on-demand" || capacityType == "onDemand" || capacityType == "ondemand" {
				capacityType = "on-demand"
			} else if capacityType != "spot" {
				capacityType = "on-demand"
			}
			currentCost = r.estimateCost(context.Background(), np.InstanceTypes, capacityType, currentNodeCount)
			actualInstanceTypes = np.InstanceTypes
		}
	}

	if len(actualInstanceTypes) == 0 {
		actualInstanceTypes = np.InstanceTypes
	}

	currentState := &CurrentState{
		InstanceTypes: actualInstanceTypes,
		CapacityType:  np.CapacityType,
		TotalCPU:      0,
		TotalMemory:   0,
		TotalNodes:    currentNodeCount,
		EstimatedCost: currentCost,
		MinSize:       np.MinSize,
		MaxSize:       np.MaxSize,
		Architecture:  np.Architecture,
		Labels:        np.Labels,
	}

	// Calculate workload requirements based on resource requests
	var totalCPU, totalMemory float64
	var maxGPU int
	var workloadNames []string

	for _, w := range workloads {
		// Use resource requests
		// Prioritize CPURequest/MemoryRequest if available, fallback to CPU/Memory
		if w.CPURequest != "" {
			totalCPU += r.parseCPU(w.CPURequest)
		} else {
			totalCPU += r.parseCPU(w.CPU)
		}

		if w.MemoryRequest != "" {
			totalMemory += r.parseMemory(w.MemoryRequest)
		} else {
			totalMemory += r.parseMemory(w.Memory)
		}

		// Only count GPU if workload explicitly requests GPU resources (nvidia.com/gpu)
		// GPU must be > 0 to be considered
		if w.GPU > 0 {
			maxGPU = w.GPU
		}
		workloadNames = append(workloadNames, fmt.Sprintf("%s/%s", w.Namespace, w.Name))
	}

	// Debug: log GPU detection
	if maxGPU > 0 {
		fmt.Printf("DEBUG: Detected GPU requirement: %d GPUs across workloads\n", maxGPU)
	} else {
		fmt.Printf("DEBUG: No GPU requirements detected - using regular instances\n")
	}

	// Add buffer for overhead (using resource requests)
	totalCPU *= 1.3 // Buffer for requests/limits
	totalMemory *= 1.3
	fmt.Printf("DEBUG: Using resource requests for sizing: CPU=%.2f, Memory=%.2f\n", totalCPU, totalMemory)

	// Calculate current node capacity
	currentCapacityCPU, currentCapacityMemory := r.calculateCurrentCapacity(np, currentNodeCount)

	// Analyze disruptions to get insights
	disruptionInsights := r.analyzeDisruptions(disruptions)

	// Determine if we're overprovisioned
	// Use disruption insights to inform this decision
	isOverprovisioned := currentCapacityCPU > totalCPU*1.5 && currentCapacityMemory > totalMemory*1.5

	// If we have high consolidation rate, it's a strong indicator of over-provisioning
	// Adjust the threshold to be more aggressive in recommending reductions
	if disruptionInsights.HasHighConsolidation {
		// High consolidation = nodes being frequently consolidated = over-provisioned
		isOverprovisioned = true
		// Be more aggressive - even 1.3x capacity might be too much
		// Additional check can be added here in the future if needed
	}

	// Calculate optimal instance types and node count based on actual needs
	// Only recommend GPU if workloads actually need GPU
	if maxGPU == 0 {
		// No GPU needed - use regular instances
		cpuPerNode := math.Max(totalCPU/4.0, 1.0) // Rough estimate for general purpose nodes, minimum 1
		memoryPerNode := math.Max(totalMemory/8.0, 1.0) // Minimum 1

		recommendedInstanceTypes := r.selectInstanceTypes(cpuPerNode, memoryPerNode, 0) // Explicitly 0 GPU
		recommendedCapacityType := r.selectCapacityType(workloads, isOverprovisioned)
		recommendedArchitecture := r.selectArchitecture(workloads)

		// Calculate nodes needed - if overprovisioned, recommend fewer nodes
		var nodesNeeded int
		if isOverprovisioned && currentNodeCount > 0 {
			// If we have high consolidation, be more aggressive in reducing nodes
			reductionFactor := 0.8 // Default 20% reduction
			if disruptionInsights.HasHighConsolidation {
				reductionFactor = 0.7 // 30% reduction for high consolidation
			}

			// Recommend reducing nodes - aim for appropriate overhead based on consolidation
			overheadMultiplier := 1.2 // Default 20% overhead
			if disruptionInsights.HasHighConsolidation {
				overheadMultiplier = 1.1 // Only 10% overhead if consolidating frequently
			}

			nodesNeeded = int(math.Ceil(math.Max(totalCPU*overheadMultiplier/4, totalMemory*overheadMultiplier/8)))
			if nodesNeeded >= currentNodeCount {
				// Don't recommend more than current if overprovisioned
				nodesNeeded = int(math.Max(1, float64(currentNodeCount)*reductionFactor))
			}
		} else {
			// Normal case - calculate based on needs
			nodesNeeded = int(math.Ceil(math.Max(totalCPU*1.2/4, totalMemory*1.2/8)))
		}
		if nodesNeeded < 1 {
			nodesNeeded = 1
		}

		recommendedCost := r.estimateCost(context.Background(), recommendedInstanceTypes, recommendedCapacityType, nodesNeeded)

		// Update current state with calculated values
		currentState.TotalCPU = totalCPU
		currentState.TotalMemory = totalMemory
		// TotalNodes is already set from actual node count above - don't overwrite with calculated value

		// Generate educational reasoning
		reasoning := r.generateReasoning(workloads, totalCPU, totalMemory, 0, isOverprovisioned, currentNodeCount, nodesNeeded)

		// Add disruption insights with educational context
		if disruptionInsights.HasHighConsolidation {
			reasoning = fmt.Sprintf("Observing %.1f consolidations per day indicates frequent node underutilization. ", disruptionInsights.ConsolidationRate) + reasoning
		} else if disruptionInsights.HasExpirationIssues {
			reasoning = fmt.Sprintf("Noting %d expiration events suggests configuration adjustments may be needed. ", disruptionInsights.ExpirationCount) + reasoning
		}

		// Enhance recommendation with Ollama if available
		recommendedMinSize := 0
		recommendedMaxSize := nodesNeeded * 2

		// Adjust max size based on disruption insights
		// If high consolidation, reduce max size to prevent over-scaling
		if disruptionInsights.HasHighConsolidation {
			recommendedMaxSize = int(math.Ceil(float64(nodesNeeded) * 1.5)) // More conservative max
		}

		if r.ollamaClient != nil && len(workloads) > 0 {
			ollamaCtx, ollamaCancel := context.WithTimeout(context.Background(), 90*time.Second) // Longer timeout for gemma3:1b
			defer ollamaCancel()
			enhancedReasoning, enhancedTypes, minSize, maxSize, ollamaCapacityType := r.enhanceWithOllama(ollamaCtx, np, workloads, totalCPU, totalMemory, 0, recommendedInstanceTypes, isOverprovisioned, disruptionInsights)
			if enhancedReasoning != "" {
				// Use concise version - extract key points only
				reasoning = r.extractConciseReasoning(enhancedReasoning, reasoning)
			}
			if len(enhancedTypes) > 0 {
				recommendedInstanceTypes = enhancedTypes
				// Recalculate cost with new instance types
				recommendedCost = r.estimateCost(context.Background(), recommendedInstanceTypes, recommendedCapacityType, nodesNeeded)
			}
			if ollamaCapacityType != "" {
				recommendedCapacityType = ollamaCapacityType
				// Recalculate cost with new capacity type
				recommendedCost = r.estimateCost(context.Background(), recommendedInstanceTypes, recommendedCapacityType, nodesNeeded)
			}
			if minSize != nil {
				recommendedMinSize = *minSize
			}
			if maxSize != nil {
				recommendedMaxSize = *maxSize
			}
		}

		return NodePoolRecommendation{
			Name:          np.Name,
			InstanceTypes: recommendedInstanceTypes,
			CapacityType:  recommendedCapacityType,
			Architecture:  recommendedArchitecture,
			MinSize:       recommendedMinSize,
			MaxSize:       recommendedMaxSize,
			Labels:        np.Labels,
			Requirements: Requirements{
				CPU: ResourceRange{
					Min: fmt.Sprintf("%.1f", totalCPU*0.8),
					Max: fmt.Sprintf("%.1f", totalCPU*1.2),
				},
				Memory: ResourceRange{
					Min: fmt.Sprintf("%.1fGi", totalMemory*0.8),
					Max: fmt.Sprintf("%.1fGi", totalMemory*1.2),
				},
				GPU: 0, // Explicitly 0 - no GPU needed
			},
			EstimatedCost:    recommendedCost,
			Reasoning:        reasoning,
			WorkloadsMatched: workloadNames,
			CurrentState:     currentState,
		}
	} else {
		// GPU workloads - handle separately
		// Calculate instance types based on actual CPU/memory requirements, not hardcoded values
		cpuPerNode := math.Max(totalCPU/4.0, 1.0) // Minimum 1
		memoryPerNode := math.Max(totalMemory/8.0, 1.0) // Minimum 1

		recommendedInstanceTypes := r.selectInstanceTypes(cpuPerNode, memoryPerNode, maxGPU)
		recommendedCapacityType := r.selectCapacityType(workloads, false)
		recommendedArchitecture := r.selectArchitecture(workloads)
		nodesNeeded := int(math.Ceil(float64(maxGPU) / 4.0)) // Rough estimate: 4 GPUs per node
		if nodesNeeded < 1 {
			nodesNeeded = 1
		}
		recommendedCost := r.estimateCost(context.Background(), recommendedInstanceTypes, recommendedCapacityType, nodesNeeded)

		reasoning := r.generateReasoning(workloads, totalCPU, totalMemory, maxGPU, false, currentNodeCount, nodesNeeded)

		// Add disruption insights with educational context
		if disruptionInsights.HasHighConsolidation {
			reasoning = fmt.Sprintf("Observing %.1f consolidations per day indicates frequent node underutilization. ", disruptionInsights.ConsolidationRate) + reasoning
		} else if disruptionInsights.HasExpirationIssues {
			reasoning = fmt.Sprintf("Noting %d expiration events suggests configuration adjustments may be needed. ", disruptionInsights.ExpirationCount) + reasoning
		}

		// Add current configuration context (concise)
		if len(np.InstanceTypes) > 0 {
			reasoning += fmt.Sprintf(". Current: %d type(s)", len(np.InstanceTypes))
		}
		if np.CapacityType != "" {
			reasoning += fmt.Sprintf(". Capacity: %s", np.CapacityType)
		}
		reasoning = limitToWords(reasoning, 20)

		return NodePoolRecommendation{
			Name:          np.Name,
			InstanceTypes: recommendedInstanceTypes,
			CapacityType:  recommendedCapacityType,
			Architecture:  recommendedArchitecture,
			MinSize:       0,
			MaxSize:       nodesNeeded * 2,
			Labels:        np.Labels,
			Requirements: Requirements{
				CPU: ResourceRange{
					Min: fmt.Sprintf("%.1f", totalCPU*0.8),
					Max: fmt.Sprintf("%.1f", totalCPU*1.2),
				},
				Memory: ResourceRange{
					Min: fmt.Sprintf("%.1fGi", totalMemory*0.8),
					Max: fmt.Sprintf("%.1fGi", totalMemory*1.2),
				},
				GPU: maxGPU,
			},
			EstimatedCost:    recommendedCost,
			Reasoning:        reasoning,
			WorkloadsMatched: workloadNames,
			CurrentState:     currentState,
		}
	}
}

// enhanceWithOllama uses Ollama LLM to generate intelligent recommendations
func (r *Recommender) enhanceWithOllama(ctx context.Context, np kubernetes.NodePoolInfo, workloads []Workload, totalCPU, totalMemory float64, maxGPU int, currentTypes []string, isOverprovisioned bool, disruptionInsights DisruptionInsights) (string, []string, *int, *int, string) {
	// Build prompt for Ollama
	prompt := r.buildOllamaPrompt(np, workloads, totalCPU, totalMemory, maxGPU, currentTypes, isOverprovisioned, disruptionInsights)

	response, err := r.ollamaClient.Chat(ctx, prompt)
	if err != nil {
		// If Ollama fails, return original values
		fmt.Printf("Ollama request failed: %v\n", err)
		return "", currentTypes, nil, nil, ""
	}

	// Parse Ollama response (expecting JSON)
	var ollamaRec struct {
		Reasoning     string   `json:"reasoning"`
		InstanceTypes []string `json:"instanceTypes"`
		Explanation   string   `json:"explanation"`
		MinSize       *int     `json:"minSize,omitempty"`
		MaxSize       *int     `json:"maxSize,omitempty"`
		CapacityType  string   `json:"capacityType,omitempty"`
	}

	if err := json.Unmarshal([]byte(response), &ollamaRec); err != nil {
		// If JSON parsing fails, try to extract JSON from markdown code blocks
		jsonStart := strings.Index(response, "{")
		jsonEnd := strings.LastIndex(response, "}")
		if jsonStart >= 0 && jsonEnd > jsonStart {
			jsonStr := response[jsonStart : jsonEnd+1]
			if err := json.Unmarshal([]byte(jsonStr), &ollamaRec); err != nil {
				// If still fails, use response as reasoning
				return response, currentTypes, nil, nil, ""
			}
		} else {
			// If no JSON found, use response as reasoning
			return response, currentTypes, nil, nil, ""
		}
	}

	// Filter out GPU instances if not needed - CRITICAL: Never recommend GPU for non-GPU workloads
	instanceTypes := currentTypes
	if len(ollamaRec.InstanceTypes) > 0 {
		// ALWAYS remove GPU instances if maxGPU is 0 (no GPU workloads)
		filteredTypes := []string{}
		for _, it := range ollamaRec.InstanceTypes {
			itLower := strings.ToLower(it)
			// Only include GPU instances if workloads actually need GPU
			if strings.HasPrefix(itLower, "g4") || strings.HasPrefix(itLower, "g5") {
				if maxGPU > 0 {
					filteredTypes = append(filteredTypes, it)
				} else {
					fmt.Printf("DEBUG: Filtering out GPU instance %s - no GPU workloads detected\n", it)
				}
			} else {
				// Regular instances - always include
				filteredTypes = append(filteredTypes, it)
			}
		}
		if len(filteredTypes) > 0 {
			instanceTypes = filteredTypes
		} else if maxGPU == 0 {
			// If all instances were GPU and we filtered them out, use original types
			fmt.Printf("DEBUG: Ollama recommended only GPU instances but no GPU workloads - keeping original types\n")
			instanceTypes = currentTypes
		}
	}

	reasoning := ollamaRec.Explanation
	if ollamaRec.Reasoning != "" {
		if reasoning != "" {
			reasoning += ". " + ollamaRec.Reasoning
		} else {
			reasoning = ollamaRec.Reasoning
		}
	}

	// Return full Ollama reasoning - don't truncate AI-generated content

	return reasoning, instanceTypes, ollamaRec.MinSize, ollamaRec.MaxSize, ollamaRec.CapacityType
}

// buildOllamaPrompt creates a prompt for Ollama to generate recommendations
func (r *Recommender) buildOllamaPrompt(np kubernetes.NodePoolInfo, workloads []Workload, totalCPU, totalMemory float64, maxGPU int, currentTypes []string, isOverprovisioned bool, disruptionInsights DisruptionInsights) string {
	workloadSummary := make([]string, 0, len(workloads))
	for _, w := range workloads {
		// Use resource requests
		cpuStr := w.CPU
		if w.CPURequest != "" {
			cpuStr = w.CPURequest
		}
		memStr := w.Memory
		if w.MemoryRequest != "" {
			memStr = w.MemoryRequest
		}

		workloadSummary = append(workloadSummary, fmt.Sprintf("- %s/%s (%s): CPU=%s, Memory=%s",
			w.Namespace, w.Name, w.WorkloadType, cpuStr, memStr))
	}

	// Build disruption context for prompt
	disruptionContext := ""
	if disruptionInsights.TotalDisruptions > 0 {
		disruptionContext = fmt.Sprintf(`
Disruption Analysis (last 7 days):
- Total Disruptions: %d
- Consolidations: %d (%.1f per day)
- Expirations/Drift: %d
- Terminations: %d
- High Consolidation Rate: %v (indicates over-provisioning)
- Expiration Issues: %v (indicates configuration problems)

IMPORTANT: High consolidation rate (>2/day) strongly indicates over-provisioning. Recommend reducing node count and using smaller instance types.`,
			disruptionInsights.TotalDisruptions,
			disruptionInsights.ConsolidationCount,
			disruptionInsights.ConsolidationRate,
			disruptionInsights.ExpirationCount,
			disruptionInsights.TerminationCount,
			disruptionInsights.HasHighConsolidation,
			disruptionInsights.HasExpirationIssues)
	}

	prompt := fmt.Sprintf(`You are a Kubernetes infrastructure expert specializing in Karpenter NodePool optimization.

Current NodePool Configuration:
- Name: %s
- Current Instance Types: %v
- Capacity Type: %s
- Architecture: %s
- Current Nodes: %d
- Min Size: %d
- Max Size: %d

Workload Requirements (based on resource requests):
- Total CPU: %.2f cores
- Total Memory: %.2f GiB
- Max GPU: %d
- Number of workloads: %d

Workload Details:
%s%s

Please provide recommendations in JSON format:
{
  "reasoning": "Brief explanation of why these instance types and configuration are optimal",
	"instanceTypes": ["m6i.2xlarge", "m6i.4xlarge", "m6i.8xlarge"],
  "minSize": 0,
  "maxSize": 10,
  "capacityType": "spot" or "on-demand",
  "explanation": "Detailed explanation considering workload patterns, cost optimization, flexibility needs, and recommended NodePool configuration"
}

CRITICAL RULES:
1. DO NOT recommend GPU instances (g4dn, g5) unless workloads explicitly require GPU resources
2. If cluster is overprovisioned OR has high consolidation rate, recommend REDUCING node count and using smaller/cheaper instance types
3. High consolidation rate (>2/day) = STRONG indicator of over-provisioning - recommend 20-30%% node reduction
4. Frequent expirations indicate configuration issues - review instance types and capacity settings
5. Prefer spot instances for cost savings unless workloads require on-demand (check workload labels)
6. Instance type diversity for better bin-packing and availability (3-5 types recommended)
8. AWS instance families: c (compute), m (balanced), r (memory), t (burst) - NO GPU unless needed
9. Node capacity vs workload requirements with appropriate headroom:
   - Normal: 20-30%% overhead
   - High consolidation: 10-15%% overhead (reduce waste)
10. Recommended minSize and maxSize based on workload patterns, desired availability, AND disruption patterns
11. ALWAYS include "capacityType" field: "spot" for cost optimization or "on-demand" if workloads require it

Return only valid JSON, no markdown formatting.`,
		np.Name,
		currentTypes,
		np.CapacityType,
		np.Architecture,
		np.CurrentNodes,
		np.MinSize,
		np.MaxSize,
		totalCPU,
		totalMemory,
		maxGPU,
		len(workloads),
		strings.Join(workloadSummary, "\n"),
		disruptionContext,
	)

	return prompt
}

// Legacy methods for backward compatibility
func (r *Recommender) GetRecommendations(namespace string) ([]NodePoolRecommendation, error) {
	// Redirect to cluster-level recommendations
	return r.GenerateClusterRecommendations()
}

func (r *Recommender) GenerateRecommendations(namespace string) ([]NodePoolRecommendation, error) {
	// Redirect to cluster-level recommendations (namespace parameter ignored)
	return r.GenerateClusterRecommendations()
}

// Prometheus support removed - recommendations are now based on Kubernetes resource requests and node usage data

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
		// Use resource requests
		// Prioritize CPURequest/MemoryRequest if available, fallback to CPU/Memory
		if w.CPURequest != "" {
			totalCPU += r.parseCPU(w.CPURequest)
		} else {
			totalCPU += r.parseCPU(w.CPU)
		}

		if w.MemoryRequest != "" {
			totalMemory += r.parseMemory(w.MemoryRequest)
		} else {
			totalMemory += r.parseMemory(w.Memory)
		}

		if w.GPU > maxGPU {
			maxGPU = w.GPU
		}
		workloadNames = append(workloadNames, w.Name)
	}

	// Add buffer for overhead (using resource requests)
	totalCPU *= 1.3 // Buffer for requests/limits
	totalMemory *= 1.3

	// Calculate per-node requirements
	nodesNeeded := int(math.Ceil(math.Max(totalCPU/4, totalMemory/8))) // Rough estimate
	if nodesNeeded < 1 {
		nodesNeeded = 1
	}

	cpuPerNode := totalCPU / float64(nodesNeeded)
	memoryPerNode := totalMemory / float64(nodesNeeded)

	instanceTypes := r.selectInstanceTypes(cpuPerNode, memoryPerNode, maxGPU)
	capacityType := r.selectCapacityType(group, false) // Not checking overprovisioning in this path
	architecture := r.selectArchitecture(group)

		recommendedCost := r.estimateCost(context.Background(), instanceTypes, capacityType, nodesNeeded)

	// Try to get actual current state from existing NodePools
	var currentState *CurrentState
	if r.k8sClient != nil {
		currentState = r.getCurrentStateFromNodePools(group, workloadNames)
	}

	// Fall back to estimation if no NodePools found
	if currentState == nil {
		currentInstanceTypes := []string{"m5.large", "m5.xlarge", "m5.2xlarge"}
		currentCapacityType := "on-demand"
		currentNodes := int(math.Ceil(math.Max(totalCPU/2, totalMemory/4))) // More conservative estimate
		if currentNodes < 1 {
			currentNodes = 1
		}
		currentCost := r.estimateCost(context.Background(), currentInstanceTypes, currentCapacityType, currentNodes)

		currentState = &CurrentState{
			EstimatedCost: currentCost,
			TotalNodes:    currentNodes,
			TotalCPU:      totalCPU,
			TotalMemory:   totalMemory,
			InstanceTypes: currentInstanceTypes,
			CapacityType:  currentCapacityType,
		}
	}

	rec := NodePoolRecommendation{
		Name:          fmt.Sprintf("nodepool-%d", index),
		InstanceTypes: instanceTypes,
		CapacityType:  capacityType,
		Architecture:  architecture,
		MinSize:       0,
		MaxSize:       nodesNeeded * 2, // Allow scaling
		Labels:        r.extractCommonLabels(group),
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
		EstimatedCost:    recommendedCost,
		Reasoning:        r.generateReasoning(group, cpuPerNode, memoryPerNode, maxGPU, false, 0, nodesNeeded),
		WorkloadsMatched: workloadNames,
		CurrentState:     currentState,
	}

	return rec
}

func (r *Recommender) selectInstanceTypes(cpu, memory float64, gpu int) []string {
	// CRITICAL: Only return GPU instances if gpu > 0
	// This prevents recommending GPU instances for non-GPU workloads
	if gpu > 0 {
		fmt.Printf("DEBUG: Selecting GPU instances for %d GPU requirement\n", gpu)
		// GPU instances
		return []string{"g4dn.xlarge", "g4dn.2xlarge", "g5.xlarge", "g5.2xlarge"}
	}

	// No GPU - use regular instances
	fmt.Printf("DEBUG: Selecting regular instances (CPU: %.2f, Memory: %.2f)\n", cpu, memory)

	// CPU/Memory optimized instances
	var types []string

	if memory/cpu > 8 {
		// Memory optimized
		types = []string{"r6i.medium", "r6i.xlarge", "r6i.2xlarge", "r6i.4xlarge", "r6a.xlarge", "r6a.2xlarge"}
	} else if cpu > 8 {
		// CPU optimized
		types = []string{"c6i.xlarge", "c6i.2xlarge", "c6i.4xlarge", "c6a.xlarge", "c6a.2xlarge"}
	} else {
		// General purpose - use valid m6i sizes (2xlarge, 4xlarge, 8xlarge) - removed medium, large, and xlarge as they don't exist
		types = []string{"m6i.2xlarge", "m6i.4xlarge", "m6i.8xlarge", "m6a.xlarge", "m6a.2xlarge", "m6a.4xlarge", "t3.medium", "t3.large"}
	}

	// Limit to 3-5 instance types for better bin-packing
	if len(types) > 5 {
		types = types[:5]
	}

	return types
}

// calculateCurrentCapacity estimates current CPU and memory capacity based on instance types and node count
func (r *Recommender) calculateCurrentCapacity(np kubernetes.NodePoolInfo, nodeCount int) (float64, float64) {
	if nodeCount == 0 {
		return 0, 0
	}

	// Estimate capacity per node based on instance types
	var avgCPU, avgMemory float64
	instanceTypes := np.InstanceTypes
	if len(instanceTypes) == 0 && len(np.ActualNodes) > 0 {
		// Use actual instance types from nodes
		typeSet := make(map[string]bool)
		for _, node := range np.ActualNodes {
			if node.InstanceType != "" {
				typeSet[node.InstanceType] = true
			}
		}
		for it := range typeSet {
			instanceTypes = append(instanceTypes, it)
		}
	}

	if len(instanceTypes) == 0 {
		// Default estimate if no instance types
		return float64(nodeCount) * 4, float64(nodeCount) * 8
	}

	// Estimate CPU and memory per instance type
	for _, it := range instanceTypes {
		cpu, mem := r.estimateInstanceCapacity(it)
		avgCPU += cpu
		avgMemory += mem
	}

	if len(instanceTypes) > 0 {
		avgCPU /= float64(len(instanceTypes))
		avgMemory /= float64(len(instanceTypes))
	}

	return avgCPU * float64(nodeCount), avgMemory * float64(nodeCount)
}

// estimateInstanceCapacity estimates CPU and memory for an instance type
func (r *Recommender) estimateInstanceCapacity(instanceType string) (float64, float64) {
	it := strings.ToLower(instanceType)

	// Extract size multiplier
	multiplier := 1.0
	if strings.Contains(it, ".2xlarge") {
		multiplier = 2.0
	} else if strings.Contains(it, ".4xlarge") {
		multiplier = 4.0
	} else if strings.Contains(it, ".8xlarge") {
		multiplier = 8.0
	} else if strings.Contains(it, ".xlarge") {
		multiplier = 1.0
	} else if strings.Contains(it, ".large") {
		multiplier = 0.5
	} else if strings.Contains(it, ".medium") {
		multiplier = 0.25
	} else if strings.Contains(it, ".small") {
		multiplier = 0.125
	}

	// Base CPU and memory per family (per xlarge equivalent)
	var baseCPU, baseMemory float64
	if strings.HasPrefix(it, "t3") || strings.HasPrefix(it, "t4g") {
		baseCPU, baseMemory = 4, 4 // t3.xlarge: 4 vCPU, 16 GiB (but burstable)
	} else if strings.HasPrefix(it, "m6i") || strings.HasPrefix(it, "m6a") || strings.HasPrefix(it, "m5") {
		baseCPU, baseMemory = 4, 16 // m6i.xlarge: 4 vCPU, 16 GiB
	} else if strings.HasPrefix(it, "c6i") || strings.HasPrefix(it, "c6a") || strings.HasPrefix(it, "c5") {
		baseCPU, baseMemory = 4, 8 // c6i.xlarge: 4 vCPU, 8 GiB
	} else if strings.HasPrefix(it, "r6i") || strings.HasPrefix(it, "r6a") || strings.HasPrefix(it, "r5") {
		baseCPU, baseMemory = 4, 32 // r6i.xlarge: 4 vCPU, 32 GiB
	} else if strings.HasPrefix(it, "r8i") {
		baseCPU, baseMemory = 4, 32 // r8i.xlarge: 4 vCPU, 32 GiB
	} else if strings.HasPrefix(it, "x2gd") {
		baseCPU, baseMemory = 4, 32 // x2gd.xlarge: 4 vCPU, 32 GiB (Graviton2)
	} else if strings.HasPrefix(it, "x8g") {
		baseCPU, baseMemory = 4, 32 // x8g.xlarge: 4 vCPU, 32 GiB (Graviton3)
	} else if strings.HasPrefix(it, "m6g") || strings.HasPrefix(it, "m7g") || strings.HasPrefix(it, "m8g") {
		baseCPU, baseMemory = 4, 16 // m6g/m7g/m8g.xlarge: 4 vCPU, 16 GiB (Graviton)
	} else if strings.HasPrefix(it, "c6g") || strings.HasPrefix(it, "c7g") || strings.HasPrefix(it, "c6gn") {
		baseCPU, baseMemory = 4, 8 // c6g/c7g/c6gn.xlarge: 4 vCPU, 8 GiB (Graviton)
	} else if strings.HasPrefix(it, "r6g") || strings.HasPrefix(it, "r7g") {
		baseCPU, baseMemory = 4, 32 // r6g/r7g.xlarge: 4 vCPU, 32 GiB (Graviton)
	} else if strings.HasPrefix(it, "g4") || strings.HasPrefix(it, "g5") {
		baseCPU, baseMemory = 4, 16 // GPU instances
	} else {
		baseCPU, baseMemory = 4, 8 // Default
	}

	return baseCPU * multiplier, baseMemory * multiplier
}

func (r *Recommender) selectCapacityType(workloads []Workload, isOverprovisioned bool) string {
	// If overprovisioned, prefer spot for cost savings
	if isOverprovisioned {
		// Check if any workload requires on-demand
		for _, w := range workloads {
			if w.Labels["karpenter.sh/capacity-type"] == "on-demand" {
				return "on-demand"
			}
		}
		return "spot"
	}

	// Check if any workload has specific requirements
	for _, w := range workloads {
		if w.Labels["karpenter.sh/capacity-type"] == "on-demand" {
			return "on-demand"
		}
	}

	// Default to spot for cost optimization
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

// EstimateCost calculates the hourly cost for a given set of instance types, capacity type, and node count
// This is exported so it can be used by the API server for calculating total cluster costs
func (r *Recommender) EstimateCost(ctx context.Context, instanceTypes []string, capacityType string, nodeCount int) float64 {
	result, _ := r.estimateCostWithSource(ctx, instanceTypes, capacityType, nodeCount)
	return result.Cost
}

// EstimateCostWithSource calculates the hourly cost and returns pricing source information
func (r *Recommender) EstimateCostWithSource(ctx context.Context, instanceTypes []string, capacityType string, nodeCount int) (PricingResult, map[string]PricingSource) {
	return r.estimateCostWithSource(ctx, instanceTypes, capacityType, nodeCount)
}

func (r *Recommender) estimateCost(ctx context.Context, instanceTypes []string, capacityType string, nodeCount int) float64 {
	result, _ := r.estimateCostWithSource(ctx, instanceTypes, capacityType, nodeCount)
	return result.Cost
}

func (r *Recommender) estimateCostWithSource(ctx context.Context, instanceTypes []string, capacityType string, nodeCount int) (PricingResult, map[string]PricingSource) {
	// On-demand pricing (USD per hour) - US East (N. Virginia) region
	// Prices are from AWS Pricing API (approximate, may vary by region and time)
	onDemandPrices := map[string]float64{
		// T3 family (burstable)
		"t3.medium":  0.0416,
		"t3.large":   0.0832,
		"t3.xlarge":  0.1664,
		"t3.2xlarge": 0.3328,
		// M6i family (general purpose)
		"m6i.large":   0.096, // 2 vCPU, 8 GiB
		"m6i.xlarge":  0.192, // 4 vCPU, 16 GiB
		"m6i.2xlarge": 0.384, // 8 vCPU, 32 GiB
		"m6i.4xlarge": 0.768, // 16 vCPU, 64 GiB
		"m6i.8xlarge": 1.536, // 32 vCPU, 128 GiB
		// M6a family (AMD general purpose)
		"m6a.large":   0.0864,
		"m6a.xlarge":  0.1728,
		"m6a.2xlarge": 0.3456,
		"m6a.4xlarge": 0.6912,
		"m6a.8xlarge": 1.3824,
		// C6i family (compute optimized)
		"c6i.large":   0.085,
		"c6i.xlarge":  0.17,
		"c6i.2xlarge": 0.34,
		"c6i.4xlarge": 0.68,
		"c6i.8xlarge": 1.36,
		// C6a family (AMD compute optimized)
		"c6a.large":   0.0765,
		"c6a.xlarge":  0.153,
		"c6a.2xlarge": 0.306,
		"c6a.4xlarge": 0.612,
		"c6a.8xlarge": 1.224,
		// R6i family (memory optimized)
		"r6i.medium":  0.063, // 1 vCPU, 8 GiB
		"r6i.large":   0.126, // 2 vCPU, 16 GiB
		"r6i.xlarge":  0.252, // 4 vCPU, 32 GiB
		"r6i.2xlarge": 0.504, // 8 vCPU, 64 GiB
		"r6i.4xlarge": 1.008, // 16 vCPU, 128 GiB
		"r6i.8xlarge": 2.016, // 32 vCPU, 256 GiB
		// R6a family (AMD memory optimized)
		"r6a.large":   0.1134,
		"r6a.xlarge":  0.2268,
		"r6a.2xlarge": 0.4536,
		"r6a.4xlarge": 0.9072,
		"r6a.8xlarge": 1.8144,
		// R8i family (memory optimized, latest gen)
		"r8i.xlarge":  0.252, // 4 vCPU, 32 GiB
		"r8i.2xlarge": 0.504, // 8 vCPU, 64 GiB
		"r8i.4xlarge": 1.008, // 16 vCPU, 128 GiB
		// X2gd family (Graviton2, memory optimized)
		"x2gd.large":   0.0334, // 2 vCPU, 16 GiB
		"x2gd.xlarge":  0.0669, // 4 vCPU, 32 GiB
		"x2gd.2xlarge": 0.1338, // 8 vCPU, 64 GiB
		"x2gd.4xlarge": 0.2676, // 16 vCPU, 128 GiB
		// X8g family (Graviton3, general purpose)
		"x8g.large":   0.0336, // 2 vCPU, 16 GiB
		"x8g.xlarge":  0.0672, // 4 vCPU, 32 GiB
		"x8g.2xlarge": 0.1344, // 8 vCPU, 64 GiB
		"x8g.4xlarge": 0.2688, // 16 vCPU, 128 GiB
		// M6g family (Graviton2, general purpose ARM)
		"m6g.medium":  0.0384, // 1 vCPU, 4 GiB
		"m6g.large":   0.0768, // 2 vCPU, 8 GiB
		"m6g.xlarge":  0.1536, // 4 vCPU, 16 GiB
		"m6g.2xlarge": 0.3072, // 8 vCPU, 32 GiB
		"m6g.4xlarge": 0.6144, // 16 vCPU, 64 GiB
		"m6g.8xlarge": 1.2288, // 32 vCPU, 128 GiB
		// C6g family (Graviton2, compute optimized ARM)
		"c6g.medium":  0.034, // 1 vCPU, 2 GiB
		"c6g.large":   0.068, // 2 vCPU, 4 GiB
		"c6g.xlarge":  0.136, // 4 vCPU, 8 GiB
		"c6g.2xlarge": 0.272, // 8 vCPU, 16 GiB
		"c6g.4xlarge": 0.544, // 16 vCPU, 32 GiB
		"c6g.8xlarge": 1.088, // 32 vCPU, 64 GiB
		// GPU instances
		"g4dn.xlarge":  0.526,
		"g4dn.2xlarge": 0.752,
		"g5.xlarge":    1.006,
		"g5.2xlarge":   1.212,
	}

	// Calculate cost like eks-node-viewer: distribute nodes across instance types and sum costs
	// This matches how eks-node-viewer calculates: cost per node based on instance type, then sum
	if len(instanceTypes) == 0 || nodeCount == 0 {
		return PricingResult{Cost: 0.0, Source: PricingSourceUnknown}, make(map[string]PricingSource)
	}

	// Distribute nodes evenly across instance types (like Karpenter does)
	nodesPerType := nodeCount / len(instanceTypes)
	remainder := nodeCount % len(instanceTypes)

	var totalCost float64
	instanceTypeSources := make(map[string]PricingSource) // Track source per instance type
	var overallSource = PricingSourceUnknown

	for i, it := range instanceTypes {
		itLower := strings.ToLower(it)
		var instanceCost float64
		var priceFound bool
		var source = PricingSourceUnknown

		// First, check hardcoded prices (no API call needed)
		// This reduces AWS Pricing API calls significantly for common instance types
		if cost, ok := onDemandPrices[itLower]; ok {
			instanceCost = cost
			priceFound = true
			source = PricingSourceHardcoded
			if r.config != nil && r.config.Debug {
				fmt.Printf("Debug: Using hardcoded price for %s: $%.4f/hr\n", it, cost)
			}
		}

		// Only call AWS Pricing API if we don't have a hardcoded price
		// This significantly reduces API calls
		// Pass the actual capacityType so AWS Pricing client can apply spot discount correctly
		if !priceFound && r.awsPricing != nil && ctx != nil {
			// Use a longer timeout for pricing queries
			// GetProducts API: 30 seconds (queries specific instance type)
			// Public API: 60 seconds (downloads full 400MB index)
			pricingCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
			// Pass the actual capacityType - AWS Pricing client will query on-demand price
			// and apply spot discount internally if capacityType is "spot"
			awsPrice, err := r.awsPricing.GetProductPrice(pricingCtx, it, capacityType)
			cancel()
			
			if err == nil && awsPrice > 0 {
				instanceCost = awsPrice
				priceFound = true
				source = PricingSourceAWSPricingAPI
				fmt.Printf("Successfully fetched AWS Pricing API price for %s (%s): $%.4f/hr\n", it, capacityType, awsPrice)
			} else if err != nil {
				// Only log if it's not a "not found" error (those are expected for some instance types)
				if !strings.Contains(err.Error(), "not found") {
					fmt.Printf("Warning: AWS Pricing API failed for %s (%s): %v\n", it, capacityType, err)
				}
			} else if awsPrice <= 0 {
				// This shouldn't happen - if err is nil, price should be > 0
				fmt.Printf("Warning: AWS Pricing API returned zero price for %s (%s) (this may indicate a parsing issue)\n", it, capacityType)
			}
		}

		// If still not found, try Ollama cache
		if !priceFound {
			r.priceCacheMu.RLock()
			cachedPrice, cached := r.priceCache[itLower]
			r.priceCacheMu.RUnlock()

			if cached {
				instanceCost = cachedPrice
				priceFound = true
				source = PricingSourceOllamaCache
			}
		}

		// If still not found, try family estimation
		if !priceFound {
			instanceCost = r.estimateCostFromFamily(it)
			if instanceCost > 0 {
				priceFound = true
				source = PricingSourceFamilyEstimate
			}
		}

		// Last resort: try Ollama if available
		if !priceFound && r.ollamaClient != nil {
			// Use background context for pricing queries (they're quick and cached)
			ollamaPrice := r.getPricingFromOllama(context.Background(), it)
			if ollamaPrice > 0 {
				instanceCost = ollamaPrice
				priceFound = true
				source = PricingSourceOllama
				// Cache the result
				r.priceCacheMu.Lock()
				r.priceCache[itLower] = ollamaPrice
				r.priceCacheMu.Unlock()
			}
		}

		// Skip this instance type if we couldn't find a price
		if !priceFound {
			continue
		}

		// Track source for this instance type
		instanceTypeSources[it] = source
		
		// Set overall source (prefer AWS Pricing API if any instance type used it)
		if source == PricingSourceAWSPricingAPI {
			overallSource = PricingSourceAWSPricingAPI
		} else if overallSource == PricingSourceUnknown || overallSource == PricingSourceAWSPricingAPI {
			overallSource = source
		}

		// Apply spot discount if using spot instances (only for non-AWS Pricing API sources)
		// AWS Pricing API already applies spot discount internally, so we only need to apply it
		// for hardcoded prices, Ollama cache, family estimates, etc.
		// Spot instances typically cost 70-90% less than on-demand (spot = 10-30% of on-demand)
		// Using conservative 75% discount (spot = 25% of on-demand) for cost estimation
		if capacityType == "spot" && source != PricingSourceAWSPricingAPI {
			instanceCost *= 0.25 // Spot instances are ~75% cheaper than on-demand
		}

		// Calculate nodes for this instance type (distribute remainder evenly)
		nodesForThisType := nodesPerType
		if i < remainder {
			nodesForThisType++
		}

		// Add cost for this instance type: cost per hour * number of nodes
		// This matches eks-node-viewer's approach: sum of (instance_cost * node_count)
		totalCost += instanceCost * float64(nodesForThisType)
	}

	// If no prices were found, return unknown source
	if overallSource == PricingSourceUnknown && totalCost == 0 {
		return PricingResult{Cost: 0.0, Source: PricingSourceUnknown}, instanceTypeSources
	}

	return PricingResult{Cost: totalCost, Source: overallSource}, instanceTypeSources
}

// estimateCostFromFamily estimates cost based on instance family and size
func (r *Recommender) estimateCostFromFamily(instanceType string) float64 {
	it := strings.ToLower(instanceType)

	// Extract size multiplier (relative to xlarge = 1.0)
	multiplier := 1.0
	if strings.Contains(it, ".8xlarge") {
		multiplier = 8.0
	} else if strings.Contains(it, ".4xlarge") {
		multiplier = 4.0
	} else if strings.Contains(it, ".2xlarge") {
		multiplier = 2.0
	} else if strings.Contains(it, ".xlarge") {
		multiplier = 1.0
	} else if strings.Contains(it, ".large") {
		multiplier = 0.5
	} else if strings.Contains(it, ".medium") {
		multiplier = 0.25
	} else if strings.Contains(it, ".small") {
		multiplier = 0.125
	}

	// Base on-demand costs per family (per xlarge equivalent) - US East (N. Virginia)
	// These are the xlarge prices, which will be multiplied by the size multiplier
	var baseCost float64
	if strings.HasPrefix(it, "t3") || strings.HasPrefix(it, "t4g") {
		baseCost = 0.1664 // t3.xlarge on-demand
	} else if strings.HasPrefix(it, "m6i") || strings.HasPrefix(it, "m5") {
		baseCost = 0.192 // m6i.xlarge on-demand (note: m6i.xlarge exists, but m6i.large/medium don't)
	} else if strings.HasPrefix(it, "m6a") {
		baseCost = 0.1728 // m6a.xlarge on-demand
	} else if strings.HasPrefix(it, "c6i") || strings.HasPrefix(it, "c5") {
		baseCost = 0.17 // c6i.xlarge on-demand
	} else if strings.HasPrefix(it, "c6a") {
		baseCost = 0.153 // c6a.xlarge on-demand
	} else if strings.HasPrefix(it, "r6i") || strings.HasPrefix(it, "r5") {
		baseCost = 0.252 // r6i.xlarge on-demand
	} else if strings.HasPrefix(it, "r6a") {
		baseCost = 0.2268 // r6a.xlarge on-demand
	} else if strings.HasPrefix(it, "r8i") {
		baseCost = 0.252 // r8i.xlarge on-demand
	} else if strings.HasPrefix(it, "x2gd") {
		baseCost = 0.0669 // x2gd.xlarge on-demand (Graviton2)
	} else if strings.HasPrefix(it, "x8g") {
		baseCost = 0.0672 // x8g.xlarge on-demand (Graviton3)
	} else if strings.HasPrefix(it, "m6g") {
		baseCost = 0.1536 // m6g.xlarge on-demand (Graviton2)
	} else if strings.HasPrefix(it, "c6g") {
		baseCost = 0.136 // c6g.xlarge on-demand (Graviton2)
	} else if strings.HasPrefix(it, "g4") {
		baseCost = 0.526 // g4dn.xlarge on-demand
	} else if strings.HasPrefix(it, "g5") {
		baseCost = 1.006 // g5.xlarge on-demand
	} else {
		return 0.2 // Default fallback
	}

	return baseCost * multiplier
}

// getPricingFromOllama queries Ollama for AWS EC2 instance pricing
func (r *Recommender) getPricingFromOllama(ctx context.Context, instanceType string) float64 {
	if r.ollamaClient == nil {
		return 0.0
	}

	// Create a prompt for Ollama to get AWS EC2 pricing
	prompt := fmt.Sprintf(`You are an AWS pricing expert. Provide the on-demand hourly cost in USD for AWS EC2 instance type "%s" in the us-east-1 (N. Virginia) region.

Respond ONLY with a JSON object in this exact format:
{
  "instanceType": "%s",
  "pricePerHour": 0.123,
  "region": "us-east-1"
}

If you don't know the exact price, estimate it based on similar instance types in the same family. The price should be a positive number representing USD per hour.`, instanceType, instanceType)

	// Use a shorter timeout for pricing queries (10 seconds)
	pricingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	response, err := r.ollamaClient.Chat(pricingCtx, prompt)
	if err != nil {
		fmt.Printf("Warning: Failed to get pricing from Ollama for %s: %v\n", instanceType, err)
		return 0.0
	}

	// Parse the response
	var pricingResp struct {
		InstanceType string  `json:"instanceType"`
		PricePerHour float64 `json:"pricePerHour"`
		Region       string  `json:"region"`
	}

	// Try to extract JSON from response
	jsonStart := strings.Index(response, "{")
	jsonEnd := strings.LastIndex(response, "}")
	if jsonStart >= 0 && jsonEnd > jsonStart {
		jsonStr := response[jsonStart : jsonEnd+1]
		if err := json.Unmarshal([]byte(jsonStr), &pricingResp); err != nil {
			fmt.Printf("Warning: Failed to parse Ollama pricing response for %s: %v\n", instanceType, err)
			return 0.0
		}
	} else {
		// Try parsing the whole response
		if err := json.Unmarshal([]byte(response), &pricingResp); err != nil {
			fmt.Printf("Warning: Failed to parse Ollama pricing response for %s: %v\n", instanceType, err)
			return 0.0
		}
	}

	if pricingResp.PricePerHour > 0 {
		fmt.Printf("Info: Got pricing from Ollama for %s: $%.4f/hr\n", instanceType, pricingResp.PricePerHour)
		return pricingResp.PricePerHour
	}

	return 0.0
}

// limitToWords limits a string to approximately n words
func limitToWords(text string, maxWords int) string {
	words := strings.Fields(text)
	if len(words) <= maxWords {
		return text
	}
	return strings.Join(words[:maxWords], " ") + "..."
}

func (r *Recommender) generateReasoning(workloads []Workload, cpu, memory float64, gpu int, isOverprovisioned bool, currentNodes, recommendedNodes int) string {
	if len(workloads) == 0 {
		return "No workloads detected. Consider removing this NodePool to reduce unnecessary infrastructure."
	}

	// Educational reasoning: explain the "why" behind recommendations
	if isOverprovisioned && currentNodes > 0 {
		reductionPercent := float64(currentNodes-recommendedNodes) / float64(currentNodes) * 100
		return fmt.Sprintf("Current capacity exceeds workload needs. Reducing from %d to %d nodes can save ~%.0f%% costs while maintaining performance.", currentNodes, recommendedNodes, reductionPercent)
	} else if recommendedNodes > currentNodes && currentNodes > 0 {
		return fmt.Sprintf("Workloads need more capacity. Scaling from %d to %d nodes will improve resource availability and reduce scheduling pressure.", currentNodes, recommendedNodes)
	} else if recommendedNodes < currentNodes && currentNodes > 0 {
		return fmt.Sprintf("Optimizing node count from %d to %d based on actual resource requirements. This balances cost efficiency with workload needs.", currentNodes, recommendedNodes)
	} else if currentNodes == 0 {
		return fmt.Sprintf("New NodePool configuration recommends %d nodes to handle current workload requirements efficiently.", recommendedNodes)
	}

	return fmt.Sprintf("Recommended %d nodes based on workload analysis and resource utilization patterns.", recommendedNodes)
}

// extractConciseReasoning extracts key educational points from longer reasoning text
func (r *Recommender) extractConciseReasoning(longReasoning, fallback string) string {
	// If reasoning is already reasonable length, use it
	if len(longReasoning) <= 150 {
		return longReasoning
	}

	// Try to extract first sentence which usually contains the main insight
	sentences := strings.Split(longReasoning, ".")
	if len(sentences) > 0 {
		firstSentence := strings.TrimSpace(sentences[0])
		if len(firstSentence) <= 150 {
			return firstSentence
		}
		// If first sentence is too long, try first two sentences
		if len(sentences) > 1 {
			twoSentences := strings.TrimSpace(sentences[0] + ". " + sentences[1])
			if len(twoSentences) <= 200 {
				return twoSentences
			}
		}
	}

	// Look for key educational patterns (explanations, insights)
	if strings.Contains(longReasoning, "indicates") || strings.Contains(longReasoning, "suggests") {
		// Extract the insight part
		parts := strings.Split(longReasoning, ".")
		for _, part := range parts {
			if (strings.Contains(part, "indicates") || strings.Contains(part, "suggests")) && len(part) <= 150 {
				return strings.TrimSpace(part) + "."
			}
		}
	}

	// Fallback to original educational reasoning
	return fallback
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

// getCurrentStateFromNodePools tries to find matching existing NodePools for the workloads
func (r *Recommender) getCurrentStateFromNodePools(group []Workload, workloadNames []string) *CurrentState {
	if r.k8sClient == nil {
		return nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	nodePools, err := r.k8sClient.ListNodePools(ctx)
	if err != nil {
		return nil // Silently fail and use estimation
	}

	// Try to match NodePools by labels or workload names
	var matchedNodePool *kubernetes.NodePoolInfo
	for _, np := range nodePools {
		// Check if any workload labels match NodePool labels
		for _, w := range group {
			for wk, wv := range w.Labels {
				if npv, ok := np.Labels[wk]; ok && npv == wv {
					matchedNodePool = &np
					break
				}
			}
			if matchedNodePool != nil {
				break
			}
		}
		if matchedNodePool != nil {
			break
		}
	}

	// If no match found, use the first NodePool as a reference (or sum all)
	if matchedNodePool == nil && len(nodePools) > 0 {
		// Sum up all NodePools as current state
		var totalCost float64
		var totalInstanceTypes []string
		for _, np := range nodePools {
			totalCost += np.EstimatedCost
			totalInstanceTypes = append(totalInstanceTypes, np.InstanceTypes...)
		}

		return &CurrentState{
			EstimatedCost: totalCost,
			TotalNodes:    len(nodePools), // Rough estimate
			TotalCPU:      0,              // Would need to calculate from NodePools
			TotalMemory:   0,              // Would need to calculate from NodePools
			InstanceTypes: totalInstanceTypes,
			CapacityType:  nodePools[0].CapacityType,
		}
	}

	if matchedNodePool == nil {
		return nil
	}

	// Calculate total resources from workloads
	var totalCPU, totalMemory float64
	for _, w := range group {
		totalCPU += r.parseCPU(w.CPU)
		totalMemory += r.parseMemory(w.Memory)
	}

	return &CurrentState{
		EstimatedCost: matchedNodePool.EstimatedCost,
		TotalNodes:    matchedNodePool.MaxSize, // Use max size as estimate
		TotalCPU:      totalCPU,
		TotalMemory:   totalMemory,
		InstanceTypes: matchedNodePool.InstanceTypes,
		CapacityType:  matchedNodePool.CapacityType,
	}
}
