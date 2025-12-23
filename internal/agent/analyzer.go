package agent

import (
	"context"
	"fmt"
	
	"github.com/karpenter-optimizer/internal/kubernetes"
	"github.com/karpenter-optimizer/internal/recommender"
)

// Analyzer analyzes NodePool state and identifies optimization opportunities
type Analyzer struct {
	recommender *recommender.Recommender
	k8sClient   *kubernetes.Client
}

// NewAnalyzer creates a new analyzer
func NewAnalyzer(rec *recommender.Recommender, k8sClient *kubernetes.Client) *Analyzer {
	return &Analyzer{
		recommender: rec,
		k8sClient:   k8sClient,
	}
}

// AnalyzeNodePool analyzes a NodePool and returns analysis results
func (a *Analyzer) AnalyzeNodePool(ctx context.Context, np kubernetes.NodePoolInfo) (*AnalysisResult, error) {
	// Calculate current state
	state := a.calculateNodePoolState(ctx, np)
	
	// Identify optimization opportunities
	opportunities := a.identifyOpportunities(ctx, np, state)
	
	// Analyze pricing trends
	pricingTrends := a.analyzePricingTrends(ctx, state.InstanceTypes)
	
	// Assess risks
	riskFactors := a.assessRisks(np, state)
	
	// Calculate confidence
	confidence := a.calculateConfidence(state, opportunities, riskFactors)
	
	return &AnalysisResult{
		NodePoolState:            state,
		OptimizationOpportunities: opportunities,
		PricingTrends:            pricingTrends,
		RiskFactors:              riskFactors,
		Confidence:               confidence,
	}, nil
}

// calculateNodePoolState calculates the current state of a NodePool
func (a *Analyzer) calculateNodePoolState(ctx context.Context, np kubernetes.NodePoolInfo) *NodePoolState {
	state := &NodePoolState{
		Name:          np.Name,
		CurrentNodes:  len(np.ActualNodes),
		InstanceTypes: make([]string, 0),
	}
	
	var totalCPUUsed, totalCPUCapacity, totalMemoryUsed, totalMemoryCapacity float64
	var spotNodes, onDemandNodes int
	var totalCost float64
	
	instanceTypeSet := make(map[string]bool)
	
	for _, node := range np.ActualNodes {
		// Calculate CPU/Memory utilization
		if node.CPUUsage != nil {
			totalCPUUsed += node.CPUUsage.Used
			totalCPUCapacity += node.CPUUsage.Allocatable
		}
		if node.MemoryUsage != nil {
			totalMemoryUsed += node.MemoryUsage.Used
			totalMemoryCapacity += node.MemoryUsage.Allocatable
		}
		
		// Track instance types
		if node.InstanceType != "" && !instanceTypeSet[node.InstanceType] {
			state.InstanceTypes = append(state.InstanceTypes, node.InstanceType)
			instanceTypeSet[node.InstanceType] = true
		}
		
		// Count capacity types
		capacityType := node.CapacityType
		if capacityType == "" {
			capacityType = np.CapacityType
		}
		if capacityType == "spot" {
			spotNodes++
		} else {
			onDemandNodes++
		}
		
		// Calculate cost
		if node.InstanceType != "" {
			if capacityType == "" {
				capacityType = "on-demand"
			}
			nodeCost := a.recommender.EstimateCost(ctx, []string{node.InstanceType}, capacityType, 1)
			totalCost += nodeCost
		}
	}
	
	state.CurrentCost = totalCost
	
	// Calculate utilization percentages
	if totalCPUCapacity > 0 {
		state.CPUUtilization = (totalCPUUsed / totalCPUCapacity) * 100
	}
	if totalMemoryCapacity > 0 {
		state.MemoryUtilization = (totalMemoryUsed / totalMemoryCapacity) * 100
	}
	
	// Determine capacity type
	totalNodes := spotNodes + onDemandNodes
	if totalNodes > 0 {
		state.SpotRatio = float64(spotNodes) / float64(totalNodes) * 100
		if spotNodes == totalNodes {
			state.CapacityType = "spot"
		} else if onDemandNodes == totalNodes {
			state.CapacityType = "on-demand"
		} else {
			state.CapacityType = "mixed"
		}
	} else {
		state.CapacityType = np.CapacityType
		if state.CapacityType == "" {
			state.CapacityType = "on-demand"
		}
	}
	
	return state
}

// identifyOpportunities identifies optimization opportunities
func (a *Analyzer) identifyOpportunities(ctx context.Context, np kubernetes.NodePoolInfo, state *NodePoolState) []OptimizationOpportunity {
	var opportunities []OptimizationOpportunity
	
	// Opportunity 1: Spot conversion (if using on-demand)
	if state.CapacityType == "on-demand" || (state.CapacityType == "mixed" && state.SpotRatio < 50) {
		// Estimate potential savings from spot conversion
		onDemandCost := state.CurrentCost
		spotCost := onDemandCost * 0.25 // Spot is ~75% cheaper
		potentialSavings := onDemandCost - spotCost
		
		opportunities = append(opportunities, OptimizationOpportunity{
			Type:            "spot-conversion",
			Description:     fmt.Sprintf("Convert to spot instances could save $%.2f/hr (75%% discount)", potentialSavings),
			PotentialSavings: potentialSavings,
			RiskLevel:       "medium", // Spot can be interrupted
			Confidence:      0.8,
		})
	}
	
	// Opportunity 2: Right-sizing (if over-provisioned)
	if state.CPUUtilization < 30 || state.MemoryUtilization < 30 {
		// Calculate potential savings from right-sizing
		// This is a simplified calculation - actual right-sizing would need more analysis
		avgUtilization := (state.CPUUtilization + state.MemoryUtilization) / 2
		if avgUtilization < 30 {
			overProvisionedRatio := 1.0 - (avgUtilization / 100.0)
			potentialSavings := state.CurrentCost * overProvisionedRatio * 0.5 // Assume 50% of over-provisioning can be saved
			
			opportunities = append(opportunities, OptimizationOpportunity{
				Type:            "right-size",
				Description:     fmt.Sprintf("Right-sizing could save $%.2f/hr (currently %.1f%% CPU, %.1f%% Memory utilized)", 
					potentialSavings, state.CPUUtilization, state.MemoryUtilization),
				PotentialSavings: potentialSavings,
				RiskLevel:       "low",
				Confidence:      0.7,
			})
		}
	}
	
	// Opportunity 3: Instance type optimization
	// Check if cheaper instance types with similar specs are available
	// This would require comparing current instance types with alternatives
	if len(state.InstanceTypes) > 0 {
		// Simplified: if using expensive instance types, there might be cheaper alternatives
		opportunities = append(opportunities, OptimizationOpportunity{
			Type:            "instance-type-change",
			Description:     "Consider cheaper instance types with similar specifications",
			PotentialSavings: state.CurrentCost * 0.1, // Estimate 10% savings
			RiskLevel:       "low",
			Confidence:      0.6,
		})
	}
	
	return opportunities
}

// analyzePricingTrends analyzes pricing trends for instance types
func (a *Analyzer) analyzePricingTrends(ctx context.Context, instanceTypes []string) map[string]*PricingTrend {
	trends := make(map[string]*PricingTrend)
	
	for _, it := range instanceTypes {
		// Get current pricing
		onDemandPrice := a.recommender.EstimateCost(ctx, []string{it}, "on-demand", 1)
		spotPrice := a.recommender.EstimateCost(ctx, []string{it}, "spot", 1)
		
		var spotSavings float64
		if onDemandPrice > 0 {
			spotSavings = ((onDemandPrice - spotPrice) / onDemandPrice) * 100
		}
		
		trends[it] = &PricingTrend{
			InstanceType:  it,
			OnDemandPrice: onDemandPrice,
			SpotPrice:     spotPrice,
			SpotSavings:   spotSavings,
			Availability:  "high", // Would need actual spot availability data
			Trend:         "stable", // Would need historical data
		}
	}
	
	return trends
}

// assessRisks assesses risks associated with optimizing this NodePool
func (a *Analyzer) assessRisks(np kubernetes.NodePoolInfo, state *NodePoolState) []string {
	var risks []string
	
	// Check if NodePool has production-like labels
	if np.Labels != nil {
		if env, ok := np.Labels["environment"]; ok && (env == "production" || env == "prod") {
			risks = append(risks, "Production NodePool - requires careful optimization")
		}
	}
	
	// Check utilization - low utilization might indicate bursty workloads
	if state.CPUUtilization < 20 {
		risks = append(risks, "Very low CPU utilization - may indicate bursty workloads")
	}
	
	// Check if already using spot
	if state.CapacityType == "spot" {
		risks = append(risks, "Already using spot instances - limited further optimization")
	}
	
	// Check node count - very few nodes might indicate critical workloads
	if state.CurrentNodes < 3 {
		risks = append(risks, "Low node count - optimization may impact availability")
	}
	
	return risks
}

// calculateConfidence calculates confidence in optimization recommendations
func (a *Analyzer) calculateConfidence(state *NodePoolState, opportunities []OptimizationOpportunity, risks []string) float64 {
	confidence := 0.8 // Base confidence
	
	// Reduce confidence if there are many risks
	confidence -= float64(len(risks)) * 0.1
	
	// Increase confidence if utilization is moderate (not too low, not too high)
	if state.CPUUtilization > 30 && state.CPUUtilization < 80 {
		confidence += 0.1
	}
	
	// Increase confidence if we have multiple opportunities
	if len(opportunities) > 1 {
		confidence += 0.05
	}
	
	// Ensure confidence is between 0 and 1
	if confidence < 0.1 {
		confidence = 0.1
	}
	if confidence > 1.0 {
		confidence = 1.0
	}
	
	return confidence
}

