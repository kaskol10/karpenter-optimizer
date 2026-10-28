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
	if s.recommender != nil && s.recommender.HasLLM() {
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
	if s.recommender == nil || !s.recommender.HasLLM() {
		return "", fmt.Errorf("ollama client not available")
	}

	llmClient := s.recommender.GetLLMClient()
	if llmClient == nil {
		return "", fmt.Errorf("LLM client not available")
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

	response, err := llmClient.Chat(aiCtx, prompt)
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

// genericLogPattern is a built-in heuristic for classifying container log
// lines when no LLM is configured. Order matters: the first match wins, and
// specific patterns (OOM, image pull) come before generic "error".
type genericLogPattern struct {
	name     string
	category string
	severity string
	// match is applied to the lowercased line.
	match func(lineLower string) bool
	// explanation is the user-facing text; %s is not used — keep it static
	// so multiple lines in the same category dedupe cleanly.
	explanation string
	recs        []string
}

func genericLogPatterns() []genericLogPattern {
	contains := func(substrs ...string) func(string) bool {
		return func(lineLower string) bool {
			for _, s := range substrs {
				if strings.Contains(lineLower, s) {
					return true
				}
			}
			return false
		}
	}
	return []genericLogPattern{
		{
			name:        "OOMKilled",
			category:    "Out of memory",
			severity:    "critical",
			match:       contains("oomkilled", "oom_kill", "out of memory", "memory cgroup out of memory"),
			explanation: "A container was killed by the OOM killer: it exceeded its memory limit (or the node ran out of memory). The pod will typically restart in a loop until the memory request/limit is fixed.",
			recs: []string{
				"Raise the container memory limit, or reduce the workload's memory footprint (heap size, batch size, cache).",
				"kubectl describe pod <pod> shows the OOMKilled reason and the limit that was hit.",
			},
		},
		{
			name:        "ImagePull",
			category:    "Image pull failure",
			severity:    "critical",
			match:       contains("imagepullbackoff", "errimagepull", "pullaccessdenied", "notfound", "pull secret"),
			explanation: "The kubelet could not pull the container image: wrong tag/repository, private registry without a pull secret, or an unreachable registry.",
			recs: []string{
				"Verify the image name and tag exist in the registry.",
				"For private registries, check the serviceAccountName's imagePullSecrets and the node's network path to the registry.",
			},
		},
		{
			name:        "CrashLoop",
			category:    "Crash loop",
			severity:    "critical",
			match:       contains("crashloopbackoff", "back-off restarting failed container", "container exited with code"),
			explanation: "The container keeps exiting and being restarted by kubelet. The exit code in this message (or in the previous container's logs) points at the failure — use the 'previous' log toggle to see why it exited.",
			recs: []string{
				"Check the exit code: 137 is usually OOMKilled, 127 a missing command, 1 an application error.",
				"Fetch the previous container's logs to see the exit-time error.",
			},
		},
		{
			name:        "Permission",
			category:    "Permission / admission",
			severity:    "warning",
			match:       contains("permission denied", "operation not permitted", "access denied", "forbidden", "unauthorized", "admission webhook", "denied the request"),
			explanation: "The process or an admission webhook was denied access: missing RBAC/SA permissions, a read-only filesystem where a write was attempted, or a policy webhook rejecting the object.",
			recs: []string{
				"Check RBAC (ClusterRole/Role bindings) or the SA token for the API calls being made.",
				"For webhooks, identify the denying webhook in the message and check its config.",
			},
		},
		{
			name:        "Connection",
			category:    "Network / dependency",
			severity:    "warning",
			match:       contains("connection refused", "connection reset", "no route to host", "i/o timeout", "context deadline exceeded", "dial tcp", "dns", "no such host"),
			explanation: "The process failed to reach a network dependency: the target is down, a Service/endpoint is missing, DNS cannot resolve the name, or a firewall is blocking the path.",
			recs: []string{
				"Verify the dependency's Service and endpoints exist in the same cluster (or the remote network is reachable).",
				"Check NetworkPolicy rules between this pod's namespace and the target.",
			},
		},
		{
			name:        "DiskPressure",
			category:    "Disk pressure",
			severity:    "warning",
			match:       contains("no space left on device", "evicted", "nodefs", "imagefs", "disk pressure"),
			explanation: "The node or container hit a disk limit: ephemeral storage, container images, or logs filled the volume and the kubelet may evict pods.",
			recs: []string{
				"Check node disk usage (kubectl describe node) and PVC/ephemeral storage requests.",
				"Rotate or limit log volume; raise ephemeral-storage requests if the workload writes large temp data.",
			},
		},
		{
			name:        "PanicFatal",
			category:    "Application crash",
			severity:    "critical",
			match:       contains("panic:", "fatal error", "segmentation fault", "core dumped", "uncaught exception"),
			explanation: "The application crashed (panic, segfault, fatal error). The stack trace above this line is the real payload — analyze the frames, not this marker.",
			recs: []string{
				"Read the stack trace / top of the crash for the failing function.",
				"Check for nil dereferences, missing config, or incompatible data in the crashing container's language/runtime logs.",
			},
		},
		{
			name:        "Error",
			category:    "Error",
			severity:    "warning",
			match:       contains(`"level":"error"`, `level=error`, "error:", "error=", "[error]", " err ", "exception"),
			explanation: "A generic error-level log line. The message content identifies the subsystem; pair it with the surrounding context lines for root cause.",
			recs: []string{
				"Look at the lines around the error for the failing operation and its input (request id, object name).",
			},
		},
	}
}

// genericLogLine is one matched log line with its classification.
type genericLogLine struct {
	Line        string
	Category    string
	Severity    string
	Explanation string
}

// classifyGenericLogs scans a block of container log lines and returns the
// matched (line, category) pairs, capped to keep the analysis payload small.
func classifyGenericLogs(logText string) []genericLogLine {
	patterns := genericLogPatterns()
	seen := make(map[string]bool) // dedupe by category
	var out []genericLogLine
	for _, raw := range strings.Split(logText, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		lineLower := strings.ToLower(line)
		for _, p := range patterns {
			if p.match(lineLower) {
				out = append(out, genericLogLine{
					Line:        line,
					Category:    p.category,
					Severity:    p.severity,
					Explanation: p.explanation,
				})
				seen[p.category] = true
				break // first (most specific) match wins per line
			}
		}
		if len(out) >= 25 {
			break
		}
	}
	// Drop duplicate categories: keep the first occurrence of each.
	unique := make(map[string]bool)
	result := out[:0]
	for _, l := range out {
		if unique[l.Category] {
			continue
		}
		unique[l.Category] = true
		result = append(result, l)
	}
	return result
}

// analyzeGenericLog analyzes a block of (non-Karpenter-JSON) container logs.
// With an LLM configured it asks the LLM for an explanation of the matched
// error lines; without one it relies purely on the built-in heuristics.
func (s *Server) analyzeGenericLog(ctx context.Context, logText string) (*LogAnalysisResponse, error) {
	matches := classifyGenericLogs(logText)

	errorCauses := make([]ErrorCauseDetail, 0, len(matches))
	for _, m := range matches {
		// Keep the error text short for display.
		display := m.Line
		if len(display) > 300 {
			display = display[:300] + "..."
		}
		errorCauses = append(errorCauses, ErrorCauseDetail{
			Error:       display,
			Category:    m.Category,
			Explanation: m.Explanation,
			Severity:    m.Severity,
		})
	}

	// Recommendations: union of the matched categories' recs, deduped.
	recSet := make(map[string]bool)
	var recommendations []string
	for _, p := range genericLogPatterns() {
		matched := false
		for _, m := range matches {
			if m.Category == p.category {
				matched = true
				break
			}
		}
		if !matched {
			continue
		}
		for _, r := range p.recs {
			if !recSet[r] {
				recSet[r] = true
				recommendations = append(recommendations, r)
			}
		}
	}

	summary := fmt.Sprintf("%d line(s) analyzed, %d error pattern(s) matched", countLines(logText), len(matches))
	if len(matches) == 0 {
		summary = fmt.Sprintf("%d line(s) analyzed, no known error patterns matched", countLines(logText))
	}

	explanation := ""
	if s.recommender != nil && s.recommender.HasLLM() {
		explanation, _ = s.generateGenericAIExplanation(ctx, logText, matches)
	}
	if explanation == "" {
		explanation = s.generateGenericBasicExplanation(matches, logText)
	}

	return &LogAnalysisResponse{
		Summary:         summary,
		Explanation:     explanation,
		ErrorCauses:     errorCauses,
		Recommendations: recommendations,
	}, nil
}

// countLines counts non-empty lines in a log block.
func countLines(text string) int {
	n := 0
	for _, l := range strings.Split(text, "\n") {
		if strings.TrimSpace(l) != "" {
			n++
		}
	}
	return n
}

// generateGenericBasicExplanation builds a heuristic-only explanation.
func (s *Server) generateGenericBasicExplanation(matches []genericLogLine, logText string) string {
	if len(matches) == 0 {
		return "No known error patterns were detected in the selected log lines. If the workload is misbehaving, try widening the tail window, enabling 'previous' for terminated containers, or selecting the container that owns the failing workload."
	}
	var parts []string
	parts = append(parts, "Built-in analysis (no LLM configured). Matched patterns:")
	for i, m := range matches {
		if i >= 5 {
			parts = append(parts, "- ... (truncated)")
			break
		}
		parts = append(parts, fmt.Sprintf("- [%s] %s: %s", m.Severity, m.Category, m.Explanation))
	}
	return strings.Join(parts, "\n")
}

// generateGenericAIExplanation asks the LLM to explain the matched log
// context. The log is truncated to keep the prompt bounded.
func (s *Server) generateGenericAIExplanation(ctx context.Context, logText string, matches []genericLogLine) (string, error) {
	if s.recommender == nil || !s.recommender.HasLLM() {
		return "", fmt.Errorf("llm client not available")
	}
	llmClient := s.recommender.GetLLMClient()
	if llmClient == nil {
		return "", fmt.Errorf("LLM client not available")
	}

	trimmed := logText
	const maxLogChars = 12000
	if len(trimmed) > maxLogChars {
		trimmed = trimmed[:maxLogChars] + "\n... (truncated)"
	}

	heuristicLines := ""
	for i, m := range matches {
		if i >= 10 {
			break
		}
		heuristicLines += fmt.Sprintf("- [%s/%s] %s\n", m.Severity, m.Category, m.Line[:minInt(200, len(m.Line))])
	}

	prompt := fmt.Sprintf(`You are a Kubernetes operations expert. Below is a block of container log lines from a pod in the cluster, followed by the error patterns a heuristic classifier detected in them.

Log excerpt:
%s

Detected patterns:
%s

Provide a concise explanation (3-5 sentences) that:
1. Names the most likely root cause given the log content
2. Explains why it happens and its impact
3. Gives 1-3 concrete next actions a platform engineer should take

Be specific and technical. Do not invent details not present in the logs; if the excerpt is ambiguous, say so and what to fetch next (e.g. previous container logs, node events).`, trimmed, heuristicLines)

	aiCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	response, err := llmClient.Chat(aiCtx, prompt)
	if err != nil {
		return "", fmt.Errorf("ai explanation failed: %w", err)
	}
	return strings.TrimSpace(response), nil
}

// minInt returns the smaller of a and b.
func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
