package agent

import (
	"context"
	
	"github.com/karpenter-optimizer/internal/recommender"
)

// LLMEnhancer uses LLM to enhance agent decisions and explanations
type LLMEnhancer struct {
	recommender *recommender.Recommender
}

// NewLLMEnhancer creates a new LLM enhancer
func NewLLMEnhancer(rec *recommender.Recommender) *LLMEnhancer {
	return &LLMEnhancer{
		recommender: rec,
	}
}

// HasLLM checks if LLM is available
func (e *LLMEnhancer) HasLLM() bool {
	if e.recommender == nil {
		return false
	}
	return e.recommender.HasLLM()
}

// EnhancePlanExplanation uses LLM to generate a better explanation for an optimization plan
func (e *LLMEnhancer) EnhancePlanExplanation(ctx context.Context, plan *OptimizationPlan) string {
	// Use the recommender's LLM enhancement if available
	if len(plan.Recommendations) == 0 {
		return ""
	}
	
	// Use the recommender's LLM client (if available)
	// Enhance the recommendation's reasoning
	enhancedRecs, err := e.recommender.EnhanceRecommendationsWithOllama(ctx, plan.Recommendations)
	if err != nil || len(enhancedRecs) == 0 {
		return ""
	}
	
	// Return the AI reasoning if available
	if enhancedRecs[0].AIReasoning != "" {
		return enhancedRecs[0].AIReasoning
	}
	
	return ""
}

// SuggestStrategy uses LLM to suggest the best optimization strategy based on analysis
func (e *LLMEnhancer) SuggestStrategy(ctx context.Context, analysis *AnalysisResult) (OptimizationStrategy, string) {
	// For now, return a rule-based suggestion
	// TODO: Implement LLM-based strategy suggestion
	return e.suggestStrategyRuleBased(analysis), ""
}

// EnhanceOpportunityDescription uses LLM to improve opportunity descriptions
func (e *LLMEnhancer) EnhanceOpportunityDescription(ctx context.Context, opportunity OptimizationOpportunity, state *NodePoolState) string {
	// TODO: Implement LLM-based opportunity description enhancement
	// For now, return the original description
	return opportunity.Description
}


// suggestStrategyRuleBased provides rule-based strategy suggestion (fallback)
func (e *LLMEnhancer) suggestStrategyRuleBased(analysis *AnalysisResult) OptimizationStrategy {
	// Rule-based logic for strategy selection
	riskCount := len(analysis.RiskFactors)
	
	// If production or high risk, use conservative
	if riskCount >= 3 {
		return StrategyConservative
	}
	
	// If low utilization, prefer right-sizing
	if analysis.NodePoolState.CPUUtilization < 30 || analysis.NodePoolState.MemoryUtilization < 30 {
		return StrategyRightSize
	}
	
	// If not using spot and high confidence, prefer spot-first
	if analysis.NodePoolState.CapacityType != "spot" && analysis.Confidence > 0.7 {
		return StrategySpotFirst
	}
	
	// Default to balanced
	return StrategyBalanced
}

// EnhanceRecommendationsWithLLM enhances recommendations using LLM
func (e *LLMEnhancer) EnhanceRecommendationsWithLLM(ctx context.Context, recommendations []recommender.NodePoolCapacityRecommendation) ([]recommender.NodePoolCapacityRecommendation, error) {
	// Use the recommender's LLM enhancement
	enhanced, err := e.recommender.EnhanceRecommendationsWithOllama(ctx, recommendations)
	if err != nil {
		return recommendations, err // Return original if LLM fails
	}
	return enhanced, nil
}

