// @title           Karpenter Optimizer API
// @version         1.0
// @description     Cost optimization tool for Karpenter NodePools. Analyzes Kubernetes cluster usage and provides AI-powered recommendations to reduce AWS EC2 costs while maintaining performance.
// @termsOfService  https://github.com/kaskol10/karpenter-optimizer

// @contact.name   Karpenter Optimizer Support
// @contact.url    https://github.com/kaskol10/karpenter-optimizer/issues
// @contact.email  support@karpenter-optimizer.io

// @license.name  Apache 2.0
// @license.url   https://www.apache.org/licenses/LICENSE-2.0.html

// @host      localhost:8080
// @BasePath  /api/v1

// @tag.name health
// @tag.description Health check endpoints

// @tag.name recommendations
// @tag.description NodePool recommendation endpoints

// @tag.name workloads
// @tag.description Kubernetes workload endpoints

// @tag.name nodepools
// @tag.description Karpenter NodePool endpoints

// @tag.name nodes
// @tag.description Kubernetes node endpoints

// @tag.name cluster
// @tag.description Cluster-wide statistics and analysis

package api

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	swaggerFiles "github.com/swaggo/files"
	ginSwagger "github.com/swaggo/gin-swagger"
	"github.com/karpenter-optimizer/internal/config"
	"github.com/karpenter-optimizer/internal/kubernetes"
	"github.com/karpenter-optimizer/internal/recommender"
	
	"github.com/karpenter-optimizer/docs/swagger" // Swagger docs
)

// debugLog prints debug messages only if debug logging is enabled
func debugLog(debug bool, format string, args ...interface{}) {
	if debug {
		fmt.Printf(format, args...)
	}
}

type Server struct {
	router      *gin.Engine
	config      *config.Config
	recommender *recommender.Recommender
	k8sClient   *kubernetes.Client
}

func NewServer(cfg *config.Config) *Server {
	if cfg == nil {
		cfg = config.Load()
	}

	r := gin.Default()

	// CORS middleware
	r.Use(func(c *gin.Context) {
		c.Writer.Header().Set("Access-Control-Allow-Origin", "*")
		c.Writer.Header().Set("Access-Control-Allow-Credentials", "true")
		c.Writer.Header().Set("Access-Control-Allow-Headers", "Content-Type, Content-Length, Accept-Encoding, X-CSRF-Token, Authorization, accept, origin, Cache-Control, X-Requested-With")
		c.Writer.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS, GET, PUT, DELETE")

		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(204)
			return
		}

		c.Next()
	})

	// Initialize Kubernetes client
	// Always try to initialize (will use provided kubeconfig, context, or default locations)
	var k8sClient *kubernetes.Client
	k8sClient, err := kubernetes.NewClientWithDebug(cfg.KubeconfigPath, cfg.KubeContext, cfg.Debug)
	if err != nil {
		// Log error but continue without Kubernetes client
		// This allows the server to start without cluster access
		debugLog(cfg.Debug, "Warning: Failed to initialize Kubernetes client: %v\n", err)
		debugLog(cfg.Debug, "Kubernetes features will be disabled. Check KUBECONFIG and KUBE_CONTEXT settings.\n")
		if cfg.KubeconfigPath != "" {
			debugLog(cfg.Debug, "  Attempted kubeconfig path: %s\n", cfg.KubeconfigPath)
		}
		if cfg.KubeContext != "" {
			debugLog(cfg.Debug, "  Attempted context: %s\n", cfg.KubeContext)
		}
		k8sClient = nil
	} else {
		debugLog(cfg.Debug, "Successfully connected to Kubernetes cluster\n")
		if cfg.KubeContext != "" {
			debugLog(cfg.Debug, "  Using context: %s\n", cfg.KubeContext)
		}
	}

	rec := recommender.NewRecommender(cfg)
	if k8sClient != nil {
		rec.SetK8sClient(k8sClient)
	}

	server := &Server{
		router:      r,
		config:      cfg,
		recommender: rec,
		k8sClient:   k8sClient,
	}

	server.setupRoutes()

	return server
}

func (s *Server) setupRoutes() {
	// Swagger UI endpoint with dynamic host detection
	// Accessible at /api/swagger/index.html
	// When accessed through ingress, Swagger UI will automatically use the request host
	s.router.GET("/api/swagger/*any", func(c *gin.Context) {
		// Handle /doc.json specifically for dynamic host injection
		if c.Param("any") == "/doc.json" {
			// Detect scheme from request (http or https)
			scheme := "http"
			if c.Request.TLS != nil {
				scheme = "https"
			} else if proto := c.GetHeader("X-Forwarded-Proto"); proto == "https" {
				scheme = "https"
			}
			
			// Get host from request (works with ingress via X-Forwarded-Host or Host header)
			host := c.GetHeader("X-Forwarded-Host")
			if host == "" {
				host = c.Request.Host
			}
			
			// Get the Swagger spec using swag
			swaggerInfo := swagger.SwaggerInfo.ReadDoc()
			
			// Parse JSON to modify host dynamically
			var swaggerSpec map[string]interface{}
			if err := json.Unmarshal([]byte(swaggerInfo), &swaggerSpec); err == nil {
				// Update host in spec
				swaggerSpec["host"] = host
				swaggerSpec["schemes"] = []string{scheme}
				
				// Return modified spec
				c.Header("Content-Type", "application/json")
				c.JSON(200, swaggerSpec)
				return
			}
			
			// Fallback: return original spec if parsing fails
			c.Header("Content-Type", "application/json")
			c.String(200, swaggerInfo)
			return
		}
		
		// For all other Swagger UI paths (index.html, etc.)
		// Detect scheme from request
		scheme := "http"
		if c.Request.TLS != nil {
			scheme = "https"
		} else if proto := c.GetHeader("X-Forwarded-Proto"); proto == "https" {
			scheme = "https"
		}
		
		// Get host from request
		host := c.GetHeader("X-Forwarded-Host")
		if host == "" {
			host = c.Request.Host
		}
		
		// Build dynamic Swagger doc URL based on request
		swaggerURL := fmt.Sprintf("%s://%s/api/swagger/doc.json", scheme, host)
		
		// Wrap handler with dynamic URL
		handler := ginSwagger.WrapHandler(swaggerFiles.Handler, ginSwagger.URL(swaggerURL))
		handler(c)
	})

	api := s.router.Group("/api/v1")
	{
		api.GET("/health", s.healthCheck)
		api.GET("/config", s.getConfig)
		api.POST("/analyze", s.analyzeWorkloads)
		api.GET("/recommendations", s.getRecommendations)
		api.POST("/recommendations", s.generateRecommendations)
		api.GET("/metrics/workload", s.getWorkloadMetrics)
		api.POST("/metrics/workloads", s.getWorkloadsMetrics)
		api.GET("/namespaces", s.listNamespaces)
		api.GET("/workloads", s.listWorkloads)
		api.GET("/workloads/:namespace/:name", s.getWorkload)
		api.GET("/nodepools", s.listNodePools)
		api.GET("/nodepools/:name", s.getNodePool)
		api.GET("/nodepools/recommendations", s.getNodePoolRecommendations)
		api.GET("/disruptions", s.getNodeDisruptions)
		api.GET("/disruptions/recent", s.getRecentNodeDeletions)
		api.GET("/nodes", s.getNodesWithUsage)
		api.GET("/cluster/summary", s.getClusterSummary)
		api.GET("/recommendations/cluster-summary", s.getRecommendationsFromClusterSummary)
		api.GET("/recommendations/cluster-summary/stream", s.getRecommendationsFromClusterSummarySSE)
	}
}

func (s *Server) Run(addr string) error {
	return s.router.Run(addr)
}

// HealthCheck godoc
// @Summary      Health check
// @Description  Check API health and service status
// @Tags         health
// @Accept       json
// @Produce      json
// @Success      200  {object}  map[string]interface{}  "Health status"
// @Router       /health [get]
func (s *Server) healthCheck(c *gin.Context) {
	health := gin.H{
		"status":  "healthy",
		"service": "karpenter-optimizer",
	}

	// Add Kubernetes client status
	if s.k8sClient != nil {
		health["kubernetes"] = "connected"
	} else {
		health["kubernetes"] = "not configured"
	}

	// Prometheus support removed - recommendations use Kubernetes resource requests and node usage data
	health["prometheus"] = "not supported"

	c.JSON(200, health)
}

// GetConfig godoc
// @Summary      Get configuration
// @Description  Get current API configuration including Kubernetes, Ollama, and AWS settings
// @Tags         health
// @Accept       json
// @Produce      json
// @Success      200  {object}  map[string]interface{}  "Configuration"
// @Router       /config [get]
func (s *Server) getConfig(c *gin.Context) {
	config := gin.H{
		"kubernetes": gin.H{
			"connected":      s.k8sClient != nil,
			"kubeconfigPath": s.config.KubeconfigPath,
			"kubeContext":    s.config.KubeContext,
		},
		"llm": gin.H{
			"provider":   s.config.LLMProvider,
			"url":        s.config.LLMURL,
			"model":      s.config.LLMModel,
			"configured": s.config.LLMURL != "",
			"hasApiKey":  s.config.LLMAPIKey != "",
		},
		"ollama": gin.H{
			"url":        s.config.OllamaURL,
			"model":      s.config.OllamaModel,
			"configured": s.config.OllamaURL != "",
			"note":       "Legacy configuration (for backward compatibility)",
		},
		"api": gin.H{
			"port": s.config.APIPort,
		},
		"aws": gin.H{
			"pricingApi": "enabled", // AWS Pricing API is always enabled
		},
	}

	c.JSON(200, config)
}

// AnalyzeWorkloads godoc
// @Summary      Analyze workloads
// @Description  Analyze provided workloads and get NodePool recommendations
// @Tags         recommendations
// @Accept       json
// @Produce      json
// @Param        workloads  body      WorkloadRequest  true  "Workloads to analyze"
// @Success      200        {object}  map[string]interface{}  "Recommendations"
// @Failure      400        {object}  map[string]interface{}  "Bad request"
// @Router       /analyze [post]
func (s *Server) analyzeWorkloads(c *gin.Context) {
	var req struct {
		Workloads []WorkloadRequest `json:"workloads"`
	}

	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}

	workloads := make([]recommender.Workload, len(req.Workloads))
	for i, w := range req.Workloads {
		// Use CPU/Memory from request, or default to requests if limits not provided
		cpu := w.CPU
		memory := w.Memory
		if cpu == "" {
			cpu = w.CPURequest
		}
		if memory == "" {
			memory = w.MemoryRequest
		}

		workloads[i] = recommender.Workload{
			Name:          w.Name,
			Namespace:     w.Namespace,
			CPU:           cpu,
			Memory:        memory,
			GPU:           w.GPU,
			Labels:        w.Labels,
			CPURequest:    w.CPURequest,
			MemoryRequest: w.MemoryRequest,
		}
	}

	recommendations := s.recommender.Analyze(workloads)

	c.JSON(200, gin.H{
		"recommendations": recommendations,
	})
}

// GetRecommendations godoc
// @Summary      Get NodePool recommendations
// @Description  Get cost-optimized NodePool recommendations based on actual cluster usage and node capacity
// @Tags         recommendations
// @Accept       json
// @Produce      json
// @Success      200  {object}  map[string]interface{}  "Recommendations with cluster cost analysis"
// @Failure      503  {object}  map[string]interface{}  "Kubernetes client not configured"
// @Failure      500  {object}  map[string]interface{}  "Internal server error"
// @Router       /recommendations [get]
func (s *Server) getRecommendations(c *gin.Context) {
	// Use NodePool-based recommendations (based on actual node capacity)
	if s.k8sClient == nil {
		c.JSON(503, gin.H{"error": "Kubernetes client not configured"})
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// Get NodePools with actual node data
	nodePools, err := s.k8sClient.ListNodePools(ctx)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	// Generate recommendations based on actual node capacity
	recommendations, err := s.recommender.GenerateRecommendationsFromNodePools(ctx, nodePools, nil)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	// Calculate cluster-wide costs
	// Since recommendations now includes all NodePools, we can sum directly
	var currentClusterCost, recommendedClusterCost float64
	for _, rec := range recommendations {
		currentClusterCost += rec.CurrentCost
		recommendedClusterCost += rec.RecommendedCost
	}

	c.JSON(200, gin.H{
		"recommendations": recommendations,
		"count":           len(recommendations),
		"clusterCost": gin.H{
			"current":     currentClusterCost,
			"recommended": recommendedClusterCost,
			"savings":     currentClusterCost - recommendedClusterCost,
		},
		"note": "Recommendations based on actual NodePool capacity and node usage data",
	})
}

// GetRecommendationsFromClusterSummarySSE godoc
// @Summary      Get cluster recommendations with SSE progress
// @Description  Get NodePool recommendations with Server-Sent Events for real-time progress updates
// @Tags         recommendations
// @Accept       json
// @Produce      text/event-stream
// @Success      200  {string}  text/event-stream  "SSE stream with progress and recommendations"
// @Failure      503  {object}  map[string]interface{}  "Kubernetes client not configured"
// @Failure      500  {object}  map[string]interface{}  "Internal server error"
// @Router       /recommendations/cluster-summary/stream [get]
// getRecommendationsFromClusterSummarySSE generates recommendations with Server-Sent Events for progress updates
func (s *Server) getRecommendationsFromClusterSummarySSE(c *gin.Context) {
	if s.k8sClient == nil {
		c.JSON(503, gin.H{"error": "Kubernetes client not configured"})
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	// Set up SSE headers
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("X-Accel-Buffering", "no") // Disable nginx buffering

	// Send initial connection message
	c.SSEvent("progress", gin.H{"message": "Connecting...", "progress": 0.0})
	c.Writer.Flush()

	// Get NodePools with actual node data
	c.SSEvent("progress", gin.H{"message": "Fetching NodePool data...", "progress": 2.0})
	c.Writer.Flush()

	nodePools, err := s.k8sClient.ListNodePools(ctx)
	if err != nil {
		c.SSEvent("error", gin.H{"error": err.Error()})
		c.Writer.Flush()
		return
	}

	// Create progress callback
	progressCallback := func(message string, progress float64) {
		c.SSEvent("progress", gin.H{"message": message, "progress": progress})
		c.Writer.Flush()
	}

	// Generate recommendations based on actual node capacity with progress updates
	recommendations, err := s.recommender.GenerateRecommendationsFromNodePools(ctx, nodePools, progressCallback)

	if err != nil {
		c.SSEvent("error", gin.H{"error": err.Error()})
		c.Writer.Flush()
		return
	}

	// Calculate cluster-wide costs from recommendations
	// Since recommendations now includes all NodePools, we can sum directly
	var recommendedClusterCost float64
	var recommendedNodes int
	var totalCurrentNodes int
	var totalCurrentCost float64
	for _, rec := range recommendations {
		recommendedClusterCost += rec.RecommendedCost
		recommendedNodes += rec.RecommendedNodes
		totalCurrentCost += rec.CurrentCost
		totalCurrentNodes += rec.CurrentNodes
	}

	// Send final result
	c.SSEvent("complete", gin.H{
		"recommendations": recommendations,
		"count":           len(recommendations),
		"totalNodePools":  len(nodePools),
		"clusterCost": gin.H{
			"current":     totalCurrentCost,
			"recommended": recommendedClusterCost,
			"savings":     totalCurrentCost - recommendedClusterCost,
		},
		"clusterNodes": gin.H{
			"current":     totalCurrentNodes,
			"recommended": recommendedNodes,
		},
		"note": "Recommendations based on actual NodePool capacity and node usage data",
	})
	c.Writer.Flush()
}

// GenerateRecommendations godoc
// @Summary      Generate recommendations
// @Description  Generate NodePool recommendations (alias for GET /recommendations)
// @Tags         recommendations
// @Accept       json
// @Produce      json
// @Success      200  {object}  map[string]interface{}  "Recommendations"
// @Failure      503  {object}  map[string]interface{}  "Kubernetes client not configured"
// @Failure      500  {object}  map[string]interface{}  "Internal server error"
// @Router       /recommendations [post]
func (s *Server) generateRecommendations(c *gin.Context) {
	// Use NodePool-based recommendations (based on actual node capacity)
	s.getRecommendations(c)
}

// GetWorkloadMetrics godoc
// @Summary      Get workload metrics (deprecated)
// @Description  This endpoint is deprecated. Prometheus support has been removed.
// @Tags         workloads
// @Accept       json
// @Produce      json
// @Success      501  {object}  map[string]interface{}  "Not implemented"
// @Router       /metrics/workload [get]
func (s *Server) getWorkloadMetrics(c *gin.Context) {
	// Prometheus support removed - metrics endpoints are no longer available
	c.JSON(501, gin.H{
		"error": "Prometheus support has been removed. Recommendations now use Kubernetes resource requests and node usage data.",
	})
}

// GetWorkloadsMetrics godoc
// @Summary      Get workloads metrics (deprecated)
// @Description  This endpoint is deprecated. Prometheus support has been removed.
// @Tags         workloads
// @Accept       json
// @Produce      json
// @Success      501  {object}  map[string]interface{}  "Not implemented"
// @Router       /metrics/workloads [post]
func (s *Server) getWorkloadsMetrics(c *gin.Context) {
	// Prometheus support removed - metrics endpoints are no longer available
	c.JSON(501, gin.H{
		"error": "Prometheus support has been removed. Recommendations now use Kubernetes resource requests and node usage data.",
	})
}

// ListNamespaces godoc
// @Summary      List namespaces
// @Description  List all Kubernetes namespaces in the cluster
// @Tags         workloads
// @Accept       json
// @Produce      json
// @Success      200  {object}  map[string]interface{}  "List of namespaces"
// @Failure      503  {object}  map[string]interface{}  "Kubernetes client not configured"
// @Failure      500  {object}  map[string]interface{}  "Internal server error"
// @Router       /namespaces [get]
func (s *Server) listNamespaces(c *gin.Context) {
	if s.k8sClient == nil {
		c.JSON(503, gin.H{
			"error": "Kubernetes client not configured",
			"hint":  "Set KUBECONFIG environment variable or ensure kubeconfig is accessible",
		})
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	namespaces, err := s.k8sClient.ListNamespaces(ctx)
	if err != nil {
		c.JSON(500, gin.H{
			"error": err.Error(),
			"hint":  "Check that kubeconfig is valid and you have access to the cluster",
		})
		return
	}

	c.JSON(200, gin.H{
		"namespaces": namespaces,
	})
}

// ListWorkloads godoc
// @Summary      List workloads
// @Description  List all workloads (Deployments, StatefulSets, DaemonSets) in a namespace
// @Tags         workloads
// @Accept       json
// @Produce      json
// @Param        namespace  query     string  true  "Namespace name"
// @Success      200       {object}  map[string]interface{}  "List of workloads"
// @Failure      400       {object}  map[string]interface{}  "Bad request - namespace required"
// @Failure      503       {object}  map[string]interface{}  "Kubernetes client not configured"
// @Failure      500       {object}  map[string]interface{}  "Internal server error"
// @Router       /workloads [get]
func (s *Server) listWorkloads(c *gin.Context) {
	if s.k8sClient == nil {
		c.JSON(503, gin.H{
			"error": "Kubernetes client not configured",
			"hint":  "Set KUBECONFIG environment variable or ensure kubeconfig is accessible",
		})
		return
	}

	namespace := c.Query("namespace")
	if namespace == "" {
		c.JSON(400, gin.H{"error": "namespace query parameter is required"})
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	workloads, err := s.k8sClient.ListWorkloads(ctx, namespace)
	if err != nil {
		c.JSON(500, gin.H{
			"error": err.Error(),
			"hint":  fmt.Sprintf("Check that namespace '%s' exists and you have permissions to list workloads", namespace),
		})
		return
	}

	c.JSON(200, gin.H{
		"workloads": workloads,
	})
}

// GetWorkload godoc
// @Summary      Get workload
// @Description  Get details of a specific workload (Deployment, StatefulSet, or DaemonSet)
// @Tags         workloads
// @Accept       json
// @Produce      json
// @Param        namespace  path      string  true  "Namespace name"
// @Param        name       path      string  true  "Workload name"
// @Param        type       query     string  false  "Workload type (deployment, statefulset, daemonset)" default(deployment)
// @Success      200        {object}  map[string]interface{}  "Workload details"
// @Failure      503        {object}  map[string]interface{}  "Kubernetes client not configured"
// @Failure      500        {object}  map[string]interface{}  "Internal server error"
// @Router       /workloads/{namespace}/{name} [get]
func (s *Server) getWorkload(c *gin.Context) {
	if s.k8sClient == nil {
		c.JSON(503, gin.H{"error": "Kubernetes client not configured"})
		return
	}

	namespace := c.Param("namespace")
	name := c.Param("name")
	workloadType := c.DefaultQuery("type", "deployment")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	workload, err := s.k8sClient.GetWorkload(ctx, namespace, name, workloadType)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	c.JSON(200, gin.H{
		"workload": workload,
	})
}

// ListNodePools godoc
// @Summary      List NodePools
// @Description  List all Karpenter NodePools in the cluster with actual node data
// @Tags         nodepools
// @Accept       json
// @Produce      json
// @Success      200  {object}  map[string]interface{}  "List of NodePools"
// @Failure      503  {object}  map[string]interface{}  "Kubernetes client not configured"
// @Failure      500  {object}  map[string]interface{}  "Internal server error"
// @Router       /nodepools [get]
func (s *Server) listNodePools(c *gin.Context) {
	if s.k8sClient == nil {
		c.JSON(503, gin.H{"error": "Kubernetes client not configured"})
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	nodePools, err := s.k8sClient.ListNodePools(ctx)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	c.JSON(200, gin.H{
		"nodepools": nodePools,
	})
}

// GetNodePoolRecommendations godoc
// @Summary      Get NodePool recommendations
// @Description  Get cost-optimized NodePool recommendations based on actual node capacity and usage
// @Tags         nodepools
// @Accept       json
// @Produce      json
// @Success      200  {object}  map[string]interface{}  "NodePool recommendations"
// @Failure      503  {object}  map[string]interface{}  "Kubernetes client not configured"
// @Failure      500  {object}  map[string]interface{}  "Internal server error"
// @Router       /nodepools/recommendations [get]
func (s *Server) getNodePoolRecommendations(c *gin.Context) {
	if s.k8sClient == nil {
		c.JSON(503, gin.H{"error": "Kubernetes client not configured"})
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// Get NodePools with actual node data
	nodePools, err := s.k8sClient.ListNodePools(ctx)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	// Generate recommendations based on actual node capacity
	recommendations, err := s.recommender.GenerateRecommendationsFromNodePools(ctx, nodePools, nil)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	c.JSON(200, gin.H{
		"recommendations": recommendations,
		"count":           len(recommendations),
	})
}

// GetNodePool godoc
// @Summary      Get NodePool
// @Description  Get details of a specific Karpenter NodePool
// @Tags         nodepools
// @Accept       json
// @Produce      json
// @Param        name   path      string  true  "NodePool name"
// @Success      200     {object}  map[string]interface{}  "NodePool details"
// @Failure      503     {object}  map[string]interface{}  "Kubernetes client not configured"
// @Failure      500     {object}  map[string]interface{}  "Internal server error"
// @Router       /nodepools/{name} [get]
func (s *Server) getNodePool(c *gin.Context) {
	if s.k8sClient == nil {
		c.JSON(503, gin.H{"error": "Kubernetes client not configured"})
		return
	}

	name := c.Param("name")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	nodePool, err := s.k8sClient.GetNodePool(ctx, name)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	c.JSON(200, gin.H{
		"nodepool": nodePool,
	})
}

// GetNodeDisruptions godoc
// @Summary      Get node disruptions
// @Description  Get information about node disruptions and blocked deletions
// @Tags         nodes
// @Accept       json
// @Produce      json
// @Param        hours  query     int  false  "Hours to look back (default: 24, max: 168)" default(24)
// @Success      200    {object}  map[string]interface{}  "Node disruptions"
// @Failure      400    {object}  map[string]interface{}  "Bad request - invalid hours parameter"
// @Failure      503    {object}  map[string]interface{}  "Kubernetes client not configured"
// @Failure      500    {object}  map[string]interface{}  "Internal server error"
// @Router       /disruptions [get]
func (s *Server) getNodeDisruptions(c *gin.Context) {
	if s.k8sClient == nil {
		c.JSON(503, gin.H{"error": "Kubernetes client not configured"})
		return
	}

	// Hours parameter is now only used for historical events (nodes already deleted)
	// Current disruptions are based on live node state
	sinceHours := 24
	if hoursStr := c.Query("hours"); hoursStr != "" {
		if hours, err := strconv.Atoi(hoursStr); err != nil {
			c.JSON(400, gin.H{"error": "invalid hours parameter, must be a positive integer"})
			return
		} else {
			if hours <= 0 {
				sinceHours = 24
			} else if hours > 168 {
				// Cap at 168 hours (7 days) to prevent excessive queries
				sinceHours = 168
			} else {
				sinceHours = hours
			}
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	disruptions, err := s.k8sClient.GetNodeDisruptions(ctx, sinceHours)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	c.JSON(200, gin.H{
		"disruptions": disruptions,
		"sinceHours":  sinceHours, // Only used for historical deleted nodes
		"count":       len(disruptions),
		"note":        "Disruptions are based on current live node state, not historical events",
	})
}

// GetRecentNodeDeletions godoc
// @Summary      Get recent node deletions
// @Description  Get information about recently deleted nodes
// @Tags         nodes
// @Accept       json
// @Produce      json
// @Param        hours  query     int  false  "Hours to look back (default: 24, max: 168)" default(24)
// @Success      200    {object}  map[string]interface{}  "Recent node deletions"
// @Failure      400    {object}  map[string]interface{}  "Bad request - invalid hours parameter"
// @Failure      503    {object}  map[string]interface{}  "Kubernetes client not configured"
// @Failure      500    {object}  map[string]interface{}  "Internal server error"
// @Router       /disruptions/recent [get]
func (s *Server) getRecentNodeDeletions(c *gin.Context) {
	if s.k8sClient == nil {
		c.JSON(503, gin.H{"error": "Kubernetes client not configured"})
		return
	}

	// Get hours parameter (default to 24 hours)
	sinceHours := 24
	if hoursStr := c.Query("hours"); hoursStr != "" {
		if hours, err := strconv.Atoi(hoursStr); err != nil {
			c.JSON(400, gin.H{"error": "invalid hours parameter, must be a positive integer"})
			return
		} else {
			if hours <= 0 {
				sinceHours = 24
			} else if hours > 168 {
				// Cap at 168 hours (7 days) to prevent excessive queries
				sinceHours = 168
			} else {
				sinceHours = hours
			}
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	deletions, err := s.k8sClient.GetRecentNodeDeletions(ctx, sinceHours)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	c.JSON(200, gin.H{
		"deletions":  deletions,
		"sinceHours": sinceHours,
		"count":      len(deletions),
	})
}

// GetNodesWithUsage godoc
// @Summary      Get nodes with usage
// @Description  Get all nodes with CPU and memory usage data calculated from pod resource requests
// @Tags         nodes
// @Accept       json
// @Produce      json
// @Success      200  {object}  map[string]interface{}  "Nodes with usage data"
// @Failure      503  {object}  map[string]interface{}  "Kubernetes client not configured"
// @Failure      500  {object}  map[string]interface{}  "Internal server error"
// @Router       /nodes [get]
func (s *Server) getNodesWithUsage(c *gin.Context) {
	if s.k8sClient == nil {
		c.JSON(503, gin.H{"error": "Kubernetes client not configured"})
		return
	}

	// Increase timeout to 60 seconds to handle many nodes with retries
	// Each node can take time with retries, so we need more time for clusters with many nodes
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	nodes, err := s.k8sClient.GetAllNodesWithUsage(ctx)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	c.JSON(200, gin.H{
		"nodes": nodes,
		"count": len(nodes),
	})
}

// GetClusterSummary godoc
// @Summary      Get cluster summary
// @Description  Get cluster-wide statistics including node counts, CPU/memory usage, and capacity type distribution
// @Tags         cluster
// @Accept       json
// @Produce      json
// @Success      200  {object}  map[string]interface{}  "Cluster summary"
// @Failure      503  {object}  map[string]interface{}  "Kubernetes client not configured"
// @Failure      500  {object}  map[string]interface{}  "Internal server error"
// @Router       /cluster/summary [get]
func (s *Server) getClusterSummary(c *gin.Context) {
	if s.k8sClient == nil {
		c.JSON(503, gin.H{"error": "Kubernetes client not configured"})
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	nodes, err := s.k8sClient.GetAllNodesWithUsage(ctx)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	// Aggregate cluster-wide statistics
	var totalNodes, spotNodes, onDemandNodes, totalPods int
	var totalCPUUsed, totalCPUAllocatable, totalMemoryUsed, totalMemoryAllocatable float64

	for _, node := range nodes {
		totalNodes++

		// Count by capacity type
		switch node.CapacityType {
		case "spot":
			spotNodes++
		case "on-demand", "":
			onDemandNodes++
		default:
			onDemandNodes++ // Default to on-demand for unknown types
		}

		// Sum pod counts
		totalPods += node.PodCount

		// Sum CPU usage and allocatable
		if node.CPUUsage != nil {
			totalCPUUsed += node.CPUUsage.Used
			totalCPUAllocatable += node.CPUUsage.Allocatable
		}

		// Sum Memory usage and allocatable
		if node.MemoryUsage != nil {
			totalMemoryUsed += node.MemoryUsage.Used
			totalMemoryAllocatable += node.MemoryUsage.Allocatable
		}
	}

	// Calculate percentages
	var cpuPercent, memoryPercent float64
	if totalCPUAllocatable > 0 {
		cpuPercent = (totalCPUUsed / totalCPUAllocatable) * 100
		if cpuPercent > 100 {
			cpuPercent = 100
		}
	}
	if totalMemoryAllocatable > 0 {
		memoryPercent = (totalMemoryUsed / totalMemoryAllocatable) * 100
		if memoryPercent > 100 {
			memoryPercent = 100
		}
	}

	c.JSON(200, gin.H{
		"summary": gin.H{
			"totalNodes":        totalNodes,
			"spotNodes":         spotNodes,
			"onDemandNodes":     onDemandNodes,
			"totalPods":         totalPods,
			"cpuUsed":           totalCPUUsed,
			"cpuAllocatable":    totalCPUAllocatable,
			"cpuPercent":        cpuPercent,
			"memoryUsed":        totalMemoryUsed,
			"memoryAllocatable": totalMemoryAllocatable,
			"memoryPercent":     memoryPercent,
		},
	})
}

// GetRecommendationsFromClusterSummary godoc
// @Summary      Get cluster recommendations with AI explanations
// @Description  Get NodePool recommendations enhanced with AI-generated explanations about changes and benefits
// @Tags         recommendations
// @Accept       json
// @Produce      json
// @Success      200  {object}  map[string]interface{}  "Recommendations with AI explanations"
// @Failure      503  {object}  map[string]interface{}  "Kubernetes client not configured"
// @Failure      500  {object}  map[string]interface{}  "Internal server error"
// @Router       /recommendations/cluster-summary [get]
func (s *Server) getRecommendationsFromClusterSummary(c *gin.Context) {
	// Get recommendations from nodepools endpoint first
	if s.k8sClient == nil {
		c.JSON(503, gin.H{"error": "Kubernetes client not configured"})
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	// Get NodePools with actual node data
	nodePools, err := s.k8sClient.ListNodePools(ctx)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	// Generate recommendations based on actual node capacity
	recommendations, err := s.recommender.GenerateRecommendationsFromNodePools(ctx, nodePools, nil)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	// Enhance recommendations with Ollama explanations if available
	enhancedRecommendations, err := s.recommender.EnhanceRecommendationsWithOllama(ctx, recommendations)
	if err == nil {
		recommendations = enhancedRecommendations
	}

	// Calculate cluster-wide costs from recommendations
	var recommendedClusterCost float64
	for _, rec := range recommendations {
		recommendedClusterCost += rec.RecommendedCost
	}

	// Calculate total current cost from ALL NodePools (including those without recommendations)
	// Use CurrentCost from recommendations for NodePools with recommendations
	var totalCurrentNodes int
	var totalCurrentCost float64
	recommendedNodePoolNames := make(map[string]bool)
	for _, rec := range recommendations {
		recommendedNodePoolNames[rec.NodePoolName] = true
		totalCurrentCost += rec.CurrentCost   // Add current cost from recommendations
		totalCurrentNodes += rec.CurrentNodes // Add current nodes from recommendations
	}

	// For NodePools without recommendations, calculate their cost
	for _, np := range nodePools {
		if !recommendedNodePoolNames[np.Name] && len(np.ActualNodes) > 0 {
			// This NodePool doesn't have a recommendation, add its current cost
			totalCurrentNodes += np.CurrentNodes
			for _, node := range np.ActualNodes {
				if node.InstanceType != "" {
					nodeCapacityType := node.CapacityType
					if nodeCapacityType == "" {
						nodeCapacityType = np.CapacityType
					}
					if nodeCapacityType == "" {
						nodeCapacityType = "on-demand"
					}
					// Normalize capacity type
					if nodeCapacityType == "on-demand" || nodeCapacityType == "onDemand" || nodeCapacityType == "ondemand" {
						nodeCapacityType = "on-demand"
					} else if nodeCapacityType != "spot" {
						nodeCapacityType = "on-demand"
					}
					// Calculate cost using the exported EstimateCost method
					nodeCost := s.recommender.EstimateCost(ctx, []string{node.InstanceType}, nodeCapacityType, 1)
					totalCurrentCost += nodeCost
				}
			}
		}
	}

	c.JSON(200, gin.H{
		"recommendations": recommendations,
		"count":           len(recommendations),
		"totalNodePools":  len(nodePools),
		"clusterCost": gin.H{
			"current":     totalCurrentCost,
			"recommended": recommendedClusterCost,
			"savings":     totalCurrentCost - recommendedClusterCost,
		},
		"clusterNodes": gin.H{
			"current": totalCurrentNodes,
			"recommended": func() int {
				sum := 0
				for _, rec := range recommendations {
					sum += rec.RecommendedNodes
				}
				return sum
			}(),
		},
		"note": "Recommendations enhanced with AI explanations about changes and benefits",
	})
}

// WorkloadRequest represents a workload analysis request
// @Description Workload specification for analysis
type WorkloadRequest struct {
	Name          string            `json:"name" example:"web-app"`                                    // Workload name
	Namespace     string            `json:"namespace" example:"default"`                              // Kubernetes namespace
	CPU           string            `json:"cpu,omitempty" example:"500m"`                            // CPU limit (optional)
	Memory        string            `json:"memory,omitempty" example:"512Mi"`                         // Memory limit (optional)
	CPURequest    string            `json:"cpuRequest,omitempty" example:"250m"`                      // CPU request (optional)
	MemoryRequest string            `json:"memoryRequest,omitempty" example:"256Mi"`                 // Memory request (optional)
	GPU           int               `json:"gpu" example:"0"`                                          // Number of GPUs required
	Labels        map[string]string `json:"labels,omitempty" example:"app:web,tier:frontend"`        // Workload labels
}
