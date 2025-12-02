package api

import (
	"github.com/gin-gonic/gin"
	"github.com/karpenter-optimizer/internal/config"
	"github.com/karpenter-optimizer/internal/recommender"
)

type Server struct {
	router      *gin.Engine
	config      *config.Config
	recommender *recommender.Recommender
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
	
	server := &Server{
		router:      r,
		config:      cfg,
		recommender: recommender.NewRecommender(cfg),
	}
	
	server.setupRoutes()
	
	return server
}

func (s *Server) setupRoutes() {
	api := s.router.Group("/api/v1")
	{
		api.GET("/health", s.healthCheck)
		api.POST("/analyze", s.analyzeWorkloads)
		api.GET("/recommendations", s.getRecommendations)
		api.POST("/recommendations", s.generateRecommendations)
	}
}

func (s *Server) Run(addr string) error {
	return s.router.Run(addr)
}

func (s *Server) healthCheck(c *gin.Context) {
	c.JSON(200, gin.H{
		"status": "healthy",
		"service": "karpenter-optimizer",
	})
}

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
		workloads[i] = recommender.Workload{
			Name:      w.Name,
			Namespace: w.Namespace,
			CPU:       w.CPU,
			Memory:    w.Memory,
			GPU:       w.GPU,
			Labels:    w.Labels,
		}
	}
	
	recommendations := s.recommender.Analyze(workloads)
	
	c.JSON(200, gin.H{
		"recommendations": recommendations,
	})
}

func (s *Server) getRecommendations(c *gin.Context) {
	namespace := c.Query("namespace")
	
	recommendations, err := s.recommender.GetRecommendations(namespace)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	
	c.JSON(200, gin.H{
		"recommendations": recommendations,
	})
}

func (s *Server) generateRecommendations(c *gin.Context) {
	var req struct {
		Namespace string `json:"namespace"`
	}
	
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	
	recommendations, err := s.recommender.GenerateRecommendations(req.Namespace)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	
	c.JSON(200, gin.H{
		"recommendations": recommendations,
	})
}

type WorkloadRequest struct {
	Name      string            `json:"name"`
	Namespace string            `json:"namespace"`
	CPU       string            `json:"cpu"`
	Memory    string            `json:"memory"`
	GPU       int               `json:"gpu"`
	Labels    map[string]string `json:"labels"`
}

