// Joins the LiteLLM gateway to the model servers behind it, for the
// operator panels: deployment state (Prometheus) next to each backend's
// vLLM/sglang replicas (/serving), and a gateway line on Serving model rows
// (/serving/gateway). Pure so it is tested on its own.

// LiteLLM provider prefixes on model names ("hosted_vllm/meta-llama/…").
const PROVIDERS = new Set([
  'hosted_vllm',
  'vllm',
  'openai',
  'custom_openai',
  'text-completion-openai',
  'sglang',
  'ollama',
  'ollama_chat',
  'huggingface',
  'together_ai',
  'azure',
  'bedrock',
  'vertex_ai',
  'anthropic',
]);

// normalizeModel lowercases a model name and drops a LiteLLM provider prefix.
export function normalizeModel(name) {
  if (!name) return '';
  const lower = String(name).trim().toLowerCase();
  const slash = lower.indexOf('/');
  if (slash > 0 && PROVIDERS.has(lower.slice(0, slash))) return lower.slice(slash + 1);
  return lower;
}

const lastSegment = (n) => n.slice(n.lastIndexOf('/') + 1);

// sameModel: equal once normalized, or the same name after the last "/"
// ("meta-llama/Llama-3.3-70B-Instruct" vs "Llama-3.3-70B-Instruct").
export function sameModel(a, b) {
  const x = normalizeModel(a);
  const y = normalizeModel(b);
  if (!x || !y) return false;
  return x === y || lastSegment(x) === lastSegment(y);
}

export const DEPLOYMENT_STATES = {
  0: { label: 'Healthy', tone: '' },
  1: { label: 'Partial outage', tone: 'warn' },
  2: { label: 'Outage', tone: 'bad' },
};

export function deploymentState(state) {
  return DEPLOYMENT_STATES[Math.round(state)] || { label: 'Unknown', tone: '' };
}

// deploymentRows pairs each LiteLLM deployment with the serving model group
// (from groupByModel) it routes to, when one runs in the cluster.
export function deploymentRows(deployments = [], groups = []) {
  return deployments.map((d) => ({
    ...d,
    ...deploymentState(d.state),
    serving: groups.find((g) => sameModel(d.model, g.model)) || null,
  }));
}

// fallbackShare is the share of requests to a model alias that needed a
// fallback, as a percentage (null without requests or fallback data).
export function fallbackShare(m) {
  if (!m?.requests || m.fallbacks == null) return null;
  return (m.fallbacks / m.requests) * 100;
}

const realName = (x) => x.name && x.name !== '(unattributed)';

// gatewayLineFor finds the live gateway model a served model is reached
// through, and sums it up: {model, teams, apps, requestsPerSec, errorRatePct}.
// null when the model is not behind the gateway (or there is no gateway).
export function gatewayLineFor(servedModel, gateway) {
  const m = gateway?.models?.find((x) => sameModel(x.model, servedModel));
  if (!m) return null;
  return {
    model: m.model,
    teams: (m.teams || []).filter(realName).length,
    apps: (m.apps || []).filter(realName).length,
    requestsPerSec: m.requestsPerSec ?? null,
    errorRatePct: m.errorRatePct ?? null,
  };
}
