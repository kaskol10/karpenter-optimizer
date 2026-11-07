package config

import (
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestLoad(t *testing.T) {
	t.Run("loads default values", func(t *testing.T) {
		cfg := Load()

		assert.NotNil(t, cfg)
		assert.Equal(t, "8080", cfg.APIPort)
		assert.Equal(t, "http://localhost:11434", cfg.OllamaURL)
		assert.Equal(t, "granite4:latest", cfg.OllamaModel)
		assert.False(t, cfg.Debug)
	})

	t.Run("loads from environment variables", func(t *testing.T) {
		// Set environment variables
		_ = os.Setenv("PORT", "9090")
		_ = os.Setenv("OLLAMA_URL", "http://test:11434")
		_ = os.Setenv("OLLAMA_MODEL", "test-model")
		_ = os.Setenv("KUBECONFIG", "/test/kubeconfig")
		_ = os.Setenv("KUBE_CONTEXT", "test-context")
		_ = os.Setenv("DEBUG", "true")

		// Clean up after test
		defer func() {
			_ = os.Unsetenv("PORT")
			_ = os.Unsetenv("OLLAMA_URL")
			_ = os.Unsetenv("OLLAMA_MODEL")
			_ = os.Unsetenv("KUBECONFIG")
			_ = os.Unsetenv("KUBE_CONTEXT")
			_ = os.Unsetenv("DEBUG")
		}()

		cfg := Load()

		assert.Equal(t, "9090", cfg.APIPort)
		assert.Equal(t, "http://test:11434", cfg.OllamaURL)
		assert.Equal(t, "test-model", cfg.OllamaModel)
		assert.Equal(t, "/test/kubeconfig", cfg.KubeconfigPath)
		assert.Equal(t, "test-context", cfg.KubeContext)
		assert.True(t, cfg.Debug)
	})

	t.Run("handles empty environment variables", func(t *testing.T) {
		_ = os.Setenv("PORT", "")
		_ = os.Setenv("OLLAMA_URL", "")

		defer func() {
			_ = os.Unsetenv("PORT")
			_ = os.Unsetenv("OLLAMA_URL")
		}()

		cfg := Load()

		// Should use defaults when env vars are empty
		assert.Equal(t, "8080", cfg.APIPort)
		assert.Equal(t, "http://localhost:11434", cfg.OllamaURL)
	})
}

func TestGetEnv(t *testing.T) {
	t.Run("returns environment variable value", func(t *testing.T) {
		_ = os.Setenv("TEST_VAR", "test-value")
		defer func() { _ = os.Unsetenv("TEST_VAR") }()

		result := getEnv("TEST_VAR", "default")
		assert.Equal(t, "test-value", result)
	})

	t.Run("returns default when env var not set", func(t *testing.T) {
		_ = os.Unsetenv("NONEXISTENT_VAR")

		result := getEnv("NONEXISTENT_VAR", "default-value")
		assert.Equal(t, "default-value", result)
	})

	t.Run("returns default when env var is empty", func(t *testing.T) {
		_ = os.Setenv("EMPTY_VAR", "")
		defer func() { _ = os.Unsetenv("EMPTY_VAR") }()

		result := getEnv("EMPTY_VAR", "default-value")
		assert.Equal(t, "default-value", result)
	})
}

// TestResolveGatewayHistoryDSN covers the explicit-DSN short-circuit and the
// composition of a DSN from the individual GATEWAY_HISTORY_DB_* parts.
func TestResolveGatewayHistoryDSN(t *testing.T) {
	t.Run("empty when no host", func(t *testing.T) {
		_ = os.Unsetenv("GATEWAY_HISTORY_DSN")
		_ = os.Unsetenv("GATEWAY_HISTORY_DB_HOST")
		assert.Empty(t, resolveGatewayHistoryDSN())
	})

	t.Run("explicit DSN wins", func(t *testing.T) {
		_ = os.Setenv("GATEWAY_HISTORY_DSN", "postgres://u:p@h:5432/db")
		_ = os.Setenv("GATEWAY_HISTORY_DB_HOST", "other")
		defer func() {
			_ = os.Unsetenv("GATEWAY_HISTORY_DSN")
			_ = os.Unsetenv("GATEWAY_HISTORY_DB_HOST")
		}()
		assert.Equal(t, "postgres://u:p@h:5432/db", resolveGatewayHistoryDSN())
	})

	t.Run("composed from parts with password", func(t *testing.T) {
		_ = os.Unsetenv("GATEWAY_HISTORY_DSN")
		_ = os.Setenv("GATEWAY_HISTORY_DB_HOST", "cnpg.cluster")
		_ = os.Setenv("GATEWAY_HISTORY_DB_PORT", "5433")
		_ = os.Setenv("GATEWAY_HISTORY_DB_USER", "gateway_history")
		_ = os.Setenv("GATEWAY_HISTORY_DB_PASSWORD", "s3cret")
		_ = os.Setenv("GATEWAY_HISTORY_DB_NAME", "karpenter_optimizer")
		defer func() {
			_ = os.Unsetenv("GATEWAY_HISTORY_DB_HOST")
			_ = os.Unsetenv("GATEWAY_HISTORY_DB_PORT")
			_ = os.Unsetenv("GATEWAY_HISTORY_DB_USER")
			_ = os.Unsetenv("GATEWAY_HISTORY_DB_PASSWORD")
			_ = os.Unsetenv("GATEWAY_HISTORY_DB_NAME")
		}()
		got := resolveGatewayHistoryDSN()
		assert.Equal(t, "postgres://gateway_history:s3cret@cnpg.cluster:5433/karpenter_optimizer", got)
	})

	t.Run("no user yields no credentials", func(t *testing.T) {
		_ = os.Unsetenv("GATEWAY_HISTORY_DSN")
		_ = os.Unsetenv("GATEWAY_HISTORY_DB_USER")
		_ = os.Setenv("GATEWAY_HISTORY_DB_HOST", "db.local")
		defer func() { _ = os.Unsetenv("GATEWAY_HISTORY_DB_HOST") }()
		assert.Equal(t, "postgres://db.local:5432", resolveGatewayHistoryDSN())
	})
}

// TestResolveServingHistoryDSN covers the explicit-DSN short-circuit and the
// reuse of the gateway history DSN when SERVING_HISTORY_DSN is unset.
func TestResolveServingHistoryDSN(t *testing.T) {
	t.Run("empty when nothing configured", func(t *testing.T) {
		_ = os.Unsetenv("SERVING_HISTORY_DSN")
		_ = os.Unsetenv("GATEWAY_HISTORY_DSN")
		_ = os.Unsetenv("GATEWAY_HISTORY_DB_HOST")
		assert.Empty(t, resolveServingHistoryDSN())
	})

	t.Run("explicit SERVING_HISTORY_DSN wins over gateway DSN", func(t *testing.T) {
		_ = os.Setenv("SERVING_HISTORY_DSN", "postgres://u:p@sh:5432/sdb")
		_ = os.Setenv("GATEWAY_HISTORY_DSN", "postgres://u:p@gw:5432/gdb")
		defer func() {
			_ = os.Unsetenv("SERVING_HISTORY_DSN")
			_ = os.Unsetenv("GATEWAY_HISTORY_DSN")
		}()
		assert.Equal(t, "postgres://u:p@sh:5432/sdb", resolveServingHistoryDSN())
	})

	t.Run("reuses gateway DSN when SERVING_HISTORY_DSN unset", func(t *testing.T) {
		_ = os.Unsetenv("SERVING_HISTORY_DSN")
		_ = os.Setenv("GATEWAY_HISTORY_DSN", "postgres://u:p@gw:5432/gdb")
		defer func() { _ = os.Unsetenv("GATEWAY_HISTORY_DSN") }()
		assert.Equal(t, "postgres://u:p@gw:5432/gdb", resolveServingHistoryDSN())
	})
}

func TestResolvePlacementHistoryDSN(t *testing.T) {
	t.Setenv("PLACEMENT_HISTORY_DSN", "")
	t.Setenv("SERVING_HISTORY_DSN", "")
	t.Setenv("GATEWAY_HISTORY_DSN", "")
	t.Setenv("GATEWAY_HISTORY_DB_HOST", "")
	assert.Empty(t, resolvePlacementHistoryDSN(), "memory only when nothing is configured")

	t.Setenv("GATEWAY_HISTORY_DSN", "postgres://u:p@gw:5432/gdb")
	assert.Equal(t, "postgres://u:p@gw:5432/gdb", resolvePlacementHistoryDSN(), "falls back to the gateway DSN")

	t.Setenv("SERVING_HISTORY_DSN", "postgres://u:p@sh:5432/sdb")
	assert.Equal(t, "postgres://u:p@sh:5432/sdb", resolvePlacementHistoryDSN(), "then the serving DSN")

	t.Setenv("PLACEMENT_HISTORY_DSN", "postgres://u:p@ph:5432/pdb")
	assert.Equal(t, "postgres://u:p@ph:5432/pdb", resolvePlacementHistoryDSN(), "its own DSN wins")
}
