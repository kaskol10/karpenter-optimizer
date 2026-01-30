package api

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// KarpenterLogError represents a parsed Karpenter error log
type KarpenterLogError struct {
	Level      string    `json:"level"`
	Time       time.Time `json:"time"`
	Logger     string    `json:"logger"`
	Message    string    `json:"message"`
	Controller string    `json:"controller"`
	Namespace  string    `json:"namespace"`
	Name       string    `json:"name"`
	Pod        struct {
		Name      string `json:"name"`
		Namespace string `json:"namespace"`
	} `json:"Pod"`
	NodePool struct {
		Name string `json:"name"`
	} `json:"NodePool"`
	Taints      []string              `json:"taints"`
	Error       string                `json:"error"`
	ErrorCauses []KarpenterErrorCause `json:"errorCauses"`
}

// KarpenterErrorCause represents an individual error cause
type KarpenterErrorCause struct {
	Error string `json:"error"`
}

// LogAnalysisRequest represents the request to analyze a log
type LogAnalysisRequest struct {
	Log string `json:"log" binding:"required"`
}

// LogAnalysisResponse represents the analysis result
type LogAnalysisResponse struct {
	ParsedError     *KarpenterLogError `json:"parsedError,omitempty"`
	Summary         string             `json:"summary"`
	Explanation     string             `json:"explanation"`
	ErrorCauses     []ErrorCauseDetail `json:"errorCauses"`
	Recommendations []string           `json:"recommendations"`
	Error           string             `json:"error,omitempty"`
}

// ErrorCauseDetail provides detailed information about each error cause
type ErrorCauseDetail struct {
	Error       string `json:"error"`
	Category    string `json:"category"`
	Explanation string `json:"explanation"`
	Severity    string `json:"severity"` // "critical", "warning", "info"
}

// parseKarpenterLog parses a JSON Karpenter error log
func parseKarpenterLog(logStr string) (*KarpenterLogError, error) {
	var logError KarpenterLogError

	// Try to parse as JSON
	if err := json.Unmarshal([]byte(logStr), &logError); err != nil {
		return nil, fmt.Errorf("failed to parse log as JSON: %w", err)
	}

	return &logError, nil
}

// categorizeErrorCause categorizes an error cause and provides basic explanation
func categorizeErrorCause(errorMsg string) (category, explanation, severity string) {
	errorLower := strings.ToLower(errorMsg)

	// Label/typo errors
	if strings.Contains(errorLower, "does not have known values") || strings.Contains(errorLower, "typo") {
		return "Label Error",
			"This indicates a label typo or unknown label value. Check if you meant 'karpenter.sh/capacity-type' or 'karpenter.k8s.aws/capacity-reservation-type'.",
			"critical"
	}

	// Taint tolerance errors
	if strings.Contains(errorLower, "did not tolerate taint") {
		// Extract taint name
		taintMatch := ""
		if strings.Contains(errorMsg, "taint=") {
			parts := strings.Split(errorMsg, "taint=")
			if len(parts) > 1 {
				taintMatch = strings.TrimSpace(strings.Split(parts[1], ";")[0])
			}
		}
		return "Taint Tolerance",
			fmt.Sprintf("The pod cannot tolerate the taint '%s'. Add a matching toleration to the pod spec or remove the taint from the NodePool.", taintMatch),
			"critical"
	}

	// Instance type limits
	if strings.Contains(errorLower, "exceed limits for nodepool") {
		return "NodePool Limits",
			"The NodePool has resource limits (CPU, memory, or instance type constraints) that prevent scheduling. Check NodePool spec limits and pod resource requests.",
			"critical"
	}

	// Resource constraints
	if strings.Contains(errorLower, "insufficient") || strings.Contains(errorLower, "not enough") {
		return "Resource Constraint",
			"Insufficient resources available in the cluster. Consider adding nodes or adjusting pod resource requests.",
			"warning"
	}

	// Default
	return "Unknown",
		"Unable to categorize this error. Review the error message for details.",
		"info"
}

// analyzeKarpenterLogInternal analyzes a Karpenter error log and provides explanations
func (s *Server) analyzeKarpenterLogInternal(ctx context.Context, logStr string) (*LogAnalysisResponse, error) {
	// Parse the log
	parsedError, err := parseKarpenterLog(logStr)
	if err != nil {
		return &LogAnalysisResponse{
			Error: fmt.Sprintf("Failed to parse log: %v", err),
		}, nil
	}

	// Build summary
	summary := fmt.Sprintf("Pod '%s' in namespace '%s' could not be scheduled by NodePool '%s'",
		parsedError.Pod.Name, parsedError.Pod.Namespace, parsedError.NodePool.Name)

	// Analyze error causes
	errorCauses := make([]ErrorCauseDetail, 0, len(parsedError.ErrorCauses))
	seenErrors := make(map[string]bool)

	for _, cause := range parsedError.ErrorCauses {
		// Deduplicate similar errors
		if seenErrors[cause.Error] {
			continue
		}
		seenErrors[cause.Error] = true

		category, explanation, severity := categorizeErrorCause(cause.Error)
		errorCauses = append(errorCauses, ErrorCauseDetail{
			Error:       cause.Error,
			Category:    category,
			Explanation: explanation,
			Severity:    severity,
		})
	}

	// Generate recommendations
	recommendations := s.generateLogRecommendations(parsedError, errorCauses)

	// Generate AI explanation if Ollama is available
	explanation := ""
	if s.recommender != nil && s.recommender.HasOllama() {
		aiExplanation, err := s.generateAIExplanation(ctx, parsedError, errorCauses)
		if err == nil && aiExplanation != "" {
			explanation = aiExplanation
		}
	}

	// If no AI explanation, provide a basic one
	if explanation == "" {
		explanation = s.generateBasicExplanation(parsedError, errorCauses)
	}

	return &LogAnalysisResponse{
		ParsedError:     parsedError,
		Summary:         summary,
		Explanation:     explanation,
		ErrorCauses:     errorCauses,
		Recommendations: recommendations,
	}, nil
}

// generateBasicExplanation creates a basic explanation without AI
func (s *Server) generateBasicExplanation(parsedError *KarpenterLogError, errorCauses []ErrorCauseDetail) string {
	var parts []string

	parts = append(parts, fmt.Sprintf("The pod '%s' in namespace '%s' cannot be scheduled by NodePool '%s'.",
		parsedError.Pod.Name, parsedError.Pod.Namespace, parsedError.NodePool.Name))

	if len(errorCauses) > 0 {
		parts = append(parts, "Main issues:")
		for i, cause := range errorCauses {
			if i >= 3 { // Limit to top 3
				break
			}
			parts = append(parts, fmt.Sprintf("- %s: %s", cause.Category, cause.Explanation))
		}
	}

	return strings.Join(parts, "\n")
}

// generateAIExplanation uses Ollama to generate an intelligent explanation
func (s *Server) generateAIExplanation(ctx context.Context, parsedError *KarpenterLogError, errorCauses []ErrorCauseDetail) (string, error) {
	if s.recommender == nil || !s.recommender.HasOllama() {
		return "", fmt.Errorf("Ollama client not available")
	}

	ollamaClient := s.recommender.GetOllamaClient()
	if ollamaClient == nil {
		return "", fmt.Errorf("Ollama client not available")
	}

	// Build prompt
	causesText := ""
	for i, cause := range errorCauses {
		causesText += fmt.Sprintf("%d. [%s] %s\n   Explanation: %s\n",
			i+1, cause.Severity, cause.Error, cause.Explanation)
	}

	taintsText := ""
	if len(parsedError.Taints) > 0 {
		taintsText = strings.Join(parsedError.Taints, ", ")
	}

	prompt := fmt.Sprintf(`You are a Kubernetes and Karpenter expert. Analyze this Karpenter scheduling error and provide a clear, actionable explanation.

Pod Details:
- Name: %s
- Namespace: %s
- NodePool: %s

Taints on NodePool:
%s

Error Causes:
%s

Provide a concise explanation (2-3 sentences) that:
1. Summarizes why the pod cannot be scheduled
2. Identifies the primary issue(s)
3. Suggests actionable steps to resolve the problem

Be specific and technical, but clear. Focus on the most critical issues first.`,
		parsedError.Pod.Name,
		parsedError.Pod.Namespace,
		parsedError.NodePool.Name,
		taintsText,
		causesText,
	)

	// Use timeout for AI request
	aiCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	response, err := ollamaClient.Chat(aiCtx, prompt)
	if err != nil {
		return "", fmt.Errorf("AI explanation failed: %w", err)
	}

	return strings.TrimSpace(response), nil
}

// generateLogRecommendations generates actionable recommendations for log analysis
func (s *Server) generateLogRecommendations(parsedError *KarpenterLogError, errorCauses []ErrorCauseDetail) []string {
	recommendations := []string{}

	for _, cause := range errorCauses {
		switch cause.Category {
		case "Label Error":
			recommendations = append(recommendations,
				"Check pod labels for typos. Common labels: 'karpenter.sh/capacity-type' (spot/on-demand), 'karpenter.k8s.aws/capacity-reservation-type'")
		case "Taint Tolerance":
			recommendations = append(recommendations,
				"Add matching tolerations to the pod spec, or remove the taint from the NodePool if not needed")
		case "NodePool Limits":
			recommendations = append(recommendations,
				"Review NodePool resource limits and pod resource requests. Ensure pod requests fit within NodePool constraints")
		case "Resource Constraint":
			recommendations = append(recommendations,
				"Consider scaling the cluster or adjusting pod resource requests to match available capacity")
		}
	}

	// Remove duplicates
	unique := make(map[string]bool)
	result := []string{}
	for _, rec := range recommendations {
		if !unique[rec] {
			unique[rec] = true
			result = append(result, rec)
		}
	}

	return result
}
