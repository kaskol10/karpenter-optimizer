// @title           Karpenter Optimizer API
// @version         1.0
// @description     Cost optimization tool for Karpenter NodePools. Analyzes Kubernetes cluster usage and provides AI-powered recommendations to reduce AWS EC2 costs while maintaining performance.
// @termsOfService  https://github.com/kaskol10/karpenter-optimizer

// @contact.name   Karpenter Optimizer Support
// @contact.url    https://github.com/kaskol10/karpenter-optimizer/issues

// @license.name  Apache 2.0
// @license.url   https://www.apache.org/licenses/LICENSE-2.0.html

// @host      localhost:8080
// @BasePath  /api/v1

package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/karpenter-optimizer/internal/api"
	"github.com/karpenter-optimizer/internal/config"
)

func main() {
	cfg := config.Load()

	// Log configuration
	log.Printf("Starting Karpenter Optimizer API")
	log.Printf("  Port: %s", cfg.APIPort)
	log.Printf("  Debug: %v", cfg.Debug)
	if cfg.KubeconfigPath != "" {
		log.Printf("  Kubeconfig: %s", cfg.KubeconfigPath)
	}
	if cfg.KubeContext != "" {
		log.Printf("  Kube Context: %s", cfg.KubeContext)
	}
	if cfg.OllamaURL != "" {
		log.Printf("  Ollama URL: %s", cfg.OllamaURL)
	}

	server := api.NewServer(cfg)

	port := os.Getenv("PORT")
	if port == "" {
		port = cfg.APIPort
	}

	addr := ":" + port
	httpServer := &http.Server{
		Addr:    addr,
		Handler: server.GetHandler(),
	}

	// Start server in goroutine
	go func() {
		log.Printf("Starting server on %s", addr)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Failed to start server: %v", err)
		}
	}()

	// Wait for interrupt signal
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Println("Shutting down server...")

	// Give outstanding requests 30 seconds to complete
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	if err := httpServer.Shutdown(ctx); err != nil {
		log.Fatalf("Server forced to shutdown: %v", err)
	}

	log.Println("Server exited gracefully")
}
