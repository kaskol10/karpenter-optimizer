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
	analyzer      *Analyzer
	planner       *Planner
	recommender   *recommender.Recommender
	k8sClient     *kubernetes.Client
	strategy      OptimizationStrategy
	llmEnhancer   *LLMEnhancer
	learningAgent *LearningAgent
	useLLM        bool // Whether to use LLM for enhancements
	useLearning   bool // Whether to use learning from outcomes
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
	
	llmEnhancer := NewLLMEnhancer(rec)
	
	// Initialize learning agent (history stored in /tmp/karpenter-optimizer-history.json)
	// In production, this could be a database or persistent storage
	historyFile := "/tmp/karpenter-optimizer-history.json"
	learningAgent, err := NewLearningAgent(historyFile)
	if err != nil {
		fmt.Printf("Warning: Failed to initialize learning agent: %v\n", err)
		learningAgent = nil
	}
	
	// Check if LLM is actually available
	useLLM := llmEnhancer.HasLLM()
	if useLLM {
		fmt.Printf("LLM enhancement enabled for agent recommendations\n")
	} else {
		fmt.Printf("LLM not configured - agent will use rule-based recommendations only\n")
	}
	
	return &CostOptimizationAgent{
		analyzer:      NewAnalyzer(rec, k8sClient),
		planner:       NewPlanner(rec),
		recommender:   rec,
		k8sClient:     k8sClient,
		strategy:      strategy,
		llmEnhancer:   llmEnhancer,
		learningAgent: learningAgent,
		useLLM:        useLLM,  // Only enable if LLM is actually available
		useLearning:   true,    // Enable learning by default
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
		
		// Apply learning: adjust strategy if we have learned patterns
		strategy := a.strategy
		if a.useLearning && a.learningAgent != nil {
			learnedStrategy, successRate := a.learningAgent.GetBestStrategyForNodePool(np.Name)
			if successRate > 0.7 && learnedStrategy != "" {
				strategy = learnedStrategy
				analysis.Confidence = a.learningAgent.AdjustConfidence(analysis.Confidence, np.Name, strategy)
			}
		}
		
		// Plan optimization
		plan, err := a.planner.PlanOptimization(ctx, analysis, strategy, np)
		if err != nil {
			fmt.Printf("Warning: Failed to plan optimization for %s: %v\n", np.Name, err)
			continue
		}
		
		// Apply learning insights
		if a.useLearning && a.learningAgent != nil {
			plan.LearnedFromHistory = true
			
			// Get optimal configuration if learned
			optimalConfig := a.learningAgent.GetOptimalConfiguration(np.Name)
			if optimalConfig != nil && optimalConfig.Confidence > 0.7 {
				plan.LearningInsights = append(plan.LearningInsights, 
					fmt.Sprintf("Based on %d previous optimizations, optimal config: %v %s nodes", 
						optimalConfig.NodeCount, optimalConfig.InstanceTypes, optimalConfig.CapacityType))
			}
			
			// Adjust confidence based on learning
			plan.Confidence = a.learningAgent.AdjustConfidence(plan.Confidence, np.Name, strategy)
			
			// Add strategy success rate insight
			strategyRate := a.learningAgent.GetStrategySuccessRate(strategy)
			if strategyRate > 0.7 {
				plan.LearningInsights = append(plan.LearningInsights, 
					fmt.Sprintf("Strategy '%s' has %.0f%% success rate historically", strategy, strategyRate*100))
			}
		}
		
		// Enhance recommendations with LLM if available and enabled
		// This ensures AI-enhanced explanations are applied when LLM is configured
		// Use a shorter timeout for LLM enhancement to avoid blocking
		if a.useLLM && a.llmEnhancer.HasLLM() && len(plan.Recommendations) > 0 {
			// Use a separate context with shorter timeout for LLM enhancement
			llmCtx, llmCancel := context.WithTimeout(ctx, 30*time.Second)
			enhancedRecs, err := a.llmEnhancer.EnhanceRecommendationsWithLLM(llmCtx, plan.Recommendations)
			llmCancel()
			
			if err == nil && len(enhancedRecs) > 0 {
				plan.Recommendations = enhancedRecs
				// AI-enhanced explanations are now in plan.Recommendations[].AIReasoning
				// These will be displayed in the frontend when available
			} else if err != nil {
				// Log but don't fail - continue with non-enhanced recommendations
				if ctx.Err() == nil { // Only log if parent context is still valid
					fmt.Printf("Warning: Failed to enhance recommendations with LLM for NodePool %s: %v\n", np.Name, err)
				}
			}
		} else if !a.llmEnhancer.HasLLM() && a.useLLM {
			// Log when LLM is requested but not available
			fmt.Printf("Info: LLM enhancement requested but LLM client not configured for NodePool %s\n", np.Name)
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
	plan, err := a.planner.PlanOptimization(ctx, analysis, a.strategy, *targetNodePool)
	if err != nil {
		return nil, fmt.Errorf("failed to plan optimization: %w", err)
	}
	
	// Enhance recommendations with LLM if available and enabled
	// This ensures AI-enhanced explanations are applied when LLM is configured
	if a.useLLM && a.llmEnhancer.HasLLM() && len(plan.Recommendations) > 0 {
		enhancedRecs, err := a.llmEnhancer.EnhanceRecommendationsWithLLM(ctx, plan.Recommendations)
		if err == nil && len(enhancedRecs) > 0 {
			plan.Recommendations = enhancedRecs
			// AI-enhanced explanations are now in plan.Recommendations[].AIReasoning
		} else if err != nil {
			fmt.Printf("Warning: Failed to enhance recommendations with LLM for NodePool %s: %v\n", nodePoolName, err)
		}
	}
	
	return plan, nil
}

// SetStrategy changes the optimization strategy
func (a *CostOptimizationAgent) SetStrategy(strategy OptimizationStrategy) {
	a.strategy = strategy
}

// GetStrategy returns the current optimization strategy
func (a *CostOptimizationAgent) GetStrategy() OptimizationStrategy {
	return a.strategy
}

// GetLearningAgent returns the learning agent (for outcome tracking)
func (a *CostOptimizationAgent) GetLearningAgent() *LearningAgent {
	return a.learningAgent
}

