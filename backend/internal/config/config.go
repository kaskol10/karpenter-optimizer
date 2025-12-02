package config

import (
	"os"
)

type Config struct {
	KubeconfigPath string
	KubeContext    string
	APIPort        string
}

func Load() *Config {
	return &Config{
		KubeconfigPath: getEnv("KUBECONFIG", ""),
		KubeContext:    getEnv("KUBE_CONTEXT", ""),
		APIPort:        getEnv("PORT", "8080"),
	}
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

