package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

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
	enhancedRecs, err := e.recommender.EnhanceRecommendationsWithLLM(ctx, plan.Recommendations)
	if err != nil || len(enhancedRecs) == 0 {
		return ""
	}

	// Return the AI reasoning if available
	if enhancedRecs[0].AIReasoning != "" {
		return enhancedRecs[0].AIReasoning
	}

	return ""
}

// SuggestStrategy uses LLM to suggest the best optimization strategy based on analysis.
// Falls back to rule-based suggestion when no LLM is configured or the LLM call fails.
func (e *LLMEnhancer) SuggestStrategy(ctx context.Context, analysis *AnalysisResult) (OptimizationStrategy, string) {
	if e.HasLLM() {
		if strategy, rationale, ok := e.suggestStrategyWithLLM(ctx, analysis); ok {
			return strategy, rationale
		}
	}
	return e.suggestStrategyRuleBased(analysis), ""
}

// suggestStrategyWithLLM asks the LLM to pick a strategy. Returns ok=false on any
// error so the caller can fall back to the rule-based suggestion.
func (e *LLMEnhancer) suggestStrategyWithLLM(ctx context.Context, analysis *AnalysisResult) (OptimizationStrategy, string, bool) {
	prompt := buildStrategyPrompt(analysis)

	// Short timeout: strategy selection should never block the request.
	llmCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	response, err := e.recommender.GetLLMClient().Chat(llmCtx, prompt)
	if err != nil {
		log.Printf("Warning: LLM strategy suggestion failed: %v (falling back to rule-based)", err)
		return "", "", false
	}

	var parsed struct {
		Strategy  string `json:"strategy"`
		Rationale string `json:"rationale"`
	}
	if err := extractJSON(response, &parsed); err != nil {
		log.Printf("Warning: LLM strategy response was not valid JSON (falling back to rule-based): %v", err)
		return "", "", false
	}

	strategy, ok := validStrategy(parsed.Strategy)
	if !ok {
		log.Printf("Warning: LLM returned unknown strategy %q (falling back to rule-based)", parsed.Strategy)
		return "", "", false
	}
	return strategy, strings.TrimSpace(parsed.Rationale), true
}

func buildStrategyPrompt(analysis *AnalysisResult) string {
	var b strings.Builder
	b.WriteString("You are a Kubernetes cost-optimization strategist. Given the NodePool analysis below, choose the single best optimization strategy.\n\n")
	b.WriteString("Allowed strategies (respond with exactly one of these values):\n")
	b.WriteString("- aggressive: maximize savings, higher risk\n")
	b.WriteString("- balanced: balance savings and stability\n")
	b.WriteString("- conservative: prioritize stability\n")
	b.WriteString("- spot-first: prefer spot instances\n")
	b.WriteString("- right-size: focus on right-sizing node counts\n\n")

	state := analysis.NodePoolState
	if state != nil {
		fmt.Fprintf(&b, "NodePool: %s\n", state.Name)
		fmt.Fprintf(&b, "Nodes: %d, Current cost: $%.2f/hr\n", state.CurrentNodes, state.CurrentCost)
		fmt.Fprintf(&b, "CPU utilization: %.0f%%, Memory utilization: %.0f%%\n", state.CPUUtilization, state.MemoryUtilization)
		fmt.Fprintf(&b, "Capacity type: %s (spot ratio %.0f%%)\n", state.CapacityType, state.SpotRatio)
	}
	if len(analysis.RiskFactors) > 0 {
		b.WriteString("Risk factors:\n")
		for _, rf := range analysis.RiskFactors {
			b.WriteString("- " + rf + "\n")
		}
	}
	if len(analysis.OptimizationOpportunities) > 0 {
		b.WriteString("Opportunities:\n")
		for _, op := range analysis.OptimizationOpportunities {
			fmt.Fprintf(&b, "- %s (potential savings $%.2f/hr, risk %s)\n", op.Type, op.PotentialSavings, op.RiskLevel)
		}
	}
	b.WriteString("\nRespond ONLY with a JSON object: {\"strategy\": \"<one allowed value>\", \"rationale\": \"<one short sentence>\"}")
	return b.String()
}

// validStrategy maps a raw string to a known strategy, reporting whether it was recognized.
func validStrategy(raw string) (OptimizationStrategy, bool) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case string(StrategyAggressive):
		return StrategyAggressive, true
	case string(StrategyBalanced):
		return StrategyBalanced, true
	case string(StrategyConservative):
		return StrategyConservative, true
	case string(StrategySpotFirst):
		return StrategySpotFirst, true
	case string(StrategyRightSize):
		return StrategyRightSize, true
	default:
		return "", false
	}
}

// extractJSON unmarshals the first JSON object found in an LLM response.
func extractJSON(response string, v interface{}) error {
	start := strings.Index(response, "{")
	end := strings.LastIndex(response, "}")
	if start < 0 || end <= start {
		return fmt.Errorf("no JSON object in response")
	}
	return json.Unmarshal([]byte(response[start:end+1]), v)
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
	enhanced, err := e.recommender.EnhanceRecommendationsWithLLM(ctx, recommendations)
	if err != nil {
		return recommendations, err // Return original if LLM fails
	}
	return enhanced, nil
}
