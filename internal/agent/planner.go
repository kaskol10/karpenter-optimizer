package agent

import (
	"context"
	"fmt"
	"time"
	
	"github.com/karpenter-optimizer/internal/kubernetes"
	"github.com/karpenter-optimizer/internal/recommender"
)

// Planner plans optimization strategies based on analysis
type Planner struct {
	recommender *recommender.Recommender
	strategies  map[OptimizationStrategy]*StrategyWrapper
}

// StrategyWrapper wraps a strategy with its implementation
type StrategyWrapper struct {
	strategy Strategy
}

// NewPlanner creates a new planner
func NewPlanner(rec *recommender.Recommender) *Planner {
	p := &Planner{
		recommender: rec,
		strategies:  make(map[OptimizationStrategy]*StrategyWrapper),
	}
	
	// Initialize strategies
	p.strategies[StrategyAggressive] = &StrategyWrapper{strategy: NewAggressiveStrategy(rec)}
	p.strategies[StrategyBalanced] = &StrategyWrapper{strategy: NewBalancedStrategy(rec)}
	p.strategies[StrategyConservative] = &StrategyWrapper{strategy: NewConservativeStrategy(rec)}
	p.strategies[StrategySpotFirst] = &StrategyWrapper{strategy: NewSpotFirstStrategy(rec)}
	p.strategies[StrategyRightSize] = &StrategyWrapper{strategy: NewRightSizeStrategy(rec)}
	
	return p
}

// PlanOptimization creates an optimization plan for a NodePool
func (p *Planner) PlanOptimization(ctx context.Context, analysis *AnalysisResult, strategy OptimizationStrategy, np kubernetes.NodePoolInfo) (*OptimizationPlan, error) {
	// Select strategy
	strategyWrapper, ok := p.strategies[strategy]
	if !ok {
		strategy = StrategyBalanced // Default to balanced
		strategyWrapper = p.strategies[strategy]
	}
	
	// Generate recommendations using the selected strategy
	recommendations, err := strategyWrapper.strategy.GenerateRecommendations(ctx, analysis, np)
	if err != nil {
		return nil, fmt.Errorf("failed to generate recommendations: %w", err)
	}
	
	// Calculate risk level
	riskLevel := p.calculateRiskLevel(analysis, recommendations)
	
	// Calculate estimated savings
	estimatedSavings := 0.0
	if len(recommendations) > 0 {
		estimatedSavings = recommendations[0].CostSavings
	}
	
	plan := &OptimizationPlan{
		ID:               fmt.Sprintf("plan-%d", time.Now().Unix()),
		NodePoolName:    analysis.NodePoolState.Name,
		Strategy:         strategy,
		CurrentState:     analysis.NodePoolState,
		Recommendations:  recommendations,
		RiskLevel:        riskLevel,
		EstimatedSavings: estimatedSavings,
		Confidence:       analysis.Confidence,
		CreatedAt:        time.Now(),
	}
	
	return plan, nil
}

// calculateRiskLevel calculates the risk level of an optimization plan
func (p *Planner) calculateRiskLevel(analysis *AnalysisResult, recommendations []recommender.NodePoolCapacityRecommendation) string {
	riskScore := 0
	
	// Check if converting to spot
	if len(recommendations) > 0 {
		rec := recommendations[0]
		if rec.CapacityType == "spot" && analysis.NodePoolState.CapacityType != "spot" {
			riskScore += 2 // Medium risk
		}
		
		// Check if reducing nodes significantly
		if rec.RecommendedNodes < int(float64(analysis.NodePoolState.CurrentNodes)*0.7) {
			riskScore += 1 // Some risk
		}
	}
	
	// Check analysis risks
	riskScore += len(analysis.RiskFactors)
	
	if riskScore >= 3 {
		return "high"
	} else if riskScore >= 1 {
		return "medium"
	}
	return "low"
}

