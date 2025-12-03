package config

import (
	"os"
	"strings"
)

type Config struct {
	KubeconfigPath string
	KubeContext    string
	APIPort        string
	// LLM Configuration (supports Ollama or LiteLLM)
	LLMProvider string // "ollama" or "litellm"
	LLMURL      string
	LLMModel    string
	LLMAPIKey   string
	// Legacy Ollama configuration (for backward compatibility)
	OllamaURL   string
	OllamaModel string
	Debug       bool
}

func Load() *Config {
	// Check for new LLM configuration first
	llmProvider := getEnv("LLM_PROVIDER", "")
	llmURL := getEnv("LLM_URL", "")
	llmModel := getEnv("LLM_MODEL", "")
	llmAPIKey := getEnv("LLM_API_KEY", "")

	// Fallback to legacy Ollama configuration if new LLM config not set
	ollamaURL := getEnv("OLLAMA_URL", "")
	ollamaModel := getEnv("OLLAMA_MODEL", "")

	// If new LLM config is provided, use it; otherwise use legacy Ollama config
	if llmURL == "" && ollamaURL != "" {
		llmURL = ollamaURL
		llmModel = ollamaModel
	}

	// Auto-detect provider from URL if not explicitly set
	if llmURL != "" && llmProvider == "" {
		llmURLLower := strings.ToLower(llmURL)
		if strings.Contains(llmURLLower, "/v1/chat/completions") ||
			strings.Contains(llmURLLower, "litellm") ||
			strings.Contains(llmURLLower, "openai") ||
			strings.Contains(llmURLLower, "vllm") {
			llmProvider = "litellm"
		} else {
			llmProvider = "ollama"
		}
	}

	// Set defaults if still empty
	if llmURL == "" {
		llmURL = "http://localhost:11434"
	}
	if llmModel == "" {
		llmModel = "granite4:latest"
	}
	if llmProvider == "" {
		llmProvider = "ollama"
	}

	return &Config{
		KubeconfigPath: getEnv("KUBECONFIG", ""),
		KubeContext:    getEnv("KUBE_CONTEXT", ""),
		APIPort:        getEnv("PORT", "8080"),
		LLMProvider:    llmProvider,
		LLMURL:         llmURL,
		LLMModel:       llmModel,
		LLMAPIKey:      llmAPIKey,
		OllamaURL:      ollamaURL, // Keep for backward compatibility
		OllamaModel:    ollamaModel,
		Debug:          getEnvBool("DEBUG", false),
	}
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func getEnvBool(key string, defaultValue bool) bool {
	if value := os.Getenv(key); value != "" {
		return value == "true" || value == "1" || value == "yes" || value == "on"
	}
	return defaultValue
}
