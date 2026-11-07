// Cost per million tokens for a served model, and what a hosted API would
// charge for the same traffic. Everything here is an estimate built from the
// backend's per-replica `cost` (node price x share of the node's GPUs) and
// `hostedPrice` (OpenRouter list price); the UI shows the inputs with it.

const sum = (values) => values.reduce((a, b) => a + b, 0);

// formatMoney renders an amount with the currency's symbol and a precision
// that suits small per-token figures: $1,234 · $12.40 · $0.42 · $0.042.
export function formatMoney(value, currency = 'USD') {
  if (value == null || !Number.isFinite(value)) return '–';
  const symbol = currency === 'CNY' ? 'CN¥' : '$';
  const abs = Math.abs(value);
  let text;
  if (abs >= 100) text = Math.round(value).toLocaleString('en-US');
  else if (abs >= 1) text = value.toFixed(2);
  else if (abs === 0) text = '0';
  else text = value.toPrecision(2);
  return `${symbol}${text}`;
}

// modelCost works out a model's self-hosted cost from its replicas:
//   { costPerHour, perMTok, tokensPerSec, currency, replicas: [...inputs],
//     hosted: { model, inputPerMTok, outputPerMTok, blendedPerMTok,
//               promptShare } | null,
//     unknown: null | 'unpriced' | 'no-traffic' }
// A model is only priced when every replica is: a partial sum would
// understate the cost. perMTok needs live traffic (tokens/s > 0). The hosted
// figure is blended by this model's own input/output mix when the replicas
// report it, and is in USD (OpenRouter's currency).
export function modelCost(replicas) {
  const priced = replicas.filter((p) => p.cost);
  const hostedPrice = replicas.find((p) => p.hostedPrice)?.hostedPrice || null;
  const online = replicas.filter((p) => p.online);
  const tokensPerSec = sum(online.map((p) => p.tokensPerSec || 0));
  const prompt = sum(online.map((p) => p.promptTokensPerSec || 0));
  const generation = sum(online.map((p) => p.generationTokensPerSec || 0));

  let hosted = null;
  if (hostedPrice) {
    const mixKnown = prompt + generation > 0;
    hosted = {
      model: hostedPrice.model,
      inputPerMTok: hostedPrice.inputPerMTok,
      outputPerMTok: hostedPrice.outputPerMTok,
      promptShare: mixKnown ? prompt / (prompt + generation) : null,
      blendedPerMTok: mixKnown
        ? (prompt * hostedPrice.inputPerMTok + generation * hostedPrice.outputPerMTok) / (prompt + generation)
        : null,
    };
  }

  if (replicas.length === 0 || priced.length < replicas.length) {
    return { costPerHour: null, perMTok: null, tokensPerSec, currency: null, replicas: [], hosted, unknown: 'unpriced' };
  }

  const costPerHour = sum(priced.map((p) => p.cost.costPerHour));
  const currency = priced[0].cost.currency || 'USD';
  const inputs = priced.map((p) => ({
    key: `${p.namespace}/${p.name}`,
    costPerHour: p.cost.costPerHour,
    nodeCostPerHour: p.cost.nodeCostPerHour,
    instanceType: p.nodeInstanceType,
    capacityType: p.cost.nodeCapacityType,
    share: p.cost.share,
    shareBasis: p.cost.shareBasis,
    priceSource: p.cost.priceSource,
  }));
  const perMTok = tokensPerSec > 0 ? (costPerHour / (tokensPerSec * 3600)) * 1e6 : null;
  return {
    costPerHour,
    perMTok,
    tokensPerSec,
    currency,
    replicas: inputs,
    hosted,
    unknown: perMTok == null ? 'no-traffic' : null,
  };
}

// comparison says how self-hosting compares with the hosted price, e.g.
// { ratio: 0.4, cheaper: true } = self-hosted costs 40% of hosted. null when
// either side is missing or the currencies differ (hosted prices are USD).
export function comparison(cost) {
  if (!cost || cost.perMTok == null || !cost.hosted || cost.hosted.blendedPerMTok == null) return null;
  if (cost.currency !== 'USD' || cost.hosted.blendedPerMTok <= 0) return null;
  const ratio = cost.perMTok / cost.hosted.blendedPerMTok;
  return { ratio, cheaper: ratio < 1 };
}

const SHARE_BASIS_TEXT = {
  'gpu-memory': 'of the node’s GPU memory',
  'gpu-count': 'of the node’s GPUs',
};

const SOURCE_TEXT = {
  'aws-pricing-api': 'AWS price list',
  hardcoded: 'built-in price snapshot',
  'regional-fallback': 'regional price snapshot',
  'family-estimate': 'instance-family estimate',
};

// costInputsText explains a model's estimate line by line, for a tooltip.
export function costInputsText(cost) {
  if (!cost || cost.unknown === 'unpriced') {
    return 'Not every replica could be priced (no instance type, an unknown price, or no GPU request to apportion), so no total is shown.';
  }
  const lines = cost.replicas.map((r) => {
    const spot = r.capacityType === 'spot' ? ' (spot ≈ 25% of on-demand)' : '';
    return `${r.key}: ${formatMoney(r.costPerHour, cost.currency)}/h = ${Math.round(r.share * 100)}% ${SHARE_BASIS_TEXT[r.shareBasis] || ''} × ${r.instanceType} at ${formatMoney(r.nodeCostPerHour, cost.currency)}/h${spot}, ${SOURCE_TEXT[r.priceSource] || r.priceSource}`;
  });
  lines.push(`Total ${formatMoney(cost.costPerHour, cost.currency)}/h over ${Math.round(cost.tokensPerSec)} tokens/s (input + output, right now).`);
  if (cost.hosted) {
    const mix =
      cost.hosted.promptShare == null
        ? 'input/output mix unknown'
        : `${Math.round(cost.hosted.promptShare * 100)}% input`;
    lines.push(
      `Hosted: ${cost.hosted.model} on OpenRouter, ${formatMoney(cost.hosted.inputPerMTok)} in / ${formatMoney(cost.hosted.outputPerMTok)} out per 1M tokens (${mix}).`,
    );
  }
  lines.push('GPU share only: CPU, memory, storage and idle capacity are not counted.');
  return lines.join('\n');
}
