// A LiteLLM routing answer (/serving/gateway/routing) for tests: four
// self-hosted groups, one of them a wildcard, falling back to an external
// API, with an alias, a second-choice fallback nobody took and one group
// with none.
export const routing = {
  source: { namespace: 'llm', configMap: 'litellm-config', key: 'config.yaml' },
  fetchedAt: '2026-11-23T12:00:00Z',
  config: {
    groups: [
      { name: 'acme/*', wildcard: true, deployments: [{ model: 'hosted_vllm/*', provider: 'hosted_vllm', apiBase: 'https://vllm.acme.example/v1' }] },
      {
        name: 'acme/small',
        deployments: [
          { model: 'hosted_vllm/Qwen/Small', provider: 'hosted_vllm', apiBase: 'https://vllm.acme.example/v1' },
          { model: 'hosted_vllm/Qwen/Small', provider: 'hosted_vllm', apiBase: 'https://vllm-b.acme.example/v1' },
        ],
      },
      { name: 'acme/large', deployments: [{ model: 'hosted_vllm/Qwen/Large', provider: 'hosted_vllm', apiBase: 'https://vllm.acme.example/v1' }] },
      { name: 'acme/embed', deployments: [{ model: 'hosted_vllm/Qwen/Embed', provider: 'hosted_vllm', apiBase: 'https://vllm.acme.example/v1' }] },
      { name: 'together/small', deployments: [{ model: 'openai/Qwen/Small', provider: 'openai', apiBase: 'https://api.together.xyz/v1/' }] },
      { name: 'bedrock/haiku', deployments: [{ model: 'bedrock/us.anthropic.claude-haiku', provider: 'bedrock' }] },
    ],
    aliases: [
      { name: 'acme/old-small', target: 'acme/small' },
      { name: 'acme/broken', target: 'nowhere/model' },
      { name: 'acme/old-embed', target: 'acme/embed', hidden: true },
    ],
    fallbacks: [
      { from: 'acme/small', to: ['together/small', 'bedrock/haiku'], kind: 'general' },
      { from: 'acme/large', to: ['together/small'], kind: 'general' },
      { from: 'acme/large', to: ['acme/small'], kind: 'context_window' },
    ],
    settings: { numRetries: 0, allowedFails: 60, cooldownSeconds: 5, timeoutSeconds: 60, streamTimeoutSeconds: 120 },
    issues: [
      { severity: 'warn', kind: 'no-fallback', text: '1 model group has no fallback: when its deployments fail, the request fails.', subjects: ['acme/embed'] },
      { severity: 'error', kind: 'unknown-alias-target', text: 'Alias acme/broken points to "nowhere/model", which is not in model_list: requests for it fail.', subjects: ['acme/broken'] },
    ],
  },
  observed: {
    range: '7d',
    from: '2026-11-16T12:00:00Z',
    to: '2026-11-23T12:00:00Z',
    requests: { 'acme/small': 8000, 'acme/old-small': 2000, 'acme/large': 500 },
    fallbacks: [
      {
        from: 'acme/small',
        to: 'together/small',
        succeeded: 1000,
        failed: 0,
        reasons: [
          { reason: 'RouterRateLimitError', status: '429', succeeded: 600, failed: 0 },
          { reason: 'Hosted_vllm.ServiceUnavailableError', status: '503', succeeded: 400, failed: 0 },
        ],
      },
      { from: 'acme/old-small', to: 'together/small', succeeded: 20, failed: 0, reasons: [{ reason: 'RouterRateLimitError', status: '429', succeeded: 20, failed: 0 }] },
      {
        from: 'acme/large',
        to: 'together/small',
        succeeded: 36,
        failed: 5,
        reasons: [{ reason: 'Hosted_vllm.ContextWindowExceededError', status: '400', succeeded: 36, failed: 5 }],
      },
    ],
  },
};
