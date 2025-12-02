package main

import (
	"log"
	"os"

	"github.com/karpenter-optimizer/internal/api"
	"github.com/karpenter-optimizer/internal/config"
)

func main() {
	cfg := config.Load()
	
	server := api.NewServer(cfg)
	
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	
	log.Printf("Starting server on port %s", port)
	if err := server.Run(":" + port); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}
}

