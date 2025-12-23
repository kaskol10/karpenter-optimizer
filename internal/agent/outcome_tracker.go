package agent

import (
	"context"
	"fmt"
	"math"
	"time"
)

// Helper functions
func absFloat(x float64) float64 {
	return math.Abs(x)
}

func maxFloat(a, b float64) float64 {
	return math.Max(a, b)
}

// OutcomeTracker helps track optimization outcomes
type OutcomeTracker struct {
	learningAgent *LearningAgent
}

// NewOutcomeTracker creates a new outcome tracker
func NewOutcomeTracker(learningAgent *LearningAgent) *OutcomeTracker {
	return &OutcomeTracker{
		learningAgent: learningAgent,
	}
}

// RecordAppliedPlan records that a plan was applied
func (t *OutcomeTracker) RecordAppliedPlan(ctx context.Context, plan *OptimizationPlan, userFeedback string) error {
	if t.learningAgent == nil {
		return nil // Learning disabled
	}
	
	outcome := OptimizationOutcome{
		PlanID:              plan.ID,
		NodePoolName:        plan.NodePoolName,
		Strategy:            plan.Strategy,
		AppliedAt:           time.Now(),
		PredictedSavings:    plan.EstimatedSavings,
		PredictedConfidence: plan.Confidence,
		PredictedRiskLevel:  plan.RiskLevel,
		UserFeedback:        userFeedback,
	}
	
	// If plan has recommendations, extract initial values
	if len(plan.Recommendations) > 0 {
		rec := plan.Recommendations[0]
		outcome.PredictedSavings = rec.CostSavings
	}
	
	return t.learningAgent.RecordOutcome(ctx, outcome)
}

// UpdateOutcome updates an outcome with actual results
func (t *OutcomeTracker) UpdateOutcome(ctx context.Context, planID string, actualResults *ActualResults) error {
	if t.learningAgent == nil {
		return nil // Learning disabled
	}
	
	// Find the outcome in history
	history := t.learningAgent.GetHistory()
	var outcome *OptimizationOutcome
	for i := range history {
		if history[i].PlanID == planID {
			outcome = &history[i]
			break
		}
	}
	
	if outcome == nil {
		return fmt.Errorf("outcome not found for plan ID: %s", planID)
	}
	
	// Update with actual results
	outcome.ActualSavings = actualResults.ActualSavings
	outcome.ActualCost = actualResults.ActualCost
	outcome.ActualNodes = actualResults.ActualNodes
	outcome.ActualInstanceTypes = actualResults.ActualInstanceTypes
	outcome.ActualCapacityType = actualResults.ActualCapacityType
	outcome.PerformanceImpact = actualResults.PerformanceImpact
	outcome.Incidents = actualResults.Incidents
	
	if outcome == nil {
		return fmt.Errorf("outcome not found for plan ID: %s", planID)
	}
	
	// Recalculate success and accuracy
	outcome.Success = t.learningAgent.determineSuccess(*outcome)
	if outcome.PredictedSavings > 0 && outcome.ActualSavings >= 0 {
		diff := abs(outcome.PredictedSavings - outcome.ActualSavings)
		maxVal := max(outcome.PredictedSavings, outcome.ActualSavings)
		if maxVal > 0 {
			outcome.Accuracy = 1.0 - (diff / maxVal)
			if outcome.Accuracy < 0 {
				outcome.Accuracy = 0
			}
		} else {
			outcome.Accuracy = 1.0
		}
	}
	outcome.LessonsLearned = t.learningAgent.extractLessons(*outcome)
	
	// Record the updated outcome (this will save and relearn)
	if err := t.learningAgent.RecordOutcome(ctx, *outcome); err != nil {
		return fmt.Errorf("failed to record updated outcome: %w", err)
	}
	
	return nil
}

// ActualResults represents actual results from applying an optimization
type ActualResults struct {
	ActualSavings      float64  `json:"actualSavings"`
	ActualCost         float64  `json:"actualCost"`
	ActualNodes        int      `json:"actualNodes"`
	ActualInstanceTypes []string `json:"actualInstanceTypes"`
	ActualCapacityType string   `json:"actualCapacityType"`
	PerformanceImpact  string   `json:"performanceImpact"` // "positive", "neutral", "negative"
	Incidents          []string `json:"incidents"`
}

// GetOutcomeHistory returns the optimization history
func (t *OutcomeTracker) GetOutcomeHistory() []OptimizationOutcome {
	if t.learningAgent == nil {
		return []OptimizationOutcome{}
	}
	return t.learningAgent.GetHistory()
}

// GetLearningStats returns learning statistics
func (t *OutcomeTracker) GetLearningStats() map[string]interface{} {
	if t.learningAgent == nil {
		return map[string]interface{}{
			"enabled": false,
		}
	}
	
	return map[string]interface{}{
		"enabled":              true,
		"totalOutcomes":         t.learningAgent.GetHistoryCount(),
		"strategySuccessRates": t.learningAgent.GetStrategySuccessRates(),
		"nodePoolPatterns":     t.learningAgent.GetNodePoolPatternsCount(),
		"lastUpdated":          t.learningAgent.GetLastUpdated(),
	}
}

