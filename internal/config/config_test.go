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

