package api

import (
	"context"
	"time"
	
	"github.com/gin-gonic/gin"
	"github.com/karpenter-optimizer/internal/agent"
)

// GetCostOptimizationRecommendations godoc
// @Summary      Get cost optimization recommendations from AI agent
// @Description  Get AI agent-generated cost optimization recommendations using different strategies
// @Tags         agent
// @Accept       json
// @Produce      json
// @Param        strategy  query     string  false  "Optimization strategy: aggressive, balanced, conservative, spot-first, right-size (default: balanced)"
// @Success      200  {object}  map[string]interface{}  "Optimization plans"
// @Failure      500  {object}  map[string]interface{}  "Internal server error"
// @Failure      503  {object}  map[string]interface{}  "Service not configured"
// @Router       /agent/cost-optimization [get]
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
	
	// Use request context with timeout to allow cancellation
	ctx, cancel := context.WithTimeout(c.Request.Context(), 120*time.Second)
	defer cancel()
	
	// Create agent
	costAgent := agent.NewCostOptimizationAgent(s.recommender, s.k8sClient, strategy)
	
	// Generate recommendations with error handling
	plans, err := costAgent.GenerateRecommendations(ctx)
	if err != nil {
		// Check if context was cancelled/timed out
		if ctx.Err() == context.DeadlineExceeded {
			c.JSON(504, gin.H{"error": "Request timeout: Agent took too long to generate recommendations"})
			return
		}
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	
	c.JSON(200, gin.H{
		"plans":    plans,
		"count":    len(plans),
		"strategy": strategy,
	})
}

// RecordOptimizationOutcome godoc
// @Summary      Record optimization outcome for learning
// @Description  Record the outcome of applying an optimization plan so the agent can learn
// @Tags         agent
// @Accept       json
// @Produce      json
// @Param        outcome  body      agent.OptimizationOutcome  true  "Optimization outcome"
// @Success      200  {object}  map[string]interface{}  "Outcome recorded"
// @Failure      400  {object}  map[string]interface{}  "Invalid request"
// @Failure      500  {object}  map[string]interface{}  "Internal server error"
// @Router       /agent/outcomes [post]
func (s *Server) recordOptimizationOutcome(c *gin.Context) {
	if s.recommender == nil {
		c.JSON(503, gin.H{"error": "Recommender not configured"})
		return
	}
	
	var outcome agent.OptimizationOutcome
	if err := c.ShouldBindJSON(&outcome); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	
	// Create agent to access learning agent
	costAgent := agent.NewCostOptimizationAgent(s.recommender, s.k8sClient, agent.StrategyBalanced)
	learningAgent := costAgent.GetLearningAgent()
	
	if learningAgent == nil {
		c.JSON(503, gin.H{"error": "Learning agent not available"})
		return
	}
	
	// Record outcome for learning
	if err := learningAgent.RecordOutcome(ctx, outcome); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	
	c.JSON(200, gin.H{
		"message": "Outcome recorded successfully",
		"planId":  outcome.PlanID,
	})
}

// GetLearningStats godoc
// @Summary      Get learning statistics
// @Description  Get statistics about what the agent has learned from optimization outcomes
// @Tags         agent
// @Accept       json
// @Produce      json
// @Success      200  {object}  map[string]interface{}  "Learning statistics"
// @Failure      500  {object}  map[string]interface{}  "Internal server error"
// @Router       /agent/learning/stats [get]
func (s *Server) getLearningStats(c *gin.Context) {
	if s.recommender == nil {
		c.JSON(503, gin.H{"error": "Recommender not configured"})
		return
	}
	
	// Create agent to access learning agent
	costAgent := agent.NewCostOptimizationAgent(s.recommender, s.k8sClient, agent.StrategyBalanced)
	learningAgent := costAgent.GetLearningAgent()
	
	if learningAgent == nil {
		c.JSON(200, gin.H{
			"enabled": false,
			"message": "Learning agent not available",
		})
		return
	}
	
	// Get stats from learning agent
	stats := map[string]interface{}{
		"enabled": true,
	}
	
	// Get strategy success rates
	strategyRates := make(map[string]float64)
	strategies := []agent.OptimizationStrategy{
		agent.StrategyAggressive,
		agent.StrategyBalanced,
		agent.StrategyConservative,
		agent.StrategySpotFirst,
		agent.StrategyRightSize,
	}
	for _, strategy := range strategies {
		rate := learningAgent.GetStrategySuccessRate(strategy)
		strategyRates[string(strategy)] = rate
	}
	stats["strategySuccessRates"] = strategyRates
	
	// Get history count
	stats["totalOutcomes"] = learningAgent.GetHistoryCount()
	
	c.JSON(200, stats)
}

// GetOptimizationHistory godoc
// @Summary      Get optimization history
// @Description  Get the history of optimization outcomes for learning
// @Tags         agent
// @Accept       json
// @Produce      json
// @Success      200  {object}  map[string]interface{}  "Optimization history"
// @Failure      500  {object}  map[string]interface{}  "Internal server error"
// @Router       /agent/learning/history [get]
func (s *Server) getOptimizationHistory(c *gin.Context) {
	if s.recommender == nil {
		c.JSON(503, gin.H{"error": "Recommender not configured"})
		return
	}
	
	// Create agent to access learning agent
	costAgent := agent.NewCostOptimizationAgent(s.recommender, s.k8sClient, agent.StrategyBalanced)
	learningAgent := costAgent.GetLearningAgent()
	
	if learningAgent == nil {
		c.JSON(200, gin.H{
			"history": []agent.OptimizationOutcome{},
			"count":   0,
		})
		return
	}
	
	// Get history
	history := learningAgent.GetHistory()
	
	c.JSON(200, gin.H{
		"history": history,
		"count":   len(history),
	})
}

