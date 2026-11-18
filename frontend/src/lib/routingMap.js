// The Gateway routing map: who calls which alias, which deployment serves
// it and where that runs, built from the dashboard's `routes` (one row per
// caller → alias → model group → deployment path, from LiteLLM's
// deployment success/failure counters), `deployments` (state now), `teams`
// (429s, budget) and the cluster's serving groups. Pure so it is tested on
// its own; RoutingMap.jsx only draws it.

import { normalizeModel, sameModel } from './gatewayOperator';

export const COLUMNS = ['Callers', 'Aliases', 'Deployments', 'Runs on'];
export const MAX_PER_COLUMN = 12;

// Providers that are someone else's API, not a server you run.
const EXTERNAL = new Set([
  'together_ai',
  'together',
  'anthropic',
  'bedrock',
  'vertex_ai',
  'azure',
  'azure_ai',
  'gemini',
  'groq',
  'mistral',
  'deepinfra',
  'fireworks_ai',
  'openrouter',
  'cohere',
  'perplexity',
]);
const PUBLIC_HOSTS = /(^|\.)(openai\.com|together\.xyz|together\.ai|anthropic\.com|mistral\.ai|groq\.com|openrouter\.ai)$/;

const NO_TEAM = new Set(['', 'None', 'none', 'null']);
export const isNoTeam = (team) => NO_TEAM.has(team ?? '');

export function hostOf(apiBase) {
  if (!apiBase) return '';
  const plain = String(apiBase).replace(/^\w+:\/\//, '').split('/')[0];
  try {
    return new URL(apiBase).host || plain;
  } catch {
    return plain;
  }
}

const isExternal = (provider, apiBase) => {
  const host = hostOf(apiBase);
  if (host) return PUBLIC_HOSTS.test(host) || EXTERNAL.has(provider);
  return EXTERNAL.has(provider) || provider === 'openai';
};

// aliasOwners finds the companies aliases are namespaced under
// ("empathyai/Qwen/Qwen3.5-9B" → empathyai). An owner is the first segment
// of an alias with three or more segments (company/org/model), or a first
// segment every alias shares; a two-segment alias like "Qwen/Qwen3.5-9B"
// is a Hugging Face org/model and has no owner unless its first segment is
// a known owner.
export function aliasOwners(aliases) {
  const list = aliases.filter(Boolean);
  const owners = new Set();
  list.forEach((a) => {
    const parts = a.split('/');
    if (parts.length >= 3 && parts[0]) owners.add(parts[0]);
  });
  if (list.length >= 2) {
    const first = list[0].split('/')[0];
    if (list.every((a) => a.includes('/') && a.split('/')[0] === first && a.length > first.length + 1)) owners.add(first);
  }
  return owners;
}

// splitAlias returns {owner, model} for an alias given the known owners.
export function splitAlias(alias, owners) {
  const i = alias.indexOf('/');
  if (i > 0 && owners.has(alias.slice(0, i))) return { owner: alias.slice(0, i), model: alias.slice(i + 1) };
  return { owner: '', model: alias };
}

const errorShare = (ok, fail) => (ok + fail > 0 ? (fail / (ok + fail)) * 100 : null);

function fact(requests, failures) {
  const total = requests + failures;
  const err = errorShare(requests, failures);
  const n = total >= 1e6 ? `${(total / 1e6).toFixed(1)}M` : total >= 1e3 ? `${(total / 1e3).toFixed(1)}k` : `${Math.round(total)}`;
  return err != null && err >= 1 ? `${n} req · ${err.toFixed(1)}% err` : `${n} req`;
}

const errTone = (err) => (err == null ? '' : err >= 5 ? 'bad' : err >= 1 ? 'warn' : '');

// runsOnFor finds where a deployment runs: the serving group in this
// cluster it matches, else its host (outside this cluster, or an external
// API).
function runsOnFor(route, groups) {
  const g = groups.find((x) => sameModel(route.deployment, x.model));
  if (g) return { id: `r:s:${g.model}`, kind: 'cluster', group: g };
  const host = hostOf(route.apiBase) || route.provider || 'unknown';
  const kind = isExternal(route.provider, route.apiBase) ? 'external' : 'outside';
  return { id: `r:h:${host}`, kind, host };
}

const deploymentId = (dep, base) => `d:${dep}|${base || ''}`;

// buildRoutingMap returns {columns: [[node…]×4], links, routes, owners}.
// Each route carries `path`, its four node ids, so a selection can light up
// every path through a node. byKey splits callers into API keys; idle adds
// deployments with no traffic (only meaningful without filters).
export function buildRoutingMap({ routes = [], deployments = [], teams = [], groups = [] }, { byKey = false, idle = false } = {}) {
  const nodes = new Map();
  const node = (id, col, init) => {
    if (!nodes.has(id)) nodes.set(id, { id, col, requests: 0, failures: 0, flags: [], ...init });
    return nodes.get(id);
  };
  const stateOf = new Map(deployments.map((d) => [deploymentId(d.model, d.apiBase), d.state]));
  const teamStat = new Map(teams.map((t) => [t.team, t]));

  const paths = routes.map((r) => {
    const teamLabel = isNoTeam(r.team) ? 'No team' : r.team;
    const callerId = byKey ? `c:${r.team}/${r.key}` : `c:${r.team}`;
    node(callerId, 0, { kind: byKey ? 'key' : 'team', team: r.team, key: byKey ? r.key : null, label: byKey ? r.key || 'No key' : teamLabel, sub: byKey ? teamLabel : null });
    node(`a:${r.alias}`, 1, { kind: 'alias', alias: r.alias, label: r.alias });
    const depId = deploymentId(r.deployment, r.apiBase);
    node(depId, 2, { kind: 'deployment', deployment: r.deployment, apiBase: r.apiBase, provider: r.provider, label: r.deployment, sub: hostOf(r.apiBase) });
    const run = runsOnFor(r, groups);
    node(run.id, 3, { kind: run.kind, group: run.group || null, host: run.host || null });
    const fallback = Boolean(r.modelGroup) && r.modelGroup !== r.alias;
    return { ...r, fallback, path: [callerId, `a:${r.alias}`, depId, run.id] };
  });

  if (idle) {
    deployments.forEach((d) => {
      const id = deploymentId(d.model, d.apiBase);
      if (!nodes.has(id)) node(id, 2, { kind: 'deployment', deployment: d.model, apiBase: d.apiBase, provider: d.provider, label: d.model, sub: hostOf(d.apiBase), idle: true });
    });
  }

  paths.forEach((p) => {
    p.path.forEach((id) => {
      const n = nodes.get(id);
      n.requests += p.requests;
      n.failures += p.failures;
    });
  });

  // Fold the smallest nodes of a crowded column into one "N more" node.
  const columns = [0, 1, 2, 3].map((c) => [...nodes.values()].filter((n) => n.col === c).sort((a, b) => b.requests + b.failures - (a.requests + a.failures) || a.id.localeCompare(b.id)));
  const remap = new Map();
  columns.forEach((list, c) => {
    if (list.length <= MAX_PER_COLUMN) return;
    const rest = list.splice(MAX_PER_COLUMN - 1);
    const other = { id: `o:${c}`, col: c, kind: 'other', label: `${rest.length} more`, requests: 0, failures: 0, flags: [], members: rest.map((n) => n.id) };
    rest.forEach((n) => {
      other.requests += n.requests;
      other.failures += n.failures;
      remap.set(n.id, other.id);
    });
    list.push(other);
    nodes.set(other.id, other);
  });
  paths.forEach((p) => {
    p.path = p.path.map((id) => remap.get(id) || id);
  });

  // Links between neighbouring columns, summed per pair.
  const links = new Map();
  paths.forEach((p) => {
    for (let i = 0; i < 3; i += 1) {
      const key = `${p.path[i]}→${p.path[i + 1]}${i === 1 && p.fallback ? '~' : ''}`;
      if (!links.has(key)) links.set(key, { key, source: p.path[i], target: p.path[i + 1], col: i, requests: 0, failures: 0, fallback: i === 1 && p.fallback });
      const l = links.get(key);
      l.requests += p.requests;
      l.failures += p.failures;
    }
  });

  // Facts and flags.
  const owners = aliasOwners(columns[1].filter((n) => n.kind === 'alias').map((n) => n.alias));
  columns.flat().forEach((n) => {
    const err = errorShare(n.requests, n.failures);
    n.fact = n.idle ? 'No traffic in range' : fact(n.requests, n.failures);
    n.tone = errTone(err);
    if (n.kind === 'team' || n.kind === 'key') flagCaller(n, err, teamStat.get(n.team));
    if (n.kind === 'alias') {
      const { owner, model } = splitAlias(n.alias, owners);
      n.owner = owner;
      n.label = model;
      n.sub = owner || null;
      flagAlias(n, paths);
    }
    if (n.kind === 'deployment') flagDeployment(n, paths, stateOf, columns[2]);
    if (n.kind === 'cluster') {
      const g = n.group;
      n.label = `${n.group.online}/${n.group.replicas.length} vLLM pod${g.replicas.length === 1 ? '' : 's'}`;
      n.sub = `KV ${g.kvMax == null ? '—' : `${Math.round(g.kvMax)}%`} · ${g.waiting} waiting`;
      if (g.online < g.replicas.length || g.waiting > 0 || g.kvMax >= 85) n.flags.push({ text: g.online < g.replicas.length ? 'Replica offline' : 'Under pressure', tone: 'warn' });
    }
    if (n.kind === 'outside' || n.kind === 'external') {
      n.label = n.host;
      n.sub = n.kind === 'external' ? 'external API' : 'outside this cluster';
    }
  });

  return { columns, links: [...links.values()], routes: paths, owners: [...owners].sort() };
}

function flagCaller(n, err, stat) {
  if (err != null && err >= 5) n.flags.push({ text: 'High errors', tone: 'bad' });
  if (n.kind !== 'team' || !stat) return;
  if (stat.throttled > 0) n.flags.push({ text: `${Math.round(stat.throttled)} throttled`, tone: 'warn' });
  if (stat.budgetMax > 0 && stat.budgetRemaining != null) {
    const used = (1 - stat.budgetRemaining / stat.budgetMax) * 100;
    if (used >= 80) n.flags.push({ text: `Budget ${Math.min(100, Math.round(used))}% used`, tone: used >= 100 ? 'bad' : 'warn' });
  }
}

function flagAlias(n, paths) {
  const mine = paths.filter((p) => p.path[1] === n.id);
  const primary = new Set(mine.filter((p) => !p.fallback).map((p) => p.path[2]));
  const fb = mine.filter((p) => p.fallback).reduce((s, p) => s + p.requests, 0);
  const total = mine.reduce((s, p) => s + p.requests, 0);
  if (primary.size > 1) n.flags.push({ text: `Split across ${primary.size} backends`, tone: '' });
  if (total > 0 && fb === total) n.flags.push({ text: 'Only fallbacks', tone: 'bad' });
  else if (total > 0 && fb / total >= 0.01) n.flags.push({ text: `${Math.round((fb / total) * 100)}% fallbacks`, tone: 'warn' });
}

function flagDeployment(n, paths, stateOf, siblings) {
  const state = stateOf.get(n.id);
  n.state = state ?? null;
  const mine = paths.filter((p) => p.path[2] === n.id);
  if (state >= 2 && n.requests > 0) n.flags.push({ text: 'Outage, still receiving traffic', tone: 'bad' });
  else if (state >= 2) n.flags.push({ text: 'Outage', tone: 'bad' });
  else if (state >= 1) n.flags.push({ text: 'Partial outage', tone: 'warn' });
  if (mine.length > 0 && mine.every((p) => p.fallback)) n.flags.push({ text: 'Fallback only', tone: '' });
  const host = hostOf(n.apiBase);
  if (host && siblings.some((s) => s !== n && s.kind === 'deployment' && normalizeModel(s.deployment) === normalizeModel(n.deployment) && hostOf(s.apiBase) === host)) {
    n.flags.push({ text: 'Duplicate: same model and host', tone: 'warn' });
  }
}

// highlight returns the node ids and link keys on every path through a
// node (null = nothing selected).
export function highlight(map, id) {
  if (!id) return null;
  const nodes = new Set([id]);
  const links = new Set();
  map.routes.forEach((p) => {
    if (!p.path.includes(id)) return;
    p.path.forEach((x) => nodes.add(x));
    for (let i = 0; i < 3; i += 1) links.add(`${p.path[i]}→${p.path[i + 1]}${i === 1 && p.fallback ? '~' : ''}`);
  });
  return { nodes, links };
}

// breakdown sums the paths through a node by another column: [{id, label,
// requests, failures, share, fallback}] biggest first. share is of the
// selected node's traffic.
export function breakdown(map, id, col) {
  const byId = new Map(map.columns.flat().map((n) => [n.id, n]));
  const rows = new Map();
  let total = 0;
  map.routes.forEach((p) => {
    if (!p.path.includes(id)) return;
    total += p.requests + p.failures;
    const other = p.path[col];
    if (!rows.has(other)) rows.set(other, { id: other, node: byId.get(other), requests: 0, failures: 0, fallback: 0 });
    const r = rows.get(other);
    r.requests += p.requests;
    r.failures += p.failures;
    if (p.fallback) r.fallback += p.requests;
  });
  return [...rows.values()]
    .map((r) => ({ ...r, share: total ? ((r.requests + r.failures) / total) * 100 : 0 }))
    .sort((a, b) => b.share - a.share || a.id.localeCompare(b.id));
}

// layout places nodes in four columns (height h, gap g) and returns the
// SVG size, node boxes and link paths. Link width follows requests.
export function layout(map, { width = 1000, nodeW = 210, nodeH = 72, gap = 14, top = 28 } = {}) {
  const colX = [0, 1, 2, 3].map((c) => Math.round((c * (width - nodeW)) / 3));
  const rows = Math.max(1, ...map.columns.map((c) => c.length));
  const height = top + rows * (nodeH + gap);
  const box = new Map();
  map.columns.forEach((list, c) => {
    const offset = top + ((rows - list.length) * (nodeH + gap)) / 2;
    list.forEach((n, i) => box.set(n.id, { x: colX[c], y: offset + i * (nodeH + gap), w: nodeW, h: nodeH }));
  });
  const max = Math.max(1, ...map.links.map((l) => l.requests + l.failures));
  const ports = new Map();
  const port = (id, side) => {
    const k = `${id}:${side}`;
    if (!ports.has(k)) ports.set(k, []);
    return ports.get(k);
  };
  const links = map.links
    .filter((l) => box.has(l.source) && box.has(l.target))
    .map((l) => ({ ...l, width: Math.max(1.5, ((l.requests + l.failures) / max) * 16) }));
  links.forEach((l) => {
    port(l.source, 'out').push(l);
    port(l.target, 'in').push(l);
  });
  // Spread each node's links along its side, ordered by the other end.
  const offsets = new Map();
  ports.forEach((list, k) => {
    const [id, side] = [k.slice(0, k.lastIndexOf(':')), k.slice(k.lastIndexOf(':') + 1)];
    const b = box.get(id);
    list.sort((a, c) => box.get(side === 'out' ? a.target : a.source).y - box.get(side === 'out' ? c.target : c.source).y);
    const step = Math.min(10, (b.h - 16) / Math.max(1, list.length));
    list.forEach((l, i) => offsets.set(`${l.key}:${side}`, b.y + b.h / 2 + (i - (list.length - 1) / 2) * step));
  });
  links.forEach((l) => {
    const s = box.get(l.source);
    const t = box.get(l.target);
    const x1 = s.x + s.w;
    const x2 = t.x;
    const y1 = offsets.get(`${l.key}:out`);
    const y2 = offsets.get(`${l.key}:in`);
    const mx = (x1 + x2) / 2;
    l.d = `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
  });
  return { width, height, colX, nodeW, box, links };
}
