package ollama

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime/types"
)

type Client struct {
	baseURL    string
	httpClient *http.Client
	model      string
	provider   string // "ollama", "litellm" or "bedrock"
	apiKey     string // Optional API key for LiteLLM
	awsRegion  string // Optional AWS region override for Bedrock
	maxTokens  int32  // Response token cap for Bedrock (0 = model default)
	debug      bool   // Enable debug logging
	// Bedrock provider state (nil unless provider == "bedrock")
	bedrockClient bedrockAPI
	bedrockErr    error
}

// bedrockAPI is the subset of the Bedrock Runtime client used by this
// package, extracted as an interface so tests can substitute a fake.
type bedrockAPI interface {
	Converse(ctx context.Context, params *bedrockruntime.ConverseInput, optFns ...func(*bedrockruntime.Options)) (*bedrockruntime.ConverseOutput, error)
}

type ChatRequest struct {
	Model    string    `json:"model"`
	Messages []Message `json:"messages"`
	Stream   bool      `json:"stream"`
}

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type ChatResponse struct {
	Model              string  `json:"model"`
	CreatedAt          string  `json:"created_at"`
	Message            Message `json:"message"`
	Done               bool    `json:"done"`
	TotalDuration      int64   `json:"total_duration"`
	LoadDuration       int64   `json:"load_duration"`
	PromptEvalCount    int     `json:"prompt_eval_count"`
	PromptEvalDuration int64   `json:"prompt_eval_duration"`
	EvalCount          int     `json:"eval_count"`
	EvalDuration       int64   `json:"eval_duration"`
}

// NewClient creates a new LLM client supporting Ollama, LiteLLM and AWS Bedrock
// provider: "ollama", "litellm" or "bedrock" (default: "ollama"; "bedrock" is
// never auto-detected and must be set explicitly)
// apiKey: Optional API key for LiteLLM authentication (unused for Bedrock,
// which signs requests with the AWS default credential chain)
// awsRegion: Optional AWS region override for Bedrock (unused otherwise)
// maxTokens: Response token cap for Bedrock, 0 = model default (unused otherwise)
// debug: Enable debug logging
func NewClient(baseURL, model, provider, apiKey, awsRegion string, maxTokens int, debug bool) *Client {
	if baseURL == "" {
		baseURL = "http://localhost:11434"
	}
	if model == "" && provider != "bedrock" {
		model = "gemma3:1b" // Default model
	}
	if provider == "" {
		// Auto-detect provider from URL
		baseURLLower := strings.ToLower(baseURL)
		if strings.Contains(baseURLLower, "/v1/chat/completions") ||
			strings.Contains(baseURLLower, "litellm") ||
			strings.Contains(baseURLLower, "openai") ||
			strings.Contains(baseURLLower, "vllm") {
			provider = "litellm"
		} else {
			provider = "ollama"
		}
	}

	client := &Client{
		baseURL: baseURL,
		httpClient: &http.Client{
			Timeout: 120 * time.Second, // Longer timeout for LLM
		},
		model:     model,
		provider:  provider,
		apiKey:    apiKey,
		awsRegion: awsRegion,
		maxTokens: int32(maxTokens),
		debug:     debug,
	}

	if provider == "bedrock" {
		client.initBedrock()
	}

	if debug {
		log.Printf("[LLM] Initialized client: provider=%s, url=%s, model=%s", provider, baseURL, model)
	}

	return client
}

// initBedrock creates the Bedrock Runtime client using the AWS default
// credential chain (env keys, IRSA/web identity, instance profile, ...),
// so no API key is needed. The region comes from the standard AWS
// env/config; awsRegion (LLM_AWS_REGION) overrides it for setups where
// Bedrock lives in a different region than the cluster.
func (c *Client) initBedrock() {
	if c.model == "" {
		log.Printf("[LLM] Warning: LLM_MODEL is not set; Bedrock requests will fail until a model or inference profile ID is configured")
	}
	var opts []func(*config.LoadOptions) error
	if c.awsRegion != "" {
		opts = append(opts, config.WithRegion(c.awsRegion))
	}
	awsCfg, err := config.LoadDefaultConfig(context.Background(), opts...)
	if err != nil {
		c.bedrockErr = fmt.Errorf("failed to load AWS config for Bedrock: %w", err)
		log.Printf("[LLM] %v", c.bedrockErr)
		return
	}
	c.bedrockClient = bedrockruntime.NewFromConfig(awsCfg)
	if c.debug {
		log.Printf("[LLM] Bedrock client initialized: region=%s, model=%s", awsCfg.Region, c.model)
	}
}

// LiteLLMChatRequest is the OpenAI-compatible request format for LiteLLM
type LiteLLMChatRequest struct {
	Model    string    `json:"model"`
	Messages []Message `json:"messages"`
	Stream   bool      `json:"stream,omitempty"`
}

// LiteLLMChatResponse is the OpenAI-compatible response format for LiteLLM
type LiteLLMChatResponse struct {
	ID      string `json:"id"`
	Object  string `json:"object"`
	Created int64  `json:"created"`
	Model   string `json:"model"`
	Choices []struct {
		Index        int     `json:"index"`
		Message      Message `json:"message"`
		FinishReason string  `json:"finish_reason"`
	} `json:"choices"`
	Usage struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
		TotalTokens      int `json:"total_tokens"`
	} `json:"usage"`
}

func (c *Client) Chat(ctx context.Context, prompt string) (string, error) {
	if c.provider == "bedrock" {
		return c.chatBedrock(ctx, prompt)
	}

	var url string
	var reqBody interface{}

	// Determine endpoint and request format based on provider
	if c.provider == "litellm" {
		// LiteLLM uses OpenAI-compatible format
		// Remove /v1/chat/completions from URL if present (we'll add it)
		baseURL := strings.TrimSuffix(c.baseURL, "/v1/chat/completions")
		baseURL = strings.TrimSuffix(baseURL, "/")
		url = fmt.Sprintf("%s/v1/chat/completions", baseURL)

		reqBody = LiteLLMChatRequest{
			Model: c.model,
			Messages: []Message{
				{
					Role:    "user",
					Content: prompt,
				},
			},
			Stream: false,
		}

		if c.debug {
			log.Printf("[LLM] Sending LiteLLM request to %s with model %s", url, c.model)
			log.Printf("[LLM] Prompt length: %d characters", len(prompt))
		}
	} else {
		// Ollama format
		url = fmt.Sprintf("%s/api/chat", c.baseURL)
		reqBody = ChatRequest{
			Model: c.model,
			Messages: []Message{
				{
					Role:    "user",
					Content: prompt,
				},
			},
			Stream: false,
		}

		if c.debug {
			log.Printf("[LLM] Sending Ollama request to %s with model %s", url, c.model)
			log.Printf("[LLM] Prompt length: %d characters", len(prompt))
		}
	}

	jsonData, err := json.Marshal(reqBody)
	if err != nil {
		return "", fmt.Errorf("failed to marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewBuffer(jsonData))
	if err != nil {
		return "", fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")

	// Add API key for LiteLLM if provided
	if c.provider == "litellm" && c.apiKey != "" {
		req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", c.apiKey))
		if c.debug {
			log.Printf("[LLM] Added Authorization header with API key")
		}
	}

	startTime := time.Now()
	resp, err := c.httpClient.Do(req)
	duration := time.Since(startTime)

	if err != nil {
		if c.debug {
			log.Printf("[LLM] Request failed after %v: %v", duration, err)
		}
		return "", fmt.Errorf("failed to execute request: %w", err)
	}
	defer func() {
		_ = resp.Body.Close() // Ignore close errors
	}()

	if c.debug {
		log.Printf("[LLM] Response received in %v with status %d", duration, resp.StatusCode)
	}

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		errorMsg := fmt.Sprintf("%s request failed with status %d: %s", c.provider, resp.StatusCode, string(body))
		if c.debug {
			log.Printf("[LLM] %s", errorMsg)
		}
		return "", errors.New(errorMsg)
	}

	// Read the response body first so we can log it if parsing fails
	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		if c.debug {
			log.Printf("[LLM] Failed to read response body: %v", err)
		}
		return "", fmt.Errorf("failed to read response body: %w", err)
	}

	// Parse response based on provider
	if c.provider == "litellm" {
		var chatResp LiteLLMChatResponse
		if err := json.Unmarshal(bodyBytes, &chatResp); err != nil {
			// Log the actual response for debugging
			bodyStr := string(bodyBytes)
			if c.debug {
				log.Printf("[LLM] Failed to decode LiteLLM response: %v", err)
				log.Printf("[LLM] Response body (first 500 chars): %s", truncateString(bodyStr, 500))
				log.Printf("[LLM] Response Content-Type: %s", resp.Header.Get("Content-Type"))
			}
			// If response looks like HTML/XML, provide a more helpful error
			if strings.HasPrefix(strings.TrimSpace(bodyStr), "<") {
				return "", fmt.Errorf("received HTML/XML response instead of JSON (status 200). This may indicate the endpoint path is incorrect or the service returned an error page. Response preview: %s", truncateString(bodyStr, 200))
			}
			return "", fmt.Errorf("failed to decode response: %w. Response preview: %s", err, truncateString(bodyStr, 200))
		}

		if len(chatResp.Choices) == 0 {
			return "", fmt.Errorf("no choices in LiteLLM response")
		}

		content := chatResp.Choices[0].Message.Content
		if c.debug {
			log.Printf("[LLM] LiteLLM response received: %d tokens used, response length: %d characters",
				chatResp.Usage.TotalTokens, len(content))
		}

		return content, nil
	} else {
		// Ollama format
		var chatResp ChatResponse
		if err := json.Unmarshal(bodyBytes, &chatResp); err != nil {
			bodyStr := string(bodyBytes)
			if c.debug {
				log.Printf("[LLM] Failed to decode Ollama response: %v", err)
				log.Printf("[LLM] Response body (first 500 chars): %s", truncateString(bodyStr, 500))
			}
			return "", fmt.Errorf("failed to decode response: %w. Response preview: %s", err, truncateString(bodyStr, 200))
		}

		content := chatResp.Message.Content
		if c.debug {
			log.Printf("[LLM] Ollama response received: response length: %d characters", len(content))
		}

		return content, nil
	}
}

// chatBedrock sends the prompt via the Bedrock Converse API. Requests are
// signed with SigV4, so it works with IAM roles (e.g. IRSA on EKS) and needs
// neither an API key nor an endpoint URL.
func (c *Client) chatBedrock(ctx context.Context, prompt string) (string, error) {
	// Check configuration before client state so a missing model is reported
	// even when AWS config loading failed too.
	if c.model == "" {
		return "", errors.New("LLM_MODEL must be set to a Converse-compatible Bedrock model ID or inference profile ID")
	}
	if c.bedrockClient == nil {
		if c.bedrockErr != nil {
			return "", c.bedrockErr
		}
		return "", errors.New("bedrock client is not initialized")
	}

	if c.debug {
		log.Printf("[LLM] Sending Bedrock Converse request with model %s", c.model)
		log.Printf("[LLM] Prompt length: %d characters", len(prompt))
	}

	input := &bedrockruntime.ConverseInput{
		ModelId: aws.String(c.model),
		Messages: []types.Message{
			{
				Role: types.ConversationRoleUser,
				Content: []types.ContentBlock{
					&types.ContentBlockMemberText{Value: prompt},
				},
			},
		},
	}
	// Without an explicit cap Converse defaults to the model's maximum output
	// length, which makes the worst-case cost per request unbounded.
	if c.maxTokens > 0 {
		input.InferenceConfig = &types.InferenceConfiguration{
			MaxTokens: aws.Int32(c.maxTokens),
		}
	}

	startTime := time.Now()
	resp, err := c.bedrockClient.Converse(ctx, input)
	duration := time.Since(startTime)
	if err != nil {
		if c.debug {
			log.Printf("[LLM] Bedrock request failed after %v: %v", duration, err)
		}
		return "", fmt.Errorf("bedrock request failed: %w", err)
	}

	output, ok := resp.Output.(*types.ConverseOutputMemberMessage)
	if !ok {
		return "", fmt.Errorf("unexpected Bedrock response type %T", resp.Output)
	}

	var sb strings.Builder
	for _, block := range output.Value.Content {
		if text, ok := block.(*types.ContentBlockMemberText); ok {
			sb.WriteString(text.Value)
		}
	}
	content := sb.String()
	if content == "" {
		return "", errors.New("no text content in Bedrock response")
	}

	if c.debug {
		var totalTokens int32
		if resp.Usage != nil && resp.Usage.TotalTokens != nil {
			totalTokens = *resp.Usage.TotalTokens
		}
		log.Printf("[LLM] Bedrock response received in %v: %d tokens used, response length: %d characters",
			duration, totalTokens, len(content))
	}

	return content, nil
}

// truncateString truncates a string to a maximum length, adding "..." if truncated
func truncateString(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}
