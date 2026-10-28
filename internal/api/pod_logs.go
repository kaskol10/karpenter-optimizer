package api

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/karpenter-optimizer/internal/kubernetes"
)

// listPods handles GET /api/v1/pods
// @Summary      List pods (generic log-explorer picker)
// @Description  Lists cluster pods as compact summaries (status, readiness, containers, restarts). Use to pick a pod for GET /pods/logs. Not Karpenter-specific: any pod in the cluster is listed, but only authorized API callers can use this endpoint (same auth as the rest of /api/v1).
// @Tags         pods
// @Produce      json
// @Param        namespace  query     string  false  "Restrict to one namespace"
// @Success      200        {object}  map[string]interface{}
// @Failure      503        {object}  map[string]string
// @Failure      500        {object}  map[string]string
// @Router       /pods [get]
func (s *Server) listPods(c *gin.Context) {
	if s.k8sClient == nil {
		c.JSON(503, gin.H{"error": "Kubernetes client not configured"})
		return
	}

	namespace := c.Query("namespace")
	ctx, cancel := context.WithTimeout(c.Request.Context(), 60*time.Second)
	defer cancel()

	pods, err := s.k8sClient.ListPods(ctx, namespace)
	if err != nil {
		c.JSON(500, gin.H{"error": fmt.Sprintf("Failed to list pods: %v", err)})
		return
	}

	c.JSON(200, gin.H{
		"pods":  pods,
		"count": len(pods),
	})
}

// getPodLogs handles GET /api/v1/pods/logs
// @Summary      Get logs from any pod
// @Description  Gets container logs from any pod in the cluster. This is the generic counterpart of GET /karpenter/logs (which is restricted to Karpenter pods). Access is controlled by the same API authentication as the rest of the API.
// @Tags         pods
// @Produce      json
// @Param        namespace    query     string  true   "Pod namespace"
// @Param        pod         query     string  true   "Pod name"
// @Param        container   query     string  false  "Container name (default: first container)"
// @Param        tailLines   query     int     false  "Number of lines to tail" default(500)
// @Param        sinceSeconds query    int     false  "Only logs from the last N seconds"
// @Param        previous    query     bool    false  "Logs from the previous terminated container"
// @Success      200         {object}  map[string]interface{}
// @Failure      400         {object}  map[string]string
// @Failure      404         {object}  map[string]string
// @Failure      503         {object}  map[string]string
// @Failure      500         {object}  map[string]string
// @Router       /pods/logs [get]
func (s *Server) getPodLogs(c *gin.Context) {
	if s.k8sClient == nil {
		c.JSON(503, gin.H{"error": "Kubernetes client not configured"})
		return
	}

	namespace := c.Query("namespace")
	podName := c.Query("pod")
	if namespace == "" || podName == "" {
		c.JSON(400, gin.H{"error": "namespace and pod query parameters are required"})
		return
	}
	container := c.Query("container")

	var tailLines *int64
	if tailStr := c.Query("tailLines"); tailStr != "" {
		tail, err := strconv.ParseInt(tailStr, 10, 64)
		if err != nil || tail < 0 {
			c.JSON(400, gin.H{"error": "tailLines must be a non-negative integer"})
			return
		}
		tailLines = &tail
	} else {
		defaultTail := int64(500)
		tailLines = &defaultTail
	}

	var sinceSeconds *int64
	if sinceStr := c.Query("sinceSeconds"); sinceStr != "" {
		since, err := strconv.ParseInt(sinceStr, 10, 64)
		if err != nil || since < 0 {
			c.JSON(400, gin.H{"error": "sinceSeconds must be a non-negative integer"})
			return
		}
		sinceSeconds = &since
	}

	previous := c.Query("previous") == "true"

	ctx, cancel := context.WithTimeout(c.Request.Context(), 60*time.Second)
	defer cancel()

	logs, err := s.k8sClient.GetPodLogs(ctx, namespace, podName, container, tailLines, sinceSeconds, previous)
	if err != nil {
		// A not-found pod is a client error (stale picker selection), not a
		// server fault.
		if kubernetes.IsNotFound(err) {
			c.JSON(404, gin.H{"error": fmt.Sprintf("pod %s/%s not found", namespace, podName)})
			return
		}
		if isContainerNotFound(err) {
			c.JSON(400, gin.H{"error": err.Error()})
			return
		}
		c.JSON(500, gin.H{"error": fmt.Sprintf("Failed to get pod logs: %v", err)})
		return
	}

	c.JSON(200, gin.H{
		"logs":      logs,
		"count":     len(logs),
		"pod":       podName,
		"namespace": namespace,
	})
}

// isContainerNotFound reports whether the log fetch failed because the
// requested container does not exist on the pod (a validation error, not a
// server fault).
func isContainerNotFound(err error) bool {
	return err != nil && strings.Contains(err.Error(), "not found on pod")
}

// analyzeLog handles POST /api/v1/logs/analyze
// @Summary      Analyze log text (Karpenter JSON or generic)
// @Description  Analyzes a Karpenter JSON error log line, or (when the body is not Karpenter JSON) a block of generic container logs. When an LLM is configured, it is used for the generic path; otherwise a built-in heuristic classifier applies.
// @Tags         logs
// @Accept       json
// @Produce      json
// @Param        body  body      LogAnalysisRequest  true  "Log content (a Karpenter JSON line, or a block of plain logs)"
// @Success      200   {object}  LogAnalysisResponse
// @Failure      400   {object}  map[string]string
// @Failure      500   {object}  map[string]string
// @Router       /logs/analyze [post]
func (s *Server) analyzeLog(c *gin.Context) {
	var req LogAnalysisRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": fmt.Sprintf("Invalid request: %v", err)})
		return
	}
	req.Log = strings.TrimSpace(req.Log)
	if req.Log == "" {
		c.JSON(400, gin.H{"error": "log must not be empty"})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 60*time.Second)
	defer cancel()

	// Try the Karpenter JSON path first; fall back to the generic analyzer
	// when the body is not a Karpenter JSON log line.
	if isKarpenterJSONLog(req.Log) {
		analysis, err := s.analyzeKarpenterLogInternal(ctx, req.Log)
		if err != nil {
			c.JSON(500, gin.H{"error": fmt.Sprintf("Failed to analyze log: %v", err)})
			return
		}
		c.JSON(200, analysis)
		return
	}

	analysis, err := s.analyzeGenericLog(ctx, req.Log)
	if err != nil {
		c.JSON(500, gin.H{"error": fmt.Sprintf("Failed to analyze log: %v", err)})
		return
	}
	c.JSON(200, analysis)
}

// isKarpenterJSONLog reports whether the body parses as a JSON object with
// Karpenter-style log fields. The dedicated /karpenter/logs/analyze
// endpoint keeps its own behavior; this only routes the shared
// /logs/analyze endpoint.
func isKarpenterJSONLog(logStr string) bool {
	var probe map[string]interface{}
	if err := json.Unmarshal([]byte(logStr), &probe); err != nil {
		return false
	}
	// Karpenter's structured logs carry at least a level and a message.
	if _, ok := probe["level"]; !ok {
		return false
	}
	if _, ok := probe["message"]; !ok {
		return false
	}
	return true
}
