package config

import (
	"os"
	"strconv"
	"strings"
)

type Config struct {
	KubeconfigPath string
	KubeContext    string
	APIPort        string
	// LLM Configuration (supports Ollama, LiteLLM or AWS Bedrock)
	LLMProvider  string // "ollama", "litellm" or "bedrock"
	LLMURL       string
	LLMModel     string
	LLMAPIKey    string
	LLMAWSRegion string // AWS region override for the Bedrock provider (optional)
	LLMMaxTokens int    // Response token cap for the Bedrock provider (0 = model default)
	// Legacy Ollama configuration (for backward compatibility)
	OllamaURL   string
	OllamaModel string
	// AWS Configuration for Pricing API
	AWSRegion          string // AWS region (defaults to eu-west-1)
	AWSAccessKeyID     string // AWS access key ID (optional, can use IAM role)
	AWSSecretAccessKey string // AWS secret access key (optional, can use IAM role)
	AWSSessionToken    string // AWS session token (for temporary credentials)
	Debug              bool
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
	// No sensible default model exists for Bedrock (model access is
	// account-specific), so leave it empty and let the client report it.
	if llmModel == "" && llmProvider != "bedrock" {
		llmModel = "granite4:latest"
	}
	if llmProvider == "" {
		llmProvider = "ollama"
	}

	// Set legacy Ollama fields for backward compatibility
	// If legacy env vars were provided, use them; otherwise use the LLM defaults
	if ollamaURL == "" {
		ollamaURL = llmURL
	}
	if ollamaModel == "" {
		ollamaModel = llmModel
	}

	return &Config{
		KubeconfigPath:    getEnv("KUBECONFIG", ""),
		KubeContext:       getEnv("KUBE_CONTEXT", ""),
		APIPort:           getEnv("PORT", "8080"),
		LLMProvider:       llmProvider,
		LLMURL:            llmURL,
		LLMModel:          llmModel,
		LLMAPIKey:         llmAPIKey,
		LLMAWSRegion:      getEnv("LLM_AWS_REGION", ""),
		LLMMaxTokens:      getEnvInt("LLM_MAX_TOKENS", 0),
		OllamaURL:         ollamaURL, // Keep for backward compatibility
		OllamaModel:       ollamaModel,
		AWSRegion:         getEnv("AWS_REGION", "eu-west-1"),
		AWSAccessKeyID:    getEnv("AWS_ACCESS_KEY_ID", ""),
		AWSSecretAccessKey: getEnv("AWS_SECRET_ACCESS_KEY", ""),
		AWSSessionToken:   getEnv("AWS_SESSION_TOKEN", ""),
		Debug:             getEnvBool("DEBUG", false),
	}
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func getEnvInt(key string, defaultValue int) int {
	if value := os.Getenv(key); value != "" {
		if parsed, err := strconv.Atoi(value); err == nil {
			return parsed
		}
	}
	return defaultValue
}

func getEnvBool(key string, defaultValue bool) bool {
	if value := os.Getenv(key); value != "" {
		return value == "true" || value == "1" || value == "yes" || value == "on"
	}
	return defaultValue
}
