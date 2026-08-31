package ollama

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestNewClient(t *testing.T) {
	t.Run("applies defaults", func(t *testing.T) {
		c := NewClient("", "", "", "", false)

		assert.Equal(t, "ollama", c.provider)
		assert.Equal(t, "http://localhost:11434", c.baseURL)
		assert.Equal(t, "gemma3:1b", c.model)
	})

	t.Run("auto-detects litellm from URL", func(t *testing.T) {
		c := NewClient("http://litellm-service:4000", "gpt-4o-mini", "", "", false)

		assert.Equal(t, "litellm", c.provider)
	})

	t.Run("never auto-detects bedrock", func(t *testing.T) {
		c := NewClient("", "some-model", "", "", false)

		assert.NotEqual(t, "bedrock", c.provider)
		assert.Nil(t, c.bedrockClient)
	})

	t.Run("bedrock has no default model", func(t *testing.T) {
		c := NewClient("", "", "bedrock", "", false)

		assert.Equal(t, "bedrock", c.provider)
		assert.Empty(t, c.model)
	})
}

func TestBedrockChatRequiresModel(t *testing.T) {
	c := NewClient("", "", "bedrock", "", false)
	if c.bedrockClient == nil {
		t.Skip("AWS config not loadable in this environment")
	}

	_, err := c.Chat(context.Background(), "hello")

	assert.ErrorContains(t, err, "LLM_MODEL")
}
