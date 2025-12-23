# Cost Optimization Agent - Implementation Guide

This document provides a step-by-step guide to implement the Cost Optimization Agent for generating recommendations.

## Overview

The Cost Optimization Agent will:
1. **Analyze** cluster state and pricing trends
2. **Plan** optimization strategies
3. **Generate** cost-optimized recommendations
4. **Learn** from outcomes over time

## Architecture

```
┌─────────────────────────────────────────┐
│     Cost Optimization Agent             │
├─────────────────────────────────────────┤
│  ┌──────────┐  ┌──────────┐  ┌──────┐ │
│  │ Analyzer │→ │ Planner  │→ │ Exec │ │
│  └──────────┘  └──────────┘  └──────┘ │
│       ↓              ↓            ↓     │
│  ┌──────────────────────────────────┐  │
│  │     Existing Recommender          │  │
│  │  (GenerateRecommendationsFrom...)│  │
│  └──────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

## Step 1: Create Agent Package Structure

Create a new package `internal/agent` with the following structure:

```
internal/agent/
├── cost_agent.go          # Main Cost Optimization Agent
├── analyzer.go            # Analyzes cluster state and pricing
├── planner.go             # Plans optimization strategies
├── strategies.go          # Different optimization strategies
└── types.go               # Agent-specific types
```

## Step 2: Define Agent Types

**File: `internal/agent/types.go`**

```go
package agent

import (
	"time"
	"github.com/karpenter-optimizer/internal/kubernetes"
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
	ID              string
	NodePoolName    string
	Strategy        OptimizationStrategy
	CurrentState    *NodePoolState
	Recommendations []recommender.NodePoolCapacityRecommendation
	RiskLevel       string // "low", "medium", "high"
	EstimatedSavings float64
	Confidence      float64 // 0.0 - 1.0
	CreatedAt       time.Time
}

// NodePoolState represents the current state of a NodePool
type NodePoolState struct {
	Name              string
	CurrentNodes      int
	CurrentCost       float64
	CPUUtilization    float64
	MemoryUtilization float64
	CapacityType      string // "spot", "on-demand", "mixed"
	SpotRatio         float64 // Percentage of nodes that are spot
	InstanceTypes     []string
	LastOptimized     *time.Time
}

// PricingTrend represents pricing trends over time
type PricingTrend struct {
	InstanceType string
	OnDemandPrice float64
	SpotPrice     float64
	SpotSavings   float64 // Percentage savings
	Availability  string  // "high", "medium", "low"
	Trend         string  // "stable", "increasing", "decreasing"
}

// AnalysisResult contains the agent's analysis of a NodePool
type AnalysisResult struct {
	NodePoolState *NodePoolState
	OptimizationOpportunities []OptimizationOpportunity
	PricingTrends map[string]*PricingTrend
	RiskFactors   []string
	Confidence    float64
}

// OptimizationOpportunity identifies a specific optimization opportunity
type OptimizationOpportunity struct {
	Type        string // "spot-conversion", "right-size", "instance-type-change"
	Description string
	PotentialSavings float64
	RiskLevel   string
	Confidence  float64
}
```

## Step 3: Implement the Analyzer

**File: `internal/agent/analyzer.go`**

```go
package agent

import (
	"context"
	"fmt"
	"time"
	
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
	state := a.calculateNodePoolState(np)
	
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
		Confidence:                confidence,
	}, nil
}

// calculateNodePoolState calculates the current state of a NodePool
func (a *Analyzer) calculateNodePoolState(np kubernetes.NodePoolInfo) *NodePoolState {
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
			nodeCost := a.recommender.EstimateCost(context.Background(), []string{node.InstanceType}, capacityType, 1)
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
		overProvisionedRatio := 1.0 - (state.CPUUtilization / 100.0)
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
	
	// Opportunity 3: Instance type optimization
	// Check if cheaper instance types with similar specs are available
	// This would require comparing current instance types with alternatives
	
	return opportunities
}

// analyzePricingTrends analyzes pricing trends for instance types
func (a *Analyzer) analyzePricingTrends(ctx context.Context, instanceTypes []string) map[string]*PricingTrend {
	trends := make(map[string]*PricingTrend)
	
	for _, it := range instanceTypes {
		// Get current pricing
		onDemandPrice := a.recommender.EstimateCost(ctx, []string{it}, "on-demand", 1)
		spotPrice := a.recommender.EstimateCost(ctx, []string{it}, "spot", 1)
		
		spotSavings := ((onDemandPrice - spotPrice) / onDemandPrice) * 100
		
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
	
	// Ensure confidence is between 0 and 1
	if confidence < 0.1 {
		confidence = 0.1
	}
	if confidence > 1.0 {
		confidence = 1.0
	}
	
	return confidence
}
```

## Step 4: Implement the Planner

**File: `internal/agent/planner.go`**

```go
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
	strategies  map[OptimizationStrategy]*Strategy
}

// NewPlanner creates a new planner
func NewPlanner(rec *recommender.Recommender) *Planner {
	p := &Planner{
		recommender: rec,
		strategies:  make(map[OptimizationStrategy]*Strategy),
	}
	
	// Initialize strategies
	p.strategies[StrategyAggressive] = NewAggressiveStrategy(rec)
	p.strategies[StrategyBalanced] = NewBalancedStrategy(rec)
	p.strategies[StrategyConservative] = NewConservativeStrategy(rec)
	p.strategies[StrategySpotFirst] = NewSpotFirstStrategy(rec)
	p.strategies[StrategyRightSize] = NewRightSizeStrategy(rec)
	
	return p
}

// PlanOptimization creates an optimization plan for a NodePool
func (p *Planner) PlanOptimization(ctx context.Context, analysis *AnalysisResult, strategy OptimizationStrategy) (*OptimizationPlan, error) {
	// Select strategy
	strategyImpl, ok := p.strategies[strategy]
	if !ok {
		strategy = StrategyBalanced // Default to balanced
		strategyImpl = p.strategies[strategy]
	}
	
	// Get NodePool info (we'll need to pass this)
	// For now, we'll generate recommendations using existing recommender
	
	// Generate recommendations using the selected strategy
	recommendations, err := strategyImpl.GenerateRecommendations(ctx, analysis)
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
		ID:              fmt.Sprintf("plan-%d", time.Now().Unix()),
		NodePoolName:    analysis.NodePoolState.Name,
		Strategy:        strategy,
		CurrentState:    analysis.NodePoolState,
		Recommendations: recommendations,
		RiskLevel:       riskLevel,
		EstimatedSavings: estimatedSavings,
		Confidence:      analysis.Confidence,
		CreatedAt:       time.Now(),
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
		if rec.RecommendedNodes < analysis.NodePoolState.CurrentNodes*0.7 {
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
```

## Step 5: Implement Strategies

**File: `internal/agent/strategies.go`**

```go
package agent

import (
	"context"
	"fmt"
	
	"github.com/karpenter-optimizer/internal/kubernetes"
	"github.com/karpenter-optimizer/internal/recommender"
)

// Strategy interface for different optimization strategies
type Strategy interface {
	GenerateRecommendations(ctx context.Context, analysis *AnalysisResult) ([]recommender.NodePoolCapacityRecommendation, error)
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

func (s *AggressiveStrategy) GenerateRecommendations(ctx context.Context, analysis *AnalysisResult) ([]recommender.NodePoolCapacityRecommendation, error) {
	// Get NodePool info - we need to fetch this
	// For now, create a mock NodePoolInfo
	np := kubernetes.NodePoolInfo{
		Name:         analysis.NodePoolState.Name,
		CurrentNodes: analysis.NodePoolState.CurrentNodes,
		InstanceTypes: analysis.NodePoolState.InstanceTypes,
		CapacityType: analysis.NodePoolState.CapacityType,
	}
	
	// Use existing recommender but force spot preference
	// This is a simplified version - full implementation would need more context
	nodePools := []kubernetes.NodePoolInfo{np}
	
	// Generate recommendations using existing system
	recommendations, err := s.recommender.GenerateRecommendationsFromNodePools(ctx, nodePools, nil)
	if err != nil {
		return nil, err
	}
	
	// Filter and prioritize spot recommendations
	filtered := make([]recommender.NodePoolCapacityRecommendation, 0)
	for _, rec := range recommendations {
		// Prefer spot if available
		if rec.CapacityType == "spot" || analysis.NodePoolState.CapacityType != "spot" {
			// Only include if savings are significant
			if rec.CostSavingsPercent > 10 {
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

func (s *BalancedStrategy) GenerateRecommendations(ctx context.Context, analysis *AnalysisResult) ([]recommender.NodePoolCapacityRecommendation, error) {
	// Similar to aggressive but with more conservative thresholds
	np := kubernetes.NodePoolInfo{
		Name:         analysis.NodePoolState.Name,
		CurrentNodes: analysis.NodePoolState.CurrentNodes,
		InstanceTypes: analysis.NodePoolState.InstanceTypes,
		CapacityType: analysis.NodePoolState.CapacityType,
	}
	
	nodePools := []kubernetes.NodePoolInfo{np}
	recommendations, err := s.recommender.GenerateRecommendationsFromNodePools(ctx, nodePools, nil)
	if err != nil {
		return nil, err
	}
	
	// Filter with balanced criteria
	filtered := make([]recommender.NodePoolCapacityRecommendation, 0)
	for _, rec := range recommendations {
		// Require at least 15% savings and low-medium risk
		if rec.CostSavingsPercent > 15 && analysis.Confidence > 0.6 {
			filtered = append(filtered, rec)
		}
	}
	
	return filtered, nil
}

// ConservativeStrategy prioritizes stability
type ConservativeStrategy struct {
	BaseStrategy
}

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

func (s *ConservativeStrategy) GenerateRecommendations(ctx context.Context, analysis *AnalysisResult) ([]recommender.NodePoolCapacityRecommendation, error) {
	// Only recommend very safe optimizations
	np := kubernetes.NodePoolInfo{
		Name:         analysis.NodePoolState.Name,
		CurrentNodes: analysis.NodePoolState.CurrentNodes,
		InstanceTypes: analysis.NodePoolState.InstanceTypes,
		CapacityType: analysis.NodePoolState.CapacityType,
	}
	
	nodePools := []kubernetes.NodePoolInfo{np}
	recommendations, err := s.recommender.GenerateRecommendationsFromNodePools(ctx, nodePools, nil)
	if err != nil {
		return nil, err
	}
	
	// Very conservative filtering
	filtered := make([]recommender.NodePoolCapacityRecommendation, 0)
	for _, rec := range recommendations {
		// Only right-sizing, no spot conversion, high confidence
		if rec.CostSavingsPercent > 20 && 
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

func (s *SpotFirstStrategy) GenerateRecommendations(ctx context.Context, analysis *AnalysisResult) ([]recommender.NodePoolCapacityRecommendation, error) {
	// Force spot recommendations
	np := kubernetes.NodePoolInfo{
		Name:         analysis.NodePoolState.Name,
		CurrentNodes: analysis.NodePoolState.CurrentNodes,
		InstanceTypes: analysis.NodePoolState.InstanceTypes,
		CapacityType: "spot", // Force spot
	}
	
	nodePools := []kubernetes.NodePoolInfo{np}
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

func (s *RightSizeStrategy) GenerateRecommendations(ctx context.Context, analysis *AnalysisResult) ([]recommender.NodePoolCapacityRecommendation, error) {
	// Focus on right-sizing, keep capacity type the same
	np := kubernetes.NodePoolInfo{
		Name:         analysis.NodePoolState.Name,
		CurrentNodes: analysis.NodePoolState.CurrentNodes,
		InstanceTypes: analysis.NodePoolState.InstanceTypes,
		CapacityType: analysis.NodePoolState.CapacityType, // Keep same
	}
	
	nodePools := []kubernetes.NodePoolInfo{np}
	recommendations, err := s.recommender.GenerateRecommendationsFromNodePools(ctx, nodePools, nil)
	if err != nil {
		return nil, err
	}
	
	// Filter for right-sizing opportunities (reduced nodes, same capacity type)
	filtered := make([]recommender.NodePoolCapacityRecommendation, 0)
	for _, rec := range recommendations {
		if rec.CapacityType == analysis.NodePoolState.CapacityType &&
		   rec.RecommendedNodes < analysis.NodePoolState.CurrentNodes {
			filtered = append(filtered, rec)
		}
	}
	
	return filtered, nil
}
```

## Step 6: Implement Main Cost Agent

**File: `internal/agent/cost_agent.go`**

```go
package agent

import (
	"context"
	"fmt"
	"time"
	
	"github.com/karpenter-optimizer/internal/kubernetes"
	"github.com/karpenter-optimizer/internal/recommender"
)

// CostOptimizationAgent is the main agent for cost optimization
type CostOptimizationAgent struct {
	analyzer  *Analyzer
	planner   *Planner
	recommender *recommender.Recommender
	k8sClient *kubernetes.Client
	strategy  OptimizationStrategy
}

// NewCostOptimizationAgent creates a new cost optimization agent
func NewCostOptimizationAgent(
	rec *recommender.Recommender,
	k8sClient *kubernetes.Client,
	strategy OptimizationStrategy,
) *CostOptimizationAgent {
	if strategy == "" {
		strategy = StrategyBalanced // Default
	}
	
	return &CostOptimizationAgent{
		analyzer:    NewAnalyzer(rec, k8sClient),
		planner:     NewPlanner(rec),
		recommender: rec,
		k8sClient:   k8sClient,
		strategy:    strategy,
	}
}

// GenerateRecommendations generates cost-optimized recommendations using the agent
func (a *CostOptimizationAgent) GenerateRecommendations(ctx context.Context) ([]*OptimizationPlan, error) {
	// Get all NodePools
	nodePools, err := a.k8sClient.ListNodePools(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to list NodePools: %w", err)
	}
	
	var plans []*OptimizationPlan
	
	for _, np := range nodePools {
		// Skip NodePools with no nodes
		if len(np.ActualNodes) == 0 {
			continue
		}
		
		// Analyze NodePool
		analysis, err := a.analyzer.AnalyzeNodePool(ctx, np)
		if err != nil {
			fmt.Printf("Warning: Failed to analyze NodePool %s: %v\n", np.Name, err)
			continue
		}
		
		// Plan optimization
		plan, err := a.planner.PlanOptimization(ctx, analysis, a.strategy)
		if err != nil {
			fmt.Printf("Warning: Failed to plan optimization for %s: %v\n", np.Name, err)
			continue
		}
		
		// Only include plans with recommendations
		if len(plan.Recommendations) > 0 {
			plans = append(plans, plan)
		}
	}
	
	return plans, nil
}

// GenerateRecommendationsForNodePool generates recommendations for a specific NodePool
func (a *CostOptimizationAgent) GenerateRecommendationsForNodePool(ctx context.Context, nodePoolName string) (*OptimizationPlan, error) {
	// Get NodePool
	nodePools, err := a.k8sClient.ListNodePools(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to list NodePools: %w", err)
	}
	
	var targetNodePool *kubernetes.NodePoolInfo
	for i := range nodePools {
		if nodePools[i].Name == nodePoolName {
			targetNodePool = &nodePools[i]
			break
		}
	}
	
	if targetNodePool == nil {
		return nil, fmt.Errorf("NodePool %s not found", nodePoolName)
	}
	
	// Analyze
	analysis, err := a.analyzer.AnalyzeNodePool(ctx, *targetNodePool)
	if err != nil {
		return nil, fmt.Errorf("failed to analyze NodePool: %w", err)
	}
	
	// Plan
	plan, err := a.planner.PlanOptimization(ctx, analysis, a.strategy)
	if err != nil {
		return nil, fmt.Errorf("failed to plan optimization: %w", err)
	}
	
	return plan, nil
}

// SetStrategy changes the optimization strategy
func (a *CostOptimizationAgent) SetStrategy(strategy OptimizationStrategy) {
	a.strategy = strategy
}
```

## Step 7: Add API Endpoint

**File: `internal/api/server.go`** (add this method)

```go
// GetCostOptimizationRecommendations godoc
// @Summary      Get cost optimization recommendations from AI agent
// @Description  Get AI agent-generated cost optimization recommendations
// @Tags         agent
// @Accept       json
// @Produce      json
// @Param        strategy  query     string  false  "Optimization strategy: aggressive, balanced, conservative, spot-first, right-size"
// @Success      200  {object}  map[string]interface{}  "Optimization plans"
// @Failure      500  {object}  map[string]interface{}  "Internal server error"
// @Router       /api/v1/agent/cost-optimization [get]
func (s *Server) getCostOptimizationRecommendations(c *gin.Context) {
	if s.recommender == nil || s.k8sClient == nil {
		c.JSON(503, gin.H{"error": "Recommender or Kubernetes client not configured"})
		return
	}
	
	// Get strategy from query parameter
	strategyParam := c.Query("strategy")
	var strategy agent.OptimizationStrategy
	switch strategyParam {
	case "aggressive":
		strategy = agent.StrategyAggressive
	case "conservative":
		strategy = agent.StrategyConservative
	case "spot-first":
		strategy = agent.StrategySpotFirst
	case "right-size":
		strategy = agent.StrategyRightSize
	default:
		strategy = agent.StrategyBalanced
	}
	
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	
	// Create agent
	costAgent := agent.NewCostOptimizationAgent(s.recommender, s.k8sClient, strategy)
	
	// Generate recommendations
	plans, err := costAgent.GenerateRecommendations(ctx)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	
	c.JSON(200, gin.H{
		"plans":    plans,
		"count":    len(plans),
		"strategy": strategy,
	})
}
```

And add the route in `setupRoutes()`:
```go
agentGroup := api.Group("/agent")
{
	agentGroup.GET("/cost-optimization", s.getCostOptimizationRecommendations)
}
```

## Step 8: Testing the Agent

Create a simple test:

```go
// internal/agent/cost_agent_test.go
package agent

import (
	"context"
	"testing"
	// ... imports
)

func TestCostOptimizationAgent_GenerateRecommendations(t *testing.T) {
	// Setup test recommender and k8s client
	// ...
	
	agent := NewCostOptimizationAgent(rec, k8sClient, StrategyBalanced)
	plans, err := agent.GenerateRecommendations(context.Background())
	
	if err != nil {
		t.Fatalf("Failed to generate recommendations: %v", err)
	}
	
	if len(plans) == 0 {
		t.Log("No optimization plans generated (may be expected if no optimizations available)")
	}
	
	// Verify plan structure
	for _, plan := range plans {
		if plan.NodePoolName == "" {
			t.Error("Plan missing NodePool name")
		}
		if len(plan.Recommendations) == 0 {
			t.Error("Plan has no recommendations")
		}
	}
}
```

## Next Steps

1. **Implement the basic structure** (Steps 1-6)
2. **Add API endpoint** (Step 7)
3. **Test with real cluster** (Step 8)
4. **Add frontend UI** to display agent recommendations
5. **Add learning capabilities** - track outcomes and improve
6. **Add approval gates** - require human approval before applying

## Integration with Existing System

The agent builds on top of the existing `Recommender` system:
- Uses `GenerateRecommendationsFromNodePools` for base recommendations
- Adds agent-specific analysis and planning
- Provides different strategies for different use cases
- Can be used alongside existing recommendation endpoints

This allows gradual adoption - you can use the agent for some NodePools while keeping the existing system for others.

