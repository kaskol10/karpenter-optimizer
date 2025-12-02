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
	})

	t.Run("loads from environment variables", func(t *testing.T) {
		// Set environment variables
		os.Setenv("PORT", "9090")
		os.Setenv("OLLAMA_URL", "http://test:11434")
		os.Setenv("OLLAMA_MODEL", "test-model")
		os.Setenv("KUBECONFIG", "/test/kubeconfig")
		os.Setenv("KUBE_CONTEXT", "test-context")
		
		// Clean up after test
		defer func() {
			os.Unsetenv("PORT")
			os.Unsetenv("OLLAMA_URL")
			os.Unsetenv("OLLAMA_MODEL")
			os.Unsetenv("KUBECONFIG")
			os.Unsetenv("KUBE_CONTEXT")
		}()

		cfg := Load()
		
		assert.Equal(t, "9090", cfg.APIPort)
		assert.Equal(t, "http://test:11434", cfg.OllamaURL)
		assert.Equal(t, "test-model", cfg.OllamaModel)
		assert.Equal(t, "/test/kubeconfig", cfg.KubeconfigPath)
		assert.Equal(t, "test-context", cfg.KubeContext)
	})

	t.Run("handles empty environment variables", func(t *testing.T) {
		os.Setenv("PORT", "")
		os.Setenv("OLLAMA_URL", "")
		
		defer func() {
			os.Unsetenv("PORT")
			os.Unsetenv("OLLAMA_URL")
		}()

		cfg := Load()
		
		// Should use defaults when env vars are empty
		assert.Equal(t, "8080", cfg.APIPort)
		assert.Equal(t, "http://localhost:11434", cfg.OllamaURL)
	})
}

func TestGetEnv(t *testing.T) {
	t.Run("returns environment variable value", func(t *testing.T) {
		os.Setenv("TEST_VAR", "test-value")
		defer os.Unsetenv("TEST_VAR")

		result := getEnv("TEST_VAR", "default")
		assert.Equal(t, "test-value", result)
	})

	t.Run("returns default when env var not set", func(t *testing.T) {
		os.Unsetenv("NONEXISTENT_VAR")
		
		result := getEnv("NONEXISTENT_VAR", "default-value")
		assert.Equal(t, "default-value", result)
	})

	t.Run("returns default when env var is empty", func(t *testing.T) {
		os.Setenv("EMPTY_VAR", "")
		defer os.Unsetenv("EMPTY_VAR")

		result := getEnv("EMPTY_VAR", "default-value")
		assert.Equal(t, "default-value", result)
	})
}

