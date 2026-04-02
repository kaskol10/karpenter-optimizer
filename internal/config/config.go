package config

import (
	"os"
	"strconv"
	"strings"
)

var deprecationWarnings []string

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
	// Prometheus/Mimir Configuration
	PrometheusURL string // Prometheus or Mimir base URL (e.g., http://prometheus:9090)
	// AWS Configuration for Pricing API
	AWSRegion            string  // AWS region (defaults to eu-west-1)
	AWSAccessKeyID       string  // AWS access key ID (optional, can use IAM role)
	AWSSecretAccessKey   string  // AWS secret access key (optional, can use IAM role)
	AWSSessionToken      string  // AWS session token (for temporary credentials)
	SpotDiscount         float64 // Discount multiplier for spot instances (default 0.25 = 75% off)
	SavingsPlansDiscount float64 // Discount multiplier for Savings Plans (default 0.28 = 72% off)
	PricingCacheTTL      int     // Cache TTL for AWS pricing in hours (default 24)
	Debug                bool
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

	// Log deprecation warning if legacy env vars are used
	if ollamaURL != "" || ollamaModel != "" {
		deprecationWarnings = append(deprecationWarnings, "OLLAMA_URL and OLLAMA_MODEL are deprecated. Use LLM_URL and LLM_MODEL instead.")
	}

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

	// Set legacy Ollama fields for backward compatibility
	// If legacy env vars were provided, use them; otherwise use the LLM defaults
	if ollamaURL == "" {
		ollamaURL = llmURL
	}
	if ollamaModel == "" {
		ollamaModel = llmModel
	}

	return &Config{
		KubeconfigPath:       getEnv("KUBECONFIG", ""),
		KubeContext:          getEnv("KUBE_CONTEXT", ""),
		APIPort:              getEnv("PORT", "8080"),
		LLMProvider:          llmProvider,
		LLMURL:               llmURL,
		LLMModel:             llmModel,
		LLMAPIKey:            llmAPIKey,
		OllamaURL:            ollamaURL, // Keep for backward compatibility
		OllamaModel:          ollamaModel,
		PrometheusURL:        getEnv("PROMETHEUS_URL", ""),
		AWSRegion:            getEnv("AWS_REGION", "eu-west-1"),
		AWSAccessKeyID:       getEnv("AWS_ACCESS_KEY_ID", ""),
		AWSSecretAccessKey:   getEnv("AWS_SECRET_ACCESS_KEY", ""),
		AWSSessionToken:      getEnv("AWS_SESSION_TOKEN", ""),
		SpotDiscount:         getEnvFloat("SPOT_DISCOUNT", 0.25),          // Default: spot = 25% of on-demand (75% off)
		SavingsPlansDiscount: getEnvFloat("SAVINGS_PLANS_DISCOUNT", 0.28), // Default: Savings Plans = 28% of on-demand (72% off)
		PricingCacheTTL:      getEnvInt("PRICING_CACHE_TTL_HOURS", 24),    // Default: 24 hours
		Debug:                getEnvBool("DEBUG", false),
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

func getEnvFloat(key string, defaultValue float64) float64 {
	if value := os.Getenv(key); value != "" {
		if parsed, err := strconv.ParseFloat(value, 64); err == nil {
			return parsed
		}
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

func GetDeprecationWarnings() []string {
	return deprecationWarnings
}
