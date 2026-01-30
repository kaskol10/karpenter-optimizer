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

	// Admission webhook errors
	if strings.Contains(errorLower, "admission webhook") || strings.Contains(errorLower, "denied the request") {
		webhookName := ""
		if strings.Contains(errorMsg, "admission webhook") {
			parts := strings.Split(errorMsg, "admission webhook")
			if len(parts) > 1 {
				webhookPart := strings.TrimSpace(parts[1])
				if strings.Contains(webhookPart, "denied") {
					webhookName = strings.Split(webhookPart, "denied")[0]
					webhookName = strings.Trim(webhookName, `"`)
				}
			}
		}
		return "Admission Webhook",
			fmt.Sprintf("An admission webhook (%s) denied the request. This is typically a policy enforcement (e.g., Strimzi drain cleaner, Pod Security Standards). Check webhook configuration and pod spec compliance.", webhookName),
			"critical"
	}

	// Reconciler errors
	if strings.Contains(errorLower, "reconciler error") {
		return "Reconciler Error",
			"A controller reconciler encountered an error. This could be due to resource conflicts, webhook denials, or controller logic issues. Check the specific error message and controller logs.",
			"critical"
	}

	// Eviction errors
	if strings.Contains(errorLower, "eviction") || strings.Contains(errorLower, "drain") {
		return "Eviction/Drain Error",
			"Pod eviction or node draining failed. This could be due to PodDisruptionBudgets, admission webhooks, or other protection mechanisms preventing the operation.",
			"warning"
	}

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

	// Build summary - handle cases where pod/namespace might be missing
	// First, determine the error type from the message or error causes
	errorType := "scheduling"
	if parsedError.Message != "" {
		msgLower := strings.ToLower(parsedError.Message)
		if strings.Contains(msgLower, "reconciler") {
			errorType = "reconciler"
		} else if strings.Contains(msgLower, "eviction") || strings.Contains(msgLower, "drain") {
			errorType = "eviction"
		} else if strings.Contains(msgLower, "admission") || strings.Contains(msgLower, "webhook") {
			errorType = "admission webhook"
		}
	}

	// Check error causes for additional context
	if len(parsedError.ErrorCauses) > 0 {
		for _, cause := range parsedError.ErrorCauses {
			causeLower := strings.ToLower(cause.Error)
			if strings.Contains(causeLower, "admission webhook") || strings.Contains(causeLower, "denied") {
				errorType = "admission webhook"
				break
			} else if strings.Contains(causeLower, "reconciler") {
				errorType = "reconciler"
				break
			} else if strings.Contains(causeLower, "eviction") || strings.Contains(causeLower, "drain") {
				errorType = "eviction"
				break
			}
		}
	}

	var summary string
	if parsedError.Name != "" && parsedError.Namespace != "" {
		// Use name/namespace from the error itself (not Pod.Name/Pod.Namespace)
		if errorType == "reconciler" {
			summary = fmt.Sprintf("Reconciler error for '%s' in namespace '%s'", parsedError.Name, parsedError.Namespace)
		} else if errorType == "admission webhook" {
			summary = fmt.Sprintf("Admission webhook denied request for '%s' in namespace '%s'", parsedError.Name, parsedError.Namespace)
		} else if errorType == "eviction" {
			summary = fmt.Sprintf("Eviction error for '%s' in namespace '%s'", parsedError.Name, parsedError.Namespace)
		} else if parsedError.Pod.Name != "" && parsedError.Pod.Namespace != "" {
			if parsedError.NodePool.Name != "" {
				summary = fmt.Sprintf("Pod '%s' in namespace '%s' could not be scheduled by NodePool '%s'",
					parsedError.Pod.Name, parsedError.Pod.Namespace, parsedError.NodePool.Name)
			} else {
				summary = fmt.Sprintf("Pod '%s' in namespace '%s' could not be scheduled",
					parsedError.Pod.Name, parsedError.Pod.Namespace)
			}
		} else {
			summary = fmt.Sprintf("Karpenter %s error for '%s' in namespace '%s'", errorType, parsedError.Name, parsedError.Namespace)
		}
	} else if parsedError.Pod.Name != "" && parsedError.Pod.Namespace != "" {
		if parsedError.NodePool.Name != "" {
			summary = fmt.Sprintf("Pod '%s' in namespace '%s' could not be scheduled by NodePool '%s'",
				parsedError.Pod.Name, parsedError.Pod.Namespace, parsedError.NodePool.Name)
		} else {
			summary = fmt.Sprintf("Pod '%s' in namespace '%s' could not be scheduled",
				parsedError.Pod.Name, parsedError.Pod.Namespace)
		}
	} else if parsedError.NodePool.Name != "" {
		summary = fmt.Sprintf("Karpenter %s error for NodePool '%s'", errorType, parsedError.NodePool.Name)
	} else if parsedError.Message != "" {
		summary = fmt.Sprintf("Karpenter %s error: %s", errorType, parsedError.Message)
	} else {
		summary = fmt.Sprintf("Karpenter %s error detected", errorType)
	}

	// Analyze error causes - include main error field if errorCauses is empty
	errorCauses := make([]ErrorCauseDetail, 0)
	seenErrors := make(map[string]bool)

	// First, analyze the main error field if it's not already in errorCauses
	// This is important for reconciler errors where the main error contains the actual issue
	if parsedError.Error != "" {
		// Check if this error is already in errorCauses
		foundInCauses := false
		for _, cause := range parsedError.ErrorCauses {
			if cause.Error == parsedError.Error {
				foundInCauses = true
				break
			}
		}
		// If not found in errorCauses, analyze it (especially important when errorCauses is empty)
		if !foundInCauses {
			category, explanation, severity := categorizeErrorCause(parsedError.Error)
			errorCauses = append(errorCauses, ErrorCauseDetail{
				Error:       parsedError.Error,
				Category:    category,
				Explanation: explanation,
				Severity:    severity,
			})
			seenErrors[parsedError.Error] = true
		}
	}

	// Then analyze errorCauses
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
		return "", fmt.Errorf("ollama client not available")
	}

	ollamaClient := s.recommender.GetOllamaClient()
	if ollamaClient == nil {
		return "", fmt.Errorf("ollama client not available")
	}

	// Build prompt with available information
	causesText := ""
	for i, cause := range errorCauses {
		causesText += fmt.Sprintf("%d. [%s] %s\n   Explanation: %s\n",
			i+1, cause.Severity, cause.Error, cause.Explanation)
	}

	// Build context information dynamically based on what's available
	contextParts := []string{}

	// Use name/namespace from the error itself first (for reconciler errors, eviction errors, etc.)
	if parsedError.Name != "" && parsedError.Namespace != "" {
		contextParts = append(contextParts, fmt.Sprintf("- Resource Name: %s", parsedError.Name))
		contextParts = append(contextParts, fmt.Sprintf("- Resource Namespace: %s", parsedError.Namespace))
	} else if parsedError.Pod.Name != "" && parsedError.Pod.Namespace != "" {
		contextParts = append(contextParts, fmt.Sprintf("- Pod Name: %s", parsedError.Pod.Name))
		contextParts = append(contextParts, fmt.Sprintf("- Pod Namespace: %s", parsedError.Pod.Namespace))
	} else if parsedError.Pod.Name != "" {
		contextParts = append(contextParts, fmt.Sprintf("- Pod Name: %s", parsedError.Pod.Name))
	} else if parsedError.Pod.Namespace != "" {
		contextParts = append(contextParts, fmt.Sprintf("- Pod Namespace: %s", parsedError.Pod.Namespace))
	}

	if parsedError.NodePool.Name != "" {
		contextParts = append(contextParts, fmt.Sprintf("- NodePool: %s", parsedError.NodePool.Name))
	}

	if parsedError.Message != "" {
		contextParts = append(contextParts, fmt.Sprintf("- Error Message: %s", parsedError.Message))
	}

	if parsedError.Controller != "" {
		contextParts = append(contextParts, fmt.Sprintf("- Controller: %s", parsedError.Controller))
	}

	if len(parsedError.Taints) > 0 {
		taintsText := strings.Join(parsedError.Taints, ", ")
		contextParts = append(contextParts, fmt.Sprintf("- Taints: %s", taintsText))
	}

	// Add the main error field (critical for reconciler errors where the actual error is here)
	if parsedError.Error != "" {
		contextParts = append(contextParts, fmt.Sprintf("- Error: %s", parsedError.Error))
	}

	contextInfo := strings.Join(contextParts, "\n")
	if contextInfo == "" {
		contextInfo = "No specific pod, namespace, or NodePool information available in the log."
	}

	// Determine error type for better prompt context
	errorType := "scheduling"
	if parsedError.Message != "" {
		msgLower := strings.ToLower(parsedError.Message)
		if strings.Contains(msgLower, "reconciler") {
			errorType = "reconciler"
		} else if strings.Contains(msgLower, "eviction") || strings.Contains(msgLower, "drain") {
			errorType = "eviction"
		} else if strings.Contains(msgLower, "admission") || strings.Contains(msgLower, "webhook") {
			errorType = "admission webhook"
		}
	}

	// Check error causes for error type hints
	if len(errorCauses) > 0 {
		for _, cause := range errorCauses {
			causeLower := strings.ToLower(cause.Error)
			if strings.Contains(causeLower, "admission webhook") || strings.Contains(causeLower, "denied") {
				errorType = "admission webhook"
				break
			} else if strings.Contains(causeLower, "reconciler") {
				errorType = "reconciler"
				break
			} else if strings.Contains(causeLower, "eviction") || strings.Contains(causeLower, "drain") {
				errorType = "eviction"
				break
			}
		}
	}

	prompt := fmt.Sprintf(`You are a Kubernetes and Karpenter expert. Analyze this Karpenter error and provide a clear, actionable explanation.

Error Type: %s

Available Context:
%s

Error Causes:
%s

Provide a concise explanation (2-3 sentences) that:
1. Identifies what type of error this is (%s error) and what it means
2. Explains the root cause based on the error message and error causes
3. Suggests specific, actionable steps to resolve the problem

Be specific and technical, but clear. Focus on the most critical issues first. 
- For reconciler errors: The "Error" field contains the actual failure reason (often an admission webhook denial). Explain what the controller (shown in "Controller" field) was trying to do, identify the specific webhook or issue that blocked it, and why. For example, if it's a Strimzi drain cleaner webhook, explain that it's preventing pod eviction because the Strimzi operator will handle rolling the pod.
- For admission webhook errors: Identify which webhook denied the request (extract from the error message), explain why it denied (e.g., Strimzi drain cleaner prevents manual eviction, Pod Security Standards violation), and what action is needed.
- For eviction errors: Explain what prevented the eviction (PodDisruptionBudgets, admission webhooks, etc.) and how to resolve it.
- For scheduling errors: Focus on resource constraints, taints, labels, or NodePool limits.

IMPORTANT: For reconciler errors, the "Error" field is the key - it contains the actual failure (often an admission webhook denial). Always analyze this field even if error causes are empty.

If pod/namespace information is missing, analyze the error message, error field, and error causes to provide useful guidance.`,
		errorType,
		contextInfo,
		causesText,
		errorType,
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
