package agent

import (
	"context"
	"fmt"
	"strings"
	
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
	if plan.Recommendations == nil || len(plan.Recommendations) == 0 {
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

// buildAgentExplanationPrompt builds a prompt for explaining the agent's optimization plan
func (e *LLMEnhancer) buildAgentExplanationPrompt(plan *OptimizationPlan, rec recommender.NodePoolCapacityRecommendation) string {
	return fmt.Sprintf(`You are an AI cost optimization agent for Kubernetes clusters. Explain this optimization plan:

Optimization Plan:
- NodePool: %s
- Strategy: %s
- Risk Level: %s
- Confidence: %.0f%%
- Estimated Savings: $%.2f/hr

Current State:
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

Optimization Opportunities Identified:
%s

Risk Factors:
%s

Provide a comprehensive explanation (3-4 sentences) that:
1. Explains why this optimization strategy was chosen
2. Describes the key changes and their benefits
3. Addresses any risks or concerns
4. Provides actionable next steps

Return only the explanation text, no additional formatting.`,
		plan.NodePoolName,
		plan.Strategy,
		plan.RiskLevel,
		plan.Confidence*100,
		plan.EstimatedSavings,
		plan.CurrentState.CurrentNodes,
		plan.CurrentState.InstanceTypes,
		rec.CurrentCPUCapacity,
		(rec.CurrentCPUUsed/rec.CurrentCPUCapacity)*100,
		rec.CurrentMemoryCapacity,
		(rec.CurrentMemoryUsed/rec.CurrentMemoryCapacity)*100,
		rec.CurrentCost,
		plan.CurrentState.CapacityType,
		rec.RecommendedNodes,
		rec.RecommendedInstanceTypes,
		rec.RecommendedTotalCPU,
		rec.RecommendedTotalMemory,
		rec.RecommendedCost,
		rec.CapacityType,
		rec.CostSavings,
		rec.CostSavingsPercent,
		e.formatOpportunities(plan.CurrentState),
		e.formatRiskFactors(plan.CurrentState),
	)
}

// buildStrategySelectionPrompt builds a prompt for LLM to suggest optimization strategy
func (e *LLMEnhancer) buildStrategySelectionPrompt(analysis *AnalysisResult) string {
	return fmt.Sprintf(`You are an AI cost optimization agent. Analyze this NodePool and suggest the best optimization strategy.

NodePool: %s
Current State:
- Nodes: %d
- CPU Utilization: %.1f%%
- Memory Utilization: %.1f%%
- Capacity Type: %s
- Current Cost: $%.2f/hr

Optimization Opportunities:
%s

Risk Factors:
%s

Available Strategies:
1. balanced - Balance cost savings and stability (default)
2. aggressive - Maximize cost savings, higher risk
3. conservative - Prioritize stability, lower risk
4. spot-first - Prioritize spot instance conversion
5. right-size - Focus on right-sizing

Respond with JSON:
{
  "strategy": "balanced|aggressive|conservative|spot-first|right-size",
  "reasoning": "Why this strategy is best for this NodePool"
}`,
		analysis.NodePoolState.Name,
		analysis.NodePoolState.CurrentNodes,
		analysis.NodePoolState.CPUUtilization,
		analysis.NodePoolState.MemoryUtilization,
		analysis.NodePoolState.CapacityType,
		analysis.NodePoolState.CurrentCost,
		e.formatOpportunities(analysis.NodePoolState),
		strings.Join(analysis.RiskFactors, ", "),
	)
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

// formatOpportunities formats optimization opportunities for prompts
func (e *LLMEnhancer) formatOpportunities(state *NodePoolState) string {
	// This would be populated from analysis, but for now return empty
	return "Optimization opportunities identified"
}

// formatRiskFactors formats risk factors for prompts
func (e *LLMEnhancer) formatRiskFactors(state *NodePoolState) string {
	// This would be populated from analysis, but for now return empty
	return "Risk factors assessed"
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

