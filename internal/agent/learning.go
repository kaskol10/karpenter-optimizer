package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// OptimizationOutcome represents the result of applying an optimization
type OptimizationOutcome struct {
	PlanID              string    `json:"planId"`
	NodePoolName        string    `json:"nodePoolName"`
	Strategy            OptimizationStrategy `json:"strategy"`
	AppliedAt           time.Time `json:"appliedAt"`
	
	// Predicted values (from plan)
	PredictedSavings    float64   `json:"predictedSavings"`
	PredictedConfidence float64   `json:"predictedConfidence"`
	PredictedRiskLevel  string    `json:"predictedRiskLevel"`
	
	// Actual outcomes
	ActualSavings       float64   `json:"actualSavings,omitempty"`       // Actual cost savings achieved
	ActualCost          float64   `json:"actualCost,omitempty"`          // Actual cost after optimization
	PerformanceImpact   string    `json:"performanceImpact,omitempty"`   // "positive", "neutral", "negative"
	Incidents           []string  `json:"incidents,omitempty"`            // Any incidents/issues encountered
	UserFeedback        string    `json:"userFeedback,omitempty"`        // User feedback: "approved", "rejected", "partial"
	
	// Metrics
	ActualNodes         int       `json:"actualNodes,omitempty"`
	ActualInstanceTypes []string `json:"actualInstanceTypes,omitempty"`
	ActualCapacityType  string    `json:"actualCapacityType,omitempty"`
	
	// Learning data
	Success             bool      `json:"success"`                        // Whether optimization was successful
	Accuracy            float64   `json:"accuracy"`                       // How close prediction was to actual (0-1)
	LessonsLearned      []string  `json:"lessonsLearned,omitempty"`       // Key learnings from this outcome
}

// LearningAgent learns from optimization outcomes
type LearningAgent struct {
	historyFile string
	history     []OptimizationOutcome
	historyMu   sync.RWMutex
	patterns    *LearnedPatterns
	patternsMu  sync.RWMutex
}

// LearnedPatterns stores patterns learned from history
type LearnedPatterns struct {
	StrategySuccessRates map[OptimizationStrategy]float64 `json:"strategySuccessRates"`
	NodePoolPatterns     map[string]*NodePoolPattern       `json:"nodePoolPatterns"`
	RiskFactors          map[string]float64                `json:"riskFactors"` // Risk factor -> impact score
	InstanceTypePrefs    map[string]float64                `json:"instanceTypePrefs"` // Instance type -> success rate
	LastUpdated          time.Time                         `json:"lastUpdated"`
}

// NodePoolPattern stores learned patterns for a specific NodePool
type NodePoolPattern struct {
	NodePoolName         string                            `json:"nodePoolName"`
	BestStrategy         OptimizationStrategy              `json:"bestStrategy"`
	StrategyHistory      map[OptimizationStrategy]int      `json:"strategyHistory"` // Count of uses
	SuccessRate          float64                           `json:"successRate"`
	AvgSavings           float64                           `json:"avgSavings"`
	CommonIssues         []string                          `json:"commonIssues"`
	OptimalConfig        *OptimalConfiguration             `json:"optimalConfig,omitempty"`
}

// OptimalConfiguration stores optimal configuration learned for a NodePool
type OptimalConfiguration struct {
	InstanceTypes    []string `json:"instanceTypes"`
	CapacityType     string   `json:"capacityType"`
	NodeCount        int      `json:"nodeCount"`
	Confidence       float64  `json:"confidence"`
}

// NewLearningAgent creates a new learning agent
func NewLearningAgent(historyFile string) (*LearningAgent, error) {
	agent := &LearningAgent{
		historyFile: historyFile,
		history:     make([]OptimizationOutcome, 0),
		patterns: &LearnedPatterns{
			StrategySuccessRates: make(map[OptimizationStrategy]float64),
			NodePoolPatterns:     make(map[string]*NodePoolPattern),
			RiskFactors:          make(map[string]float64),
			InstanceTypePrefs:    make(map[string]float64),
		},
	}
	
	// Load existing history (non-blocking - continue even if it fails)
	if err := agent.loadHistory(); err != nil {
		fmt.Printf("Warning: Failed to load optimization history: %v (continuing without history)\n", err)
		// Continue with empty history - this is not critical
	}
	
	// Analyze history to learn patterns (non-blocking)
	// Use a goroutine to avoid blocking initialization
	go func() {
		defer func() {
			if r := recover(); r != nil {
				fmt.Printf("Warning: Panic in learnFromHistory: %v\n", r)
			}
		}()
		agent.learnFromHistory()
	}()
	
	return agent, nil
}

// RecordOutcome records an optimization outcome for learning
func (l *LearningAgent) RecordOutcome(ctx context.Context, outcome OptimizationOutcome) error {
	l.historyMu.Lock()
	defer l.historyMu.Unlock()
	
	// Calculate accuracy if we have actual savings
	if outcome.PredictedSavings > 0 && outcome.ActualSavings >= 0 {
		// Accuracy: how close predicted was to actual (1.0 = perfect match)
		diff := abs(outcome.PredictedSavings - outcome.ActualSavings)
		maxVal := max(outcome.PredictedSavings, outcome.ActualSavings)
		if maxVal > 0 {
			outcome.Accuracy = 1.0 - (diff / maxVal)
			if outcome.Accuracy < 0 {
				outcome.Accuracy = 0
			}
		} else {
			outcome.Accuracy = 1.0 // Perfect if both are 0
		}
	}
	
	// Determine success
	outcome.Success = l.determineSuccess(outcome)
	
	// Extract lessons learned
	outcome.LessonsLearned = l.extractLessons(outcome)
	
	// Add to history
	l.history = append(l.history, outcome)
	
	// Save history
	if err := l.saveHistory(); err != nil {
		return fmt.Errorf("failed to save history: %w", err)
	}
	
	// Learn from this outcome
	l.learnFromOutcome(outcome)
	
	return nil
}

// GetBestStrategyForNodePool returns the best strategy learned for a NodePool
func (l *LearningAgent) GetBestStrategyForNodePool(nodePoolName string) (OptimizationStrategy, float64) {
	l.patternsMu.RLock()
	defer l.patternsMu.RUnlock()
	
	pattern, ok := l.patterns.NodePoolPatterns[nodePoolName]
	if !ok || pattern.BestStrategy == "" {
		return StrategyBalanced, 0.5 // Default
	}
	
	return pattern.BestStrategy, pattern.SuccessRate
}

// GetStrategySuccessRate returns the overall success rate for a strategy
func (l *LearningAgent) GetStrategySuccessRate(strategy OptimizationStrategy) float64 {
	l.patternsMu.RLock()
	defer l.patternsMu.RUnlock()
	
	rate, ok := l.patterns.StrategySuccessRates[strategy]
	if !ok {
		return 0.5 // Default if no data
	}
	return rate
}

// GetOptimalConfiguration returns learned optimal configuration for a NodePool
func (l *LearningAgent) GetOptimalConfiguration(nodePoolName string) *OptimalConfiguration {
	l.patternsMu.RLock()
	defer l.patternsMu.RUnlock()
	
	pattern, ok := l.patterns.NodePoolPatterns[nodePoolName]
	if !ok {
		return nil
	}
	return pattern.OptimalConfig
}

// AdjustConfidence adjusts confidence based on historical accuracy
func (l *LearningAgent) AdjustConfidence(baseConfidence float64, nodePoolName string, strategy OptimizationStrategy) float64 {
	l.patternsMu.RLock()
	defer l.patternsMu.RUnlock()
	
	// Get strategy success rate
	strategyRate := l.patterns.StrategySuccessRates[strategy]
	if strategyRate == 0 {
		strategyRate = 0.5 // Default
	}
	
	// Get NodePool-specific success rate
	pattern, ok := l.patterns.NodePoolPatterns[nodePoolName]
	nodePoolRate := 0.5 // Default
	if ok {
		nodePoolRate = pattern.SuccessRate
	}
	
	// Weighted average: 60% base confidence, 20% strategy rate, 20% NodePool rate
	adjusted := baseConfidence*0.6 + strategyRate*0.2 + nodePoolRate*0.2
	
	// Ensure between 0 and 1
	if adjusted < 0 {
		adjusted = 0
	}
	if adjusted > 1 {
		adjusted = 1
	}
	
	return adjusted
}

// GetRiskFactorImpact returns learned impact score for a risk factor
func (l *LearningAgent) GetRiskFactorImpact(riskFactor string) float64 {
	l.patternsMu.RLock()
	defer l.patternsMu.RUnlock()
	
	impact, ok := l.patterns.RiskFactors[riskFactor]
	if !ok {
		return 0.5 // Default impact
	}
	return impact
}

// learnFromHistory analyzes all historical outcomes to learn patterns
func (l *LearningAgent) learnFromHistory() {
	l.historyMu.RLock()
	history := make([]OptimizationOutcome, len(l.history))
	copy(history, l.history)
	l.historyMu.RUnlock()
	
	if len(history) == 0 {
		return
	}
	
	l.patternsMu.Lock()
	defer l.patternsMu.Unlock()
	
	// Reset patterns
	l.patterns.StrategySuccessRates = make(map[OptimizationStrategy]float64)
	l.patterns.NodePoolPatterns = make(map[string]*NodePoolPattern)
	l.patterns.RiskFactors = make(map[string]float64)
	l.patterns.InstanceTypePrefs = make(map[string]float64)
	
	// Calculate strategy success rates
	strategySuccesses := make(map[OptimizationStrategy]int)
	strategyCounts := make(map[OptimizationStrategy]int)
	
	// Calculate NodePool patterns
	nodePoolOutcomes := make(map[string][]OptimizationOutcome)
	
	for _, outcome := range history {
		// Strategy success rate
		strategyCounts[outcome.Strategy]++
		if outcome.Success {
			strategySuccesses[outcome.Strategy]++
		}
		
		// NodePool patterns
		nodePoolOutcomes[outcome.NodePoolName] = append(nodePoolOutcomes[outcome.NodePoolName], outcome)
	}
	
	// Calculate strategy success rates
	for strategy, count := range strategyCounts {
		successes := strategySuccesses[strategy]
		l.patterns.StrategySuccessRates[strategy] = float64(successes) / float64(count)
	}
	
	// Calculate NodePool-specific patterns
	for nodePoolName, outcomes := range nodePoolOutcomes {
		pattern := &NodePoolPattern{
			NodePoolName:    nodePoolName,
			StrategyHistory: make(map[OptimizationStrategy]int),
		}
		
		successes := 0
		totalSavings := 0.0
		allIssues := make(map[string]int)
		
		for _, outcome := range outcomes {
			pattern.StrategyHistory[outcome.Strategy]++
			if outcome.Success {
				successes++
			}
			if outcome.ActualSavings > 0 {
				totalSavings += outcome.ActualSavings
			}
			for _, issue := range outcome.Incidents {
				allIssues[issue]++
			}
		}
		
		pattern.SuccessRate = float64(successes) / float64(len(outcomes))
		if len(outcomes) > 0 {
			pattern.AvgSavings = totalSavings / float64(len(outcomes))
		}
		
		// Find most common issues
		for issue, count := range allIssues {
			if count >= 2 { // At least 2 occurrences
				pattern.CommonIssues = append(pattern.CommonIssues, issue)
			}
		}
		
		// Find best strategy for this NodePool
		bestStrategy := StrategyBalanced
		bestRate := 0.0
		for strategy, count := range pattern.StrategyHistory {
			if count >= 2 { // Need at least 2 attempts
				strategySuccesses := 0
				for _, outcome := range outcomes {
					if outcome.Strategy == strategy && outcome.Success {
						strategySuccesses++
					}
				}
				rate := float64(strategySuccesses) / float64(count)
				if rate > bestRate {
					bestRate = rate
					bestStrategy = strategy
				}
			}
		}
		pattern.BestStrategy = bestStrategy
		
		// Find optimal configuration (most successful)
		bestOutcome := l.findBestOutcome(outcomes)
		if bestOutcome != nil && bestOutcome.Success {
			pattern.OptimalConfig = &OptimalConfiguration{
				InstanceTypes: bestOutcome.ActualInstanceTypes,
				CapacityType:  bestOutcome.ActualCapacityType,
				NodeCount:     bestOutcome.ActualNodes,
				Confidence:    bestOutcome.Accuracy,
			}
		}
		
		l.patterns.NodePoolPatterns[nodePoolName] = pattern
	}
	
	l.patterns.LastUpdated = time.Now()
}

// learnFromOutcome learns from a single outcome
func (l *LearningAgent) learnFromOutcome(outcome OptimizationOutcome) {
	l.patternsMu.Lock()
	defer l.patternsMu.Unlock()
	
	// Update strategy success rate
	currentRate, ok := l.patterns.StrategySuccessRates[outcome.Strategy]
	if !ok {
		currentRate = 0.5
	}
	// Exponential moving average
	alpha := 0.3 // Learning rate
	newRate := currentRate*(1-alpha) + boolToFloat(outcome.Success)*alpha
	l.patterns.StrategySuccessRates[outcome.Strategy] = newRate
	
	// Update NodePool pattern
	pattern, ok := l.patterns.NodePoolPatterns[outcome.NodePoolName]
	if !ok {
		pattern = &NodePoolPattern{
			NodePoolName:    outcome.NodePoolName,
			StrategyHistory: make(map[OptimizationStrategy]int),
		}
		l.patterns.NodePoolPatterns[outcome.NodePoolName] = pattern
	}
	
	pattern.StrategyHistory[outcome.Strategy]++
	
	// Update success rate (exponential moving average)
	pattern.SuccessRate = pattern.SuccessRate*(1-alpha) + boolToFloat(outcome.Success)*alpha
	
	// Update average savings
	if outcome.ActualSavings > 0 {
		if pattern.AvgSavings == 0 {
			pattern.AvgSavings = outcome.ActualSavings
		} else {
			pattern.AvgSavings = pattern.AvgSavings*(1-alpha) + outcome.ActualSavings*alpha
		}
	}
	
	// Update optimal configuration if this is better
	if outcome.Success && (pattern.OptimalConfig == nil || outcome.ActualSavings > pattern.AvgSavings*1.1) {
		pattern.OptimalConfig = &OptimalConfiguration{
			InstanceTypes: outcome.ActualInstanceTypes,
			CapacityType:  outcome.ActualCapacityType,
			NodeCount:     outcome.ActualNodes,
			Confidence:    outcome.Accuracy,
		}
	}
}

// determineSuccess determines if an optimization was successful
func (l *LearningAgent) determineSuccess(outcome OptimizationOutcome) bool {
	// Success criteria:
	// 1. User approved it (or no negative feedback)
	// 2. Achieved positive savings (or close to predicted)
	// 3. No major incidents
	// 4. Performance impact is not negative
	
	// Check user feedback
	success := outcome.UserFeedback != "rejected"
	
	// Check savings (should be positive or close to predicted)
	if outcome.ActualSavings < 0 {
		success = false
	} else if outcome.PredictedSavings > 0 {
		// Actual should be at least 50% of predicted
		if outcome.ActualSavings < outcome.PredictedSavings*0.5 {
			success = false
		}
	}
	
	// Check incidents
	if len(outcome.Incidents) > 0 {
		success = false
	}
	
	// Check performance impact
	if outcome.PerformanceImpact == "negative" {
		success = false
	}
	
	return success
}

// extractLessons extracts key lessons from an outcome
func (l *LearningAgent) extractLessons(outcome OptimizationOutcome) []string {
	var lessons []string
	
	if outcome.Success {
		lessons = append(lessons, fmt.Sprintf("Strategy %s worked well for %s", outcome.Strategy, outcome.NodePoolName))
		if outcome.ActualSavings > outcome.PredictedSavings {
			lessons = append(lessons, "Actual savings exceeded predictions")
		}
	} else {
		lessons = append(lessons, fmt.Sprintf("Strategy %s had issues for %s", outcome.Strategy, outcome.NodePoolName))
		if len(outcome.Incidents) > 0 {
			lessons = append(lessons, fmt.Sprintf("Encountered issues: %v", outcome.Incidents))
		}
		if outcome.ActualSavings < outcome.PredictedSavings*0.5 {
			lessons = append(lessons, "Actual savings were significantly lower than predicted")
		}
	}
	
	if outcome.Accuracy < 0.7 {
		lessons = append(lessons, "Prediction accuracy was low - need better estimation")
	}
	
	return lessons
}

// findBestOutcome finds the best outcome from a list
func (l *LearningAgent) findBestOutcome(outcomes []OptimizationOutcome) *OptimizationOutcome {
	if len(outcomes) == 0 {
		return nil
	}
	
	best := &outcomes[0]
	for i := range outcomes {
		if outcomes[i].Success && outcomes[i].ActualSavings > best.ActualSavings {
			best = &outcomes[i]
		}
	}
	
	return best
}

// loadHistory loads optimization history from file
func (l *LearningAgent) loadHistory() error {
	if l.historyFile == "" {
		return nil // No file specified
	}
	
	data, err := os.ReadFile(l.historyFile)
	if err != nil {
		if os.IsNotExist(err) {
			return nil // File doesn't exist yet, that's OK
		}
		return err
	}
	
	var history []OptimizationOutcome
	if err := json.Unmarshal(data, &history); err != nil {
		return fmt.Errorf("failed to parse history: %w", err)
	}
	
	l.historyMu.Lock()
	l.history = history
	l.historyMu.Unlock()
	
	return nil
}

// saveHistory saves optimization history to file
func (l *LearningAgent) saveHistory() error {
	if l.historyFile == "" {
		return nil // No file specified
	}
	
	l.historyMu.RLock()
	data, err := json.MarshalIndent(l.history, "", "  ")
	l.historyMu.RUnlock()
	
	if err != nil {
		return fmt.Errorf("failed to marshal history: %w", err)
	}
	
	// Ensure directory exists
	dir := filepath.Dir(l.historyFile)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create directory: %w", err)
	}
	
	if err := os.WriteFile(l.historyFile, data, 0644); err != nil {
		return fmt.Errorf("failed to write history: %w", err)
	}
	
	return nil
}

// Helper functions
func abs(x float64) float64 {
	if x < 0 {
		return -x
	}
	return x
}

func max(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}

func boolToFloat(b bool) float64 {
	if b {
		return 1.0
	}
	return 0.0
}

// GetHistory returns the optimization history (public method)
func (l *LearningAgent) GetHistory() []OptimizationOutcome {
	l.historyMu.RLock()
	defer l.historyMu.RUnlock()
	
	history := make([]OptimizationOutcome, len(l.history))
	copy(history, l.history)
	return history
}

// GetHistoryCount returns the number of outcomes in history
func (l *LearningAgent) GetHistoryCount() int {
	l.historyMu.RLock()
	defer l.historyMu.RUnlock()
	return len(l.history)
}

// GetStrategySuccessRates returns all strategy success rates
func (l *LearningAgent) GetStrategySuccessRates() map[OptimizationStrategy]float64 {
	l.patternsMu.RLock()
	defer l.patternsMu.RUnlock()
	
	rates := make(map[OptimizationStrategy]float64)
	for k, v := range l.patterns.StrategySuccessRates {
		rates[k] = v
	}
	return rates
}

// GetNodePoolPatternsCount returns the number of NodePool patterns learned
func (l *LearningAgent) GetNodePoolPatternsCount() int {
	l.patternsMu.RLock()
	defer l.patternsMu.RUnlock()
	return len(l.patterns.NodePoolPatterns)
}

// GetLastUpdated returns when patterns were last updated
func (l *LearningAgent) GetLastUpdated() time.Time {
	l.patternsMu.RLock()
	defer l.patternsMu.RUnlock()
	return l.patterns.LastUpdated
}

