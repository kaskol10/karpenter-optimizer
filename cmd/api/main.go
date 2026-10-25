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
	"os"
	"os/signal"
	"syscall"

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

	// Root context cancelled by SIGINT/SIGTERM drives graceful shutdown.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	server := api.NewServer(cfg)

	port := os.Getenv("PORT")
	if port == "" {
		port = cfg.APIPort
	}

	log.Printf("Starting server on port %s", port)
	if err := server.RunContext(ctx, ":"+port); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}
	log.Printf("Server shut down cleanly")
}
