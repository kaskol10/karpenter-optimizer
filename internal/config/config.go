package config

import (
	"os"
)

type Config struct {
	KubeconfigPath string
	KubeContext    string
	APIPort        string
	OllamaURL      string
	OllamaModel    string
}

func Load() *Config {
	return &Config{
		KubeconfigPath: getEnv("KUBECONFIG", ""),
		KubeContext:    getEnv("KUBE_CONTEXT", ""),
		APIPort:        getEnv("PORT", "8080"),
		OllamaURL:      getEnv("OLLAMA_URL", "http://localhost:11434"),
		OllamaModel:    getEnv("OLLAMA_MODEL", "granite4:latest"),
	}
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}
