package agent

import (
	"time"
	"github.com/karpenter-optimizer/internal/recommender"
)

// OptimizationStrategy defines how the agent approaches optimization
type OptimizationStrategy string

const (
	StrategyAggressive    OptimizationStrategy = "aggressive"    // Maximize savings, higher risk
	StrategyBalanced      OptimizationStrategy = "balanced"     // Balance savings and stability
	StrategyConservative  OptimizationStrategy = "conservative"  // Prioritize stability
	StrategySpotFirst     OptimizationStrategy = "spot-first"    // Prefer spot instances
	StrategyRightSize     OptimizationStrategy = "right-size"    // Focus on right-sizing
)

// OptimizationPlan represents a planned optimization
type OptimizationPlan struct {
	ID              string                                          `json:"id"`
	NodePoolName    string                                          `json:"nodePoolName"`
	Strategy        OptimizationStrategy                            `json:"strategy"`
	CurrentState    *NodePoolState                                  `json:"currentState"`
	Recommendations []recommender.NodePoolCapacityRecommendation    `json:"recommendations"`
	RiskLevel       string                                          `json:"riskLevel"` // "low", "medium", "high"
	EstimatedSavings float64                                        `json:"estimatedSavings"`
	Confidence      float64                                         `json:"confidence"` // 0.0 - 1.0
	CreatedAt       time.Time                                       `json:"createdAt"`
	LearnedFromHistory bool                                        `json:"learnedFromHistory,omitempty"` // Whether this plan was informed by learning
	LearningInsights   []string                                    `json:"learningInsights,omitempty"`     // Insights from learning
}

// NodePoolState represents the current state of a NodePool
type NodePoolState struct {
	Name              string    `json:"name"`
	CurrentNodes      int       `json:"currentNodes"`
	CurrentCost       float64   `json:"currentCost"`
	CPUUtilization    float64   `json:"cpuUtilization"`
	MemoryUtilization float64   `json:"memoryUtilization"`
	CapacityType      string    `json:"capacityType"` // "spot", "on-demand", "mixed"
	SpotRatio         float64   `json:"spotRatio"`   // Percentage of nodes that are spot
	InstanceTypes     []string  `json:"instanceTypes"`
	LastOptimized     *time.Time `json:"lastOptimized,omitempty"`
}

// PricingTrend represents pricing trends over time
type PricingTrend struct {
	InstanceType  string  `json:"instanceType"`
	OnDemandPrice float64 `json:"onDemandPrice"`
	SpotPrice     float64 `json:"spotPrice"`
	SpotSavings   float64 `json:"spotSavings"` // Percentage savings
	Availability  string  `json:"availability"` // "high", "medium", "low"
	Trend         string  `json:"trend"`       // "stable", "increasing", "decreasing"
}

// AnalysisResult contains the agent's analysis of a NodePool
type AnalysisResult struct {
	NodePoolState            *NodePoolState            `json:"nodePoolState"`
	OptimizationOpportunities []OptimizationOpportunity `json:"optimizationOpportunities"`
	PricingTrends            map[string]*PricingTrend  `json:"pricingTrends"`
	RiskFactors              []string                  `json:"riskFactors"`
	Confidence               float64                   `json:"confidence"`
}

// OptimizationOpportunity identifies a specific optimization opportunity
type OptimizationOpportunity struct {
	Type            string  `json:"type"`            // "spot-conversion", "right-size", "instance-type-change"
	Description     string  `json:"description"`
	PotentialSavings float64 `json:"potentialSavings"`
	RiskLevel       string  `json:"riskLevel"`       // "low", "medium", "high"
	Confidence      float64 `json:"confidence"`      // 0.0 - 1.0
}

