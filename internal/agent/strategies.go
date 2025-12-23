package agent

import (
	"context"
	
	"github.com/karpenter-optimizer/internal/kubernetes"
	"github.com/karpenter-optimizer/internal/recommender"
)

// Strategy interface for different optimization strategies
type Strategy interface {
	GenerateRecommendations(ctx context.Context, analysis *AnalysisResult, np kubernetes.NodePoolInfo) ([]recommender.NodePoolCapacityRecommendation, error)
	GetName() string
}

// BaseStrategy provides common functionality
type BaseStrategy struct {
	recommender *recommender.Recommender
	name        string
}

// AggressiveStrategy maximizes cost savings
type AggressiveStrategy struct {
	BaseStrategy
}

// NewAggressiveStrategy creates a new aggressive strategy
func NewAggressiveStrategy(rec *recommender.Recommender) *AggressiveStrategy {
	return &AggressiveStrategy{
		BaseStrategy: BaseStrategy{
			recommender: rec,
			name:        "aggressive",
		},
	}
}

func (s *AggressiveStrategy) GetName() string {
	return s.name
}

func (s *AggressiveStrategy) GenerateRecommendations(ctx context.Context, analysis *AnalysisResult, np kubernetes.NodePoolInfo) ([]recommender.NodePoolCapacityRecommendation, error) {
	// Use existing recommender to generate base recommendations
	nodePools := []kubernetes.NodePoolInfo{np}
	
	recommendations, err := s.recommender.GenerateRecommendationsFromNodePools(ctx, nodePools, nil)
	if err != nil {
		return nil, err
	}
	
	// Filter and prioritize spot recommendations with significant savings
	filtered := make([]recommender.NodePoolCapacityRecommendation, 0)
	for _, rec := range recommendations {
		// Prefer spot if available, or if converting from on-demand
		if rec.CapacityType == "spot" || analysis.NodePoolState.CapacityType != "spot" {
			// Only include if savings are significant (>= 10%)
			if rec.CostSavingsPercent >= 10 {
				filtered = append(filtered, rec)
			}
		}
	}
	
	return filtered, nil
}

// BalancedStrategy balances cost savings and stability
type BalancedStrategy struct {
	BaseStrategy
}

// NewBalancedStrategy creates a new balanced strategy
func NewBalancedStrategy(rec *recommender.Recommender) *BalancedStrategy {
	return &BalancedStrategy{
		BaseStrategy: BaseStrategy{
			recommender: rec,
			name:        "balanced",
		},
	}
}

func (s *BalancedStrategy) GetName() string {
	return s.name
}

func (s *BalancedStrategy) GenerateRecommendations(ctx context.Context, analysis *AnalysisResult, np kubernetes.NodePoolInfo) ([]recommender.NodePoolCapacityRecommendation, error) {
	nodePools := []kubernetes.NodePoolInfo{np}
	recommendations, err := s.recommender.GenerateRecommendationsFromNodePools(ctx, nodePools, nil)
	if err != nil {
		return nil, err
	}
	
	// Filter with balanced criteria - require at least 15% savings and good confidence
	filtered := make([]recommender.NodePoolCapacityRecommendation, 0)
	for _, rec := range recommendations {
		if rec.CostSavingsPercent >= 15 && analysis.Confidence > 0.6 {
			filtered = append(filtered, rec)
		}
	}
	
	return filtered, nil
}

// ConservativeStrategy prioritizes stability
type ConservativeStrategy struct {
	BaseStrategy
}

// NewConservativeStrategy creates a new conservative strategy
func NewConservativeStrategy(rec *recommender.Recommender) *ConservativeStrategy {
	return &ConservativeStrategy{
		BaseStrategy: BaseStrategy{
			recommender: rec,
			name:        "conservative",
		},
	}
}

func (s *ConservativeStrategy) GetName() string {
	return s.name
}

func (s *ConservativeStrategy) GenerateRecommendations(ctx context.Context, analysis *AnalysisResult, np kubernetes.NodePoolInfo) ([]recommender.NodePoolCapacityRecommendation, error) {
	nodePools := []kubernetes.NodePoolInfo{np}
	recommendations, err := s.recommender.GenerateRecommendationsFromNodePools(ctx, nodePools, nil)
	if err != nil {
		return nil, err
	}
	
	// Very conservative filtering - only right-sizing, no spot conversion, high confidence
	filtered := make([]recommender.NodePoolCapacityRecommendation, 0)
	for _, rec := range recommendations {
		// Only right-sizing (same capacity type), high savings, high confidence
		if rec.CostSavingsPercent >= 20 && 
		   rec.CapacityType == analysis.NodePoolState.CapacityType &&
		   analysis.Confidence > 0.8 {
			filtered = append(filtered, rec)
		}
	}
	
	return filtered, nil
}

// SpotFirstStrategy prioritizes spot instance conversion
type SpotFirstStrategy struct {
	BaseStrategy
}

// NewSpotFirstStrategy creates a new spot-first strategy
func NewSpotFirstStrategy(rec *recommender.Recommender) *SpotFirstStrategy {
	return &SpotFirstStrategy{
		BaseStrategy: BaseStrategy{
			recommender: rec,
			name:        "spot-first",
		},
	}
}

func (s *SpotFirstStrategy) GetName() string {
	return s.name
}

func (s *SpotFirstStrategy) GenerateRecommendations(ctx context.Context, analysis *AnalysisResult, np kubernetes.NodePoolInfo) ([]recommender.NodePoolCapacityRecommendation, error) {
	// Force spot capacity type for recommendations
	npSpot := np
	npSpot.CapacityType = "spot"
	
	nodePools := []kubernetes.NodePoolInfo{npSpot}
	recommendations, err := s.recommender.GenerateRecommendationsFromNodePools(ctx, nodePools, nil)
	if err != nil {
		return nil, err
	}
	
	// Filter for spot recommendations only
	filtered := make([]recommender.NodePoolCapacityRecommendation, 0)
	for _, rec := range recommendations {
		if rec.CapacityType == "spot" {
			filtered = append(filtered, rec)
		}
	}
	
	return filtered, nil
}

// RightSizeStrategy focuses on right-sizing
type RightSizeStrategy struct {
	BaseStrategy
}

// NewRightSizeStrategy creates a new right-size strategy
func NewRightSizeStrategy(rec *recommender.Recommender) *RightSizeStrategy {
	return &RightSizeStrategy{
		BaseStrategy: BaseStrategy{
			recommender: rec,
			name:        "right-size",
		},
	}
}

func (s *RightSizeStrategy) GetName() string {
	return s.name
}

func (s *RightSizeStrategy) GenerateRecommendations(ctx context.Context, analysis *AnalysisResult, np kubernetes.NodePoolInfo) ([]recommender.NodePoolCapacityRecommendation, error) {
	// Keep same capacity type, focus on right-sizing
	nodePools := []kubernetes.NodePoolInfo{np}
	recommendations, err := s.recommender.GenerateRecommendationsFromNodePools(ctx, nodePools, nil)
	if err != nil {
		return nil, err
	}
	
	// Filter for right-sizing opportunities (reduced nodes, same capacity type)
	filtered := make([]recommender.NodePoolCapacityRecommendation, 0)
	for _, rec := range recommendations {
		if rec.CapacityType == analysis.NodePoolState.CapacityType &&
		   rec.RecommendedNodes < analysis.NodePoolState.CurrentNodes &&
		   rec.CostSavingsPercent > 10 {
			filtered = append(filtered, rec)
		}
	}
	
	return filtered, nil
}

