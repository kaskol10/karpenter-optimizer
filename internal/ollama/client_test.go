package ollama

import (
	"context"
	"errors"
	"testing"

	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNewClient(t *testing.T) {
	t.Run("applies defaults", func(t *testing.T) {
		c := NewClient("", "", "", "", "", 0, false)

		assert.Equal(t, "ollama", c.provider)
		assert.Equal(t, "http://localhost:11434", c.baseURL)
		assert.Equal(t, "gemma3:1b", c.model)
	})

	t.Run("auto-detects litellm from URL", func(t *testing.T) {
		c := NewClient("http://litellm-service:4000", "gpt-4o-mini", "", "", "", 0, false)

		assert.Equal(t, "litellm", c.provider)
	})

	t.Run("never auto-detects bedrock", func(t *testing.T) {
		c := NewClient("", "some-model", "", "", "", 0, false)

		assert.NotEqual(t, "bedrock", c.provider)
		assert.Nil(t, c.bedrockClient)
	})

	t.Run("bedrock has no default model", func(t *testing.T) {
		c := NewClient("", "", "bedrock", "", "", 0, false)

		assert.Equal(t, "bedrock", c.provider)
		assert.Empty(t, c.model)
	})
}

// fakeBedrock records the ConverseInput it receives and returns a canned
// response, so tests can assert on the actual request without AWS access.
type fakeBedrock struct {
	input *bedrockruntime.ConverseInput
	out   *bedrockruntime.ConverseOutput
	err   error
}

func (f *fakeBedrock) Converse(_ context.Context, in *bedrockruntime.ConverseInput, _ ...func(*bedrockruntime.Options)) (*bedrockruntime.ConverseOutput, error) {
	f.input = in
	return f.out, f.err
}

func textResponse(text string) *bedrockruntime.ConverseOutput {
	return &bedrockruntime.ConverseOutput{
		Output: &types.ConverseOutputMemberMessage{
			Value: types.Message{
				Role: types.ConversationRoleAssistant,
				Content: []types.ContentBlock{
					&types.ContentBlockMemberText{Value: text},
				},
			},
		},
	}
}

func TestBedrockChat(t *testing.T) {
	t.Run("sends configured model and prompt", func(t *testing.T) {
		fake := &fakeBedrock{out: textResponse("explanation")}
		c := &Client{provider: "bedrock", model: "eu.anthropic.claude-3-haiku-20240307-v1:0", maxTokens: 2048, bedrockClient: fake}

		resp, err := c.Chat(context.Background(), "why is this nodepool overprovisioned?")

		require.NoError(t, err)
		assert.Equal(t, "explanation", resp)
		require.NotNil(t, fake.input)
		require.NotNil(t, fake.input.ModelId)
		assert.Equal(t, "eu.anthropic.claude-3-haiku-20240307-v1:0", *fake.input.ModelId)
		require.Len(t, fake.input.Messages, 1)
		assert.Equal(t, types.ConversationRoleUser, fake.input.Messages[0].Role)
		require.Len(t, fake.input.Messages[0].Content, 1)
		text, ok := fake.input.Messages[0].Content[0].(*types.ContentBlockMemberText)
		require.True(t, ok, "first content block should be text")
		assert.Equal(t, "why is this nodepool overprovisioned?", text.Value)
		require.NotNil(t, fake.input.InferenceConfig)
		require.NotNil(t, fake.input.InferenceConfig.MaxTokens)
		assert.Equal(t, int32(2048), *fake.input.InferenceConfig.MaxTokens)
	})

	t.Run("omits inference config when maxTokens is unset", func(t *testing.T) {
		fake := &fakeBedrock{out: textResponse("ok")}
		c := &Client{provider: "bedrock", model: "some-model", bedrockClient: fake}

		_, err := c.Chat(context.Background(), "hello")

		require.NoError(t, err)
		assert.Nil(t, fake.input.InferenceConfig)
	})

	t.Run("requires model even without a client", func(t *testing.T) {
		c := &Client{provider: "bedrock"}

		_, err := c.Chat(context.Background(), "hello")

		assert.ErrorContains(t, err, "LLM_MODEL")
	})

	t.Run("wraps API errors", func(t *testing.T) {
		fake := &fakeBedrock{err: errors.New("AccessDeniedException")}
		c := &Client{provider: "bedrock", model: "some-model", bedrockClient: fake}

		_, err := c.Chat(context.Background(), "hello")

		assert.ErrorContains(t, err, "bedrock request failed")
		assert.ErrorContains(t, err, "AccessDeniedException")
	})

	t.Run("rejects empty response content", func(t *testing.T) {
		fake := &fakeBedrock{out: &bedrockruntime.ConverseOutput{
			Output: &types.ConverseOutputMemberMessage{Value: types.Message{}},
		}}
		c := &Client{provider: "bedrock", model: "some-model", bedrockClient: fake}

		_, err := c.Chat(context.Background(), "hello")

		assert.ErrorContains(t, err, "no text content")
	})
}
