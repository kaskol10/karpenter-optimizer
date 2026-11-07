// Gateway flow: who sends what to which model, for the Gateway page's flow
// (Sankey) view. Sources are the values of the Split-by dimension (apps,
// API keys or teams), targets are models, and each link is the tokens or
// spend that source sent to that model, read from the per-model breakdown
// /serving/gateway returns (models[].apps / .apiKeys / .teams).
//
// Small flows are folded into "Other" nodes on each side so the chart stays
// readable however many apps or models there are.

const METRIC_FIELD = { tokens: 'tokensTotal', spend: 'spend' };

// otherLabel is the folded node's name ("3 other apps").
function otherLabel(count, noun) {
  return `${count} other ${noun}${count === 1 ? '' : 's'}`;
}

// rank sorts names by total, largest first, then by name.
function rank(totals) {
  return [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name);
}

// buildFlow returns {nodes, links, total, sources, targets, folded}:
//   nodes:   [{name, side: 'source'|'target', total, other?}] sources first,
//            each side largest first with its "Other" node last
//   links:   [{source, target, value}] node indexes, value > 0, largest first
//   total:   sum of every link
//   folded:  {sources, targets} how many names went into "Other"
// dimField is the per-model breakdown field ('apps' | 'apiKeys' | 'teams'),
// noun names one source ("app", "API key", "team").
export function buildFlow(gateway, { dimField = 'apps', noun = 'app', metric = 'tokens', maxSources = 8, maxTargets = 8 } = {}) {
  const field = METRIC_FIELD[metric] || METRIC_FIELD.tokens;
  const raw = [];
  (gateway?.models || []).forEach((m) => {
    (m[dimField] || []).forEach((row) => {
      const value = Number(row[field]) || 0;
      if (value > 0) raw.push({ source: row.name, target: m.model, value });
    });
  });

  const sourceTotals = new Map();
  const targetTotals = new Map();
  raw.forEach(({ source, target, value }) => {
    sourceTotals.set(source, (sourceTotals.get(source) || 0) + value);
    targetTotals.set(target, (targetTotals.get(target) || 0) + value);
  });

  // Keep the top N-1 when folding, so "Other" takes the last slot.
  const keep = (names, max) => (names.length > max ? new Set(names.slice(0, Math.max(1, max - 1))) : new Set(names));
  const sourceNames = rank(sourceTotals);
  const targetNames = rank(targetTotals);
  const keptSources = keep(sourceNames, maxSources);
  const keptTargets = keep(targetNames, maxTargets);
  const otherSource = otherLabel(sourceNames.length - keptSources.size, noun);
  const otherTarget = otherLabel(targetNames.length - keptTargets.size, 'model');

  const merged = new Map();
  raw.forEach(({ source, target, value }) => {
    const s = keptSources.has(source) ? source : otherSource;
    const t = keptTargets.has(target) ? target : otherTarget;
    const key = `${s}\u0000${t}`;
    merged.set(key, { source: s, target: t, value: (merged.get(key)?.value || 0) + value });
  });

  const nodes = [];
  const index = new Map();
  const addNode = (name, side, other = false) => {
    index.set(`${side}:${name}`, nodes.length);
    nodes.push({ name, side, total: 0, ...(other ? { other: true } : {}) });
  };
  sourceNames.filter((n) => keptSources.has(n)).forEach((n) => addNode(n, 'source'));
  if (keptSources.size < sourceNames.length) addNode(otherSource, 'source', true);
  targetNames.filter((n) => keptTargets.has(n)).forEach((n) => addNode(n, 'target'));
  if (keptTargets.size < targetNames.length) addNode(otherTarget, 'target', true);

  const links = [...merged.values()]
    .map(({ source, target, value }) => ({ source: index.get(`source:${source}`), target: index.get(`target:${target}`), value }))
    .sort((a, b) => b.value - a.value);
  links.forEach((l) => {
    nodes[l.source].total += l.value;
    nodes[l.target].total += l.value;
  });

  return {
    nodes,
    links,
    total: links.reduce((sum, l) => sum + l.value, 0),
    folded: { sources: sourceNames.length - keptSources.size, targets: targetNames.length - keptTargets.size },
  };
}

// topFlows lists the largest links as text rows: [{from, to, value, share}].
export function topFlows(flow, limit = 5) {
  return flow.links.slice(0, limit).map((l) => ({
    from: flow.nodes[l.source].name,
    to: flow.nodes[l.target].name,
    value: l.value,
    share: flow.total ? l.value / flow.total : 0,
  }));
}
