package config

import (
	"net/url"
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
	// LiteLLM gateway metrics auth: Bearer key for the proxy's /metrics
	// endpoint (required by LiteLLM >= v1.85.0). Empty = unauthenticated.
	LiteLLMMetricsAPIKey string
	// LiteLLM gateway cost history: Postgres DSN (e.g. a CNPG cluster) that
	// durably stores per-day spend/token totals. Empty = in-memory store that
	// resets on process restart. If empty, it is composed from
	// GATEWAY_HISTORY_DB_{HOST,PORT,USER,DATABASE} + GATEWAY_HISTORY_DB_PASSWORD.
	GatewayHistoryDSN string
	// Durable serving history: Postgres DSN for raw per-pod serving samples
	// (7d retention by default). Empty = in-memory only (windows capped at
	// HISTORY_WINDOW_HOURS). SERVING_HISTORY_DSN wins; otherwise the gateway
	// DSN is reused so both histories share one CNPG instance.
	ServingHistoryDSN string
	// Legacy Ollama configuration (for backward compatibility)
	OllamaURL   string
	OllamaModel string
	// AWS Configuration for Pricing API
	AWSRegion          string // AWS region (defaults to eu-west-1)
	AWSAccessKeyID     string // AWS access key ID (optional, can use IAM role)
	AWSSecretAccessKey string // AWS secret access key (optional, can use IAM role)
	AWSSessionToken    string // AWS session token (for temporary credentials)
	AgentHistoryFile   string // Where the cost-optimization agent persists its learning history
	Debug              bool
	// APIAuthToken is the shared bearer token for /api/v1 (and /metrics when
	// enabled). Empty = API left open (legacy behavior, logged as a warning);
	// /health stays open either way for probes.
	APIAuthToken string
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
		KubeconfigPath:       getEnv("KUBECONFIG", ""),
		KubeContext:          getEnv("KUBE_CONTEXT", ""),
		APIPort:              getEnv("PORT", "8080"),
		LLMProvider:          llmProvider,
		LLMURL:               llmURL,
		LLMModel:             llmModel,
		LLMAPIKey:            llmAPIKey,
		LLMAWSRegion:         getEnv("LLM_AWS_REGION", ""),
		LLMMaxTokens:         getEnvInt("LLM_MAX_TOKENS", 0),
		LiteLLMMetricsAPIKey: getEnv("LITELLM_METRICS_API_KEY", ""),
		GatewayHistoryDSN:    resolveGatewayHistoryDSN(),
		ServingHistoryDSN:    resolveServingHistoryDSN(),
		OllamaURL:            ollamaURL, // Keep for backward compatibility
		OllamaModel:          ollamaModel,
		AWSRegion:            getEnv("AWS_REGION", "eu-west-1"),
		AWSAccessKeyID:       getEnv("AWS_ACCESS_KEY_ID", ""),
		AWSSecretAccessKey:   getEnv("AWS_SECRET_ACCESS_KEY", ""),
		AWSSessionToken:      getEnv("AWS_SESSION_TOKEN", ""),
		AgentHistoryFile:     getEnv("AGENT_HISTORY_FILE", "/tmp/karpenter-optimizer-history.json"),
		Debug:                getEnvBool("DEBUG", false),
		APIAuthToken:         getEnv("API_AUTH_TOKEN", ""),
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

// resolveGatewayHistoryDSN returns the Postgres DSN for durable gateway cost
// history. An explicit GATEWAY_HISTORY_DSN wins; otherwise the DSN is composed
// from GATEWAY_HISTORY_DB_{HOST,PORT,USER,DATABASE} plus
// GATEWAY_HISTORY_DB_PASSWORD (the password is passed via a CNPG Secret in the
// chart). Returns "" when no host is set, which selects the in-memory store.
func resolveGatewayHistoryDSN() string {
	if dsn := os.Getenv("GATEWAY_HISTORY_DSN"); dsn != "" {
		return dsn
	}
	host := os.Getenv("GATEWAY_HISTORY_DB_HOST")
	if host == "" {
		return ""
	}
	port := getEnv("GATEWAY_HISTORY_DB_PORT", "5432")
	u := &url.URL{
		Scheme: "postgres",
		Host:   netHost(host, port),
	}
	if user := os.Getenv("GATEWAY_HISTORY_DB_USER"); user != "" {
		password := os.Getenv("GATEWAY_HISTORY_DB_PASSWORD")
		if password != "" {
			u.User = url.UserPassword(user, password)
		} else {
			u.User = url.User(user)
		}
	}
	db := os.Getenv("GATEWAY_HISTORY_DB_NAME")
	if db == "" {
		db = os.Getenv("GATEWAY_HISTORY_DB_DATABASE")
	}
	if db != "" {
		u.Path = "/" + db
	}
	return u.String()
}

// resolveServingHistoryDSN returns the Postgres DSN for durable serving
// history. An explicit SERVING_HISTORY_DSN wins; otherwise the gateway
// history DSN (explicit or composed) is reused so both histories share one
// CNPG instance. Returns "" when nothing is configured (in-memory only).
func resolveServingHistoryDSN() string {
	if dsn := os.Getenv("SERVING_HISTORY_DSN"); dsn != "" {
		return dsn
	}
	return resolveGatewayHistoryDSN()
}

// netHost joins host and port, leaving a bare host when port is empty.
func netHost(host, port string) string {
	if port == "" {
		return host
	}
	return host + ":" + port
}
