// The Gateway fallback map: what LiteLLM is configured to do when a model
// group fails, drawn over what it did. Built from /serving/gateway/routing:
// `config` (model groups, aliases, fallbacks, settings and issues, read from
// the proxy's config.yaml) and `observed` (the fallbacks taken over a
// window, with the error that caused each; null without Prometheus). Pure
// so it is tested on its own; FallbackMap.jsx only draws it.

import { hostOf, isExternal } from './routingMap';

export const FALLBACK_COLUMNS = ['Also asked for as', 'Model group', 'Falls back to'];
export const NO_FALLBACK_ID = 'g:\u0000none';

const KIND_LABEL = { general: '', context_window: 'context window', content_policy: 'content policy' };

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function ordinal(n) {
  const rest = n % 100;
  if (rest >= 11 && rest <= 13) return `${n}th`;
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'}`;
}

export const sharePct = (v) => (v < 1 ? '<1%' : `${v < 10 ? v.toFixed(1) : Math.round(v)}%`);

export function compact(v) {
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return `${Math.round(v)}`;
}

// matchWildcard mirrors litellmconfig.matchWildcard: each "*" is any run.
function matchWildcard(pattern, name) {
  const escaped = pattern.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${escaped.join('.*')}$`).test(name);
}

// resolveGroup returns the model group a requested name is served by: an
// alias's target, the group of that name, or the longest wildcard pattern
// that matches ('' when none).
export function resolveGroup(config, name) {
  const alias = (config.aliases || []).find((a) => a.name === name && a.target);
  const wanted = alias ? alias.target : name;
  let wildcard = '';
  for (const g of config.groups || []) {
    if (g.name === wanted) return g.name;
    if (g.wildcard && g.name.length > wildcard.length && matchWildcard(g.name, wanted)) wildcard = g.name;
  }
  return wildcard;
}

// reasonLabel turns LiteLLM's exception class into words:
// "Hosted_vllm.ContextWindowExceededError" → "Context window exceeded".
export function reasonLabel(reason) {
  if (!reason || reason === 'None') return 'Unknown error';
  const name = reason.slice(reason.lastIndexOf('.') + 1).replace(/Error$/, '');
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .trim();
  return words ? words[0].toUpperCase() + words.slice(1) : reason;
}

// runsOn says where a model group's deployments are: its host (or provider
// when it has no api_base), how many there are, and whether every one is
// someone else's API.
export function runsOn(group) {
  const deps = group?.deployments || [];
  if (!deps.length) return { text: '', external: false, hosts: [] };
  const hosts = [...new Set(deps.map((d) => hostOf(d.apiBase) || d.provider || 'unknown'))];
  const external = deps.every((d) => isExternal(d.provider, d.apiBase));
  const where = hosts.length === 1 ? hosts[0] : plural(hosts.length, 'host');
  return { text: deps.length > 1 ? `${where} · ${plural(deps.length, 'deployment')}` : where, external, hosts };
}

// settingsLines says in words when LiteLLM gives up on a deployment and
// moves on, from the router settings the config sets.
export function settingsLines(settings = {}) {
  const lines = [];
  const { numRetries, allowedFails, cooldownSeconds, timeoutSeconds, streamTimeoutSeconds, routingStrategy, defaultFallbacks } = settings;
  if (numRetries === 0) lines.push({ label: 'Retries', text: 'None: a failed request goes straight to the fallback' });
  else if (numRetries != null) lines.push({ label: 'Retries', text: `${plural(numRetries, 'retry', 'retries')} on the same group before the fallback` });
  if (allowedFails != null || cooldownSeconds != null) {
    const after = allowedFails != null ? `after more than ${plural(allowedFails, 'failure')} in a minute` : 'after repeated failures';
    const rest = cooldownSeconds != null ? `skipped for ${cooldownSeconds} s` : 'skipped for a while';
    lines.push({ label: 'Cooldown', text: `A deployment is ${rest} ${after}` });
  }
  if (timeoutSeconds != null || streamTimeoutSeconds != null) {
    const parts = [];
    if (timeoutSeconds != null) parts.push(`${timeoutSeconds} s`);
    if (streamTimeoutSeconds != null) parts.push(`${streamTimeoutSeconds} s when streaming`);
    lines.push({ label: 'Timeout', text: parts.join(', ') });
  }
  if (routingStrategy) lines.push({ label: 'Load balancing', text: routingStrategy });
  if (defaultFallbacks?.length) lines.push({ label: 'Default fallback', text: `${defaultFallbacks.join(' → ')}, for groups with none of their own` });
  return lines;
}

const linkKey = (from, to) => `${from}\u0000${to}`;

// collectLinks merges the configured fallbacks and the observed ones into
// one link per (group, target), keeping the order LiteLLM tries them in.
function collectLinks(config, observed) {
  const links = new Map();
  (config.fallbacks || []).forEach((f) => {
    const from = resolveGroup(config, f.from) || f.from;
    f.to.forEach((to, i) => {
      const key = linkKey(from, to);
      if (!links.has(key)) links.set(key, { key, from, to, order: i + 1, kinds: [], configured: true, succeeded: 0, failed: 0, reasons: [] });
      const l = links.get(key);
      l.order = Math.min(l.order, i + 1);
      if (!l.kinds.includes(f.kind)) l.kinds.push(f.kind);
    });
  });
  (observed?.fallbacks || []).forEach((o) => {
    const from = resolveGroup(config, o.from) || o.from;
    const key = linkKey(from, o.to);
    if (!links.has(key)) links.set(key, { key, from, to: o.to, order: 0, kinds: [], configured: false, succeeded: 0, failed: 0, reasons: [] });
    const l = links.get(key);
    l.succeeded += o.succeeded || 0;
    l.failed += o.failed || 0;
    (o.reasons || []).forEach((r) => {
      const same = l.reasons.find((x) => x.reason === r.reason && x.status === r.status);
      if (same) {
        same.succeeded += r.succeeded || 0;
        same.failed += r.failed || 0;
      } else l.reasons.push({ ...r });
    });
  });
  links.forEach((l) => {
    l.used = l.succeeded + l.failed;
    l.reasons.sort((a, b) => b.succeeded + b.failed - (a.succeeded + a.failed));
    // used: configured and taken; unused: configured, never taken in the
    // window; configured: no traffic data to say; unconfigured: taken but
    // not in the config that was read.
    if (!l.configured) l.state = 'unconfigured';
    else if (!observed) l.state = 'configured';
    else l.state = l.used > 0 ? 'used' : 'unused';
    // A general fallback applies to every error; the others only to theirs.
    const only = l.kinds.includes('general') ? '' : l.kinds.map((k) => KIND_LABEL[k]).filter(Boolean).join(', ');
    l.label = [l.order ? ordinal(l.order) : 'not in config', only && `${only} only`, l.used > 0 && `${compact(l.used)}×`].filter(Boolean).join(' · ');
  });
  return [...links.values()];
}

// buildFallbackMap returns {columns: [aliases, groups, targets], links,
// issues, settings, hasObserved, totals}. Groups with no fallback fold into
// one node unless showAll.
export function buildFallbackMap(routing, { showAll = false } = {}) {
  const config = routing?.config || {};
  const observed = routing?.observed || null;
  const groups = config.groups || [];
  const byName = new Map(groups.map((g) => [g.name, g]));
  const fallbackLinks = collectLinks(config, observed);
  const window = observed?.range || '';
  // Requests per group, summing the names (aliases, wildcard matches) it
  // was asked for as.
  const requests = new Map();
  Object.entries(observed?.requests || {}).forEach(([name, n]) => {
    const g = resolveGroup(config, name) || name;
    requests.set(g, (requests.get(g) || 0) + n);
  });

  const outOf = new Map();
  const into = new Map();
  fallbackLinks.forEach((l) => {
    if (!outOf.has(l.from)) outOf.set(l.from, []);
    outOf.get(l.from).push(l);
    if (!into.has(l.to)) into.set(l.to, []);
    into.get(l.to).push(l);
  });
  // The chain in the order LiteLLM tries it; at the same position, the
  // fallback for any error before the ones for one kind of error.
  const general = (l) => (l.kinds.includes('general') ? 0 : 1);
  outOf.forEach((list) => list.sort((a, b) => (a.order || 99) - (b.order || 99) || general(a) - general(b) || a.to.localeCompare(b.to)));

  // Targets, the most shared first.
  const targets = [...into.keys()]
    .sort((a, b) => into.get(b).length - into.get(a).length || a.localeCompare(b))
    .map((name) => {
      const users = into.get(name);
      const group = byName.get(resolveGroup(config, name));
      const run = runsOn(group);
      const served = users.reduce((s, l) => s + l.succeeded, 0);
      const failed = users.reduce((s, l) => s + l.failed, 0);
      const flags = [];
      if (!group) flags.push({ text: 'Not in model_list', tone: 'bad' });
      if (failed > 0) flags.push({ text: `${compact(failed)} failed here too`, tone: 'bad' });
      if (run.external) flags.push({ text: 'External API', tone: 'warn' });
      const sharedBy = users.filter((l) => l.configured).length;
      const fact = observed ? (served + failed > 0 ? `${compact(served)} served in ${window}` : `Not used in ${window}`) : plural(sharedBy, 'group');
      return { id: `t:${name}`, col: 2, kind: 'target', name, label: name, sub: run.text, group, external: run.external, users, served, failed, sharedBy, fact, flags };
    });
  const targetIndex = new Map(targets.map((t, i) => [t.name, i]));

  // Groups: those with a fallback, ordered by their first target so links
  // do not cross; then (showAll) the rest; sources that are in no
  // model_list last.
  const sources = [...outOf.keys()].sort(
    (a, b) => targetIndex.get(outOf.get(a)[0].to) - targetIndex.get(outOf.get(b)[0].to) || a.localeCompare(b),
  );
  const groupNode = (name) => {
    const group = byName.get(name);
    const out = outOf.get(name) || [];
    const run = runsOn(group);
    const used = out.reduce((s, l) => s + l.used, 0);
    const failed = out.reduce((s, l) => s + l.failed, 0);
    const flags = [];
    if (!group) flags.push({ text: 'Not in model_list', tone: 'bad' });
    if (out.some((l) => !l.configured)) flags.push({ text: 'Fallback not in config', tone: 'bad' });
    // short is what fits on the node beside the fallback count.
    if (failed > 0) flags.push({ text: `${compact(failed)} fallbacks failed`, short: `${compact(failed)} failed`, tone: 'bad' });
    // A wildcard cannot be keyed in fallbacks, so it is not flagged for it.
    if (group?.wildcard) flags.push({ text: 'Wildcard: any other name', tone: '' });
    else if (!out.length) flags.push({ text: 'No fallback', tone: 'warn' });
    const total = requests.get(name) || 0;
    // The share of its requests that needed a fallback (null when unknown).
    const share = used > 0 && total >= used ? (used / total) * 100 : null;
    let fact = '';
    if (out.length && observed) {
      if (used === 0) fact = `No fallbacks in ${window}`;
      else fact = share != null ? `${compact(used)} fallbacks · ${sharePct(share)} of requests` : `${compact(used)} fallbacks in ${window}`;
    }
    return { id: `g:${name}`, col: 1, kind: 'group', name, label: name, sub: run.text, group, external: run.external, out, used, failed, share, requests: total, fact, flags };
  };
  const withFallback = sources.map(groupNode);
  const idle = groups.filter((g) => !outOf.has(g.name) && !into.has(g.name));
  const without = idle.filter((g) => !g.wildcard).map((g) => g.name);
  let rest = [];
  if (showAll) rest = idle.map((g) => groupNode(g.name));
  else if (without.length) {
    rest = [
      {
        id: NO_FALLBACK_ID,
        col: 1,
        kind: 'folded',
        label: `${plural(without.length, 'group')} with no fallback`,
        sub: 'Show them',
        members: without,
        out: [],
        fact: '',
        flags: [{ text: 'A failure there is an error', tone: 'warn' }],
      },
    ];
  }
  const groupNodes = [...withFallback, ...rest];
  const shown = new Set(groupNodes.filter((n) => n.kind === 'group').map((n) => n.name));

  // Aliases of the groups shown, plus broken ones (always worth seeing).
  const aliasLinks = [];
  const aliasNodes = (config.aliases || [])
    .map((a) => {
      const target = resolveGroup(config, a.target || '');
      const flags = [];
      if (!target) flags.push({ text: 'Points to nothing', tone: 'bad' });
      if (a.hidden) flags.push({ text: 'Hidden', tone: '' });
      return { id: `a:${a.name}`, col: 0, kind: 'alias', name: a.name, label: a.name, sub: target ? '' : a.target, target, fact: '', flags };
    })
    .filter((n) => !n.target || shown.has(n.target))
    .sort((a, b) => {
      const ia = groupNodes.findIndex((g) => g.name === a.target);
      const ib = groupNodes.findIndex((g) => g.name === b.target);
      return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib) || a.name.localeCompare(b.name);
    });
  aliasNodes.forEach((n) => {
    if (n.target) aliasLinks.push({ key: `${n.id}→g:${n.target}`, source: n.id, target: `g:${n.target}`, col: 0, state: 'alias', used: 0, label: '' });
  });

  const links = [
    ...aliasLinks,
    ...fallbackLinks.map((l) => ({ ...l, key: `g:${l.from}→t:${l.to}`, source: `g:${l.from}`, target: `t:${l.to}`, col: 1 })),
  ];

  return {
    columns: [aliasNodes, groupNodes, targets],
    links,
    issues: buildIssues(config, fallbackLinks, targets, observed),
    settings: settingsLines(config.settings),
    hasObserved: Boolean(observed),
    window,
    totals: {
      groups: groups.length,
      withFallback: sources.filter((s) => byName.has(s)).length,
      without: without.length,
      used: fallbackLinks.reduce((s, l) => s + l.used, 0),
      failed: fallbackLinks.reduce((s, l) => s + l.failed, 0),
    },
  };
}

// buildIssues is the config's own issues plus what only shows with where
// things run and what happened.
function buildIssues(config, links, targets, observed) {
  const issues = (config.issues || []).map((i) => ({ severity: i.severity, text: i.text, subjects: i.subjects || [] }));
  const stray = links.filter((l) => !l.configured);
  if (stray.length) {
    issues.unshift({
      severity: 'error',
      text: `${plural(stray.length, 'fallback')} taken that ${stray.length === 1 ? 'is' : 'are'} not in this config (${stray
        .map((l) => `${l.from} → ${l.to}`)
        .join(', ')}): the running proxy uses another config than the one read here.`,
      subjects: stray.map((l) => l.from),
    });
  }
  const failed = links.filter((l) => l.failed > 0);
  if (failed.length) {
    const n = failed.reduce((s, l) => s + l.failed, 0);
    issues.push({
      severity: 'warn',
      text: `${compact(n)} ${n === 1 ? 'request' : 'requests'} failed on the fallback too in ${observed.range}: ${failed.map((l) => `${l.from} → ${l.to}`).join(', ')}.`,
      subjects: failed.map((l) => l.from),
    });
  }
  const configured = targets.filter((t) => t.sharedBy > 0);
  const external = configured.filter((t) => t.external);
  if (external.length && external.length === configured.length) {
    const hosts = [...new Set(external.flatMap((t) => runsOn(t.group).hosts))];
    issues.push({
      severity: 'info',
      text: `Every fallback leaves your servers for an external API (${hosts.join(', ')}): fallbacks are billed there and prompts are sent there.`,
      subjects: external.map((t) => t.name),
    });
  }
  const unused = links.filter((l) => l.state === 'unused');
  if (observed && unused.length) {
    issues.push({
      severity: 'info',
      text: `${plural(unused.length, 'fallback')} not taken in ${observed.range} (${unused.map((l) => `${l.from} → ${l.to}`).join(', ')}): untested until the day ${unused.length === 1 ? 'it is' : 'they are'} needed.`,
      subjects: unused.map((l) => l.from),
    });
  }
  const rank = { error: 0, warn: 1, info: 2 };
  return issues.sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3));
}

// neighbours returns the node ids and link keys touching a node: what to
// keep lit when it is selected (null when nothing is).
export function neighbours(map, id) {
  if (!id) return null;
  const nodes = new Set([id]);
  const links = new Set();
  map.links.forEach((l) => {
    if (l.source === id || l.target === id) {
      links.add(l.key);
      nodes.add(l.source);
      nodes.add(l.target);
    }
  });
  // From an alias, follow on to its group's fallbacks.
  if (id.startsWith('a:')) {
    map.links.forEach((l) => {
      if (l.col === 1 && nodes.has(l.source)) {
        links.add(l.key);
        nodes.add(l.target);
      }
    });
  }
  return { nodes, links };
}

// layoutFallbackMap places the three columns and returns the SVG size, node
// boxes, link paths and where each link's label sits (a quarter of the way
// along, where links leaving different groups are still apart).
export function layoutFallbackMap(map, { width = 1000, nodeW = 270, nodeH = 58, gap = 12, top = 28 } = {}) {
  const colX = [0, 1, 2].map((c) => Math.round((c * (width - nodeW)) / 2));
  const rows = Math.max(1, ...map.columns.map((c) => c.length));
  const height = top + rows * (nodeH + gap);
  const box = new Map();
  map.columns.forEach((list, c) => {
    const offset = top + ((rows - list.length) * (nodeH + gap)) / 2;
    list.forEach((n, i) => box.set(n.id, { x: colX[c], y: offset + i * (nodeH + gap), w: nodeW, h: nodeH }));
  });
  const max = Math.max(1, ...map.links.map((l) => l.used || 0));
  const drawn = map.links.filter((l) => box.has(l.source) && box.has(l.target));
  const ports = new Map();
  const port = (k) => {
    if (!ports.has(k)) ports.set(k, []);
    return ports.get(k);
  };
  drawn.forEach((l) => {
    port(`${l.source}\u0000out`).push(l);
    port(`${l.target}\u0000in`).push(l);
  });
  const at = new Map();
  ports.forEach((list, k) => {
    const [id, side] = k.split('\u0000');
    const b = box.get(id);
    const other = (l) => box.get(side === 'out' ? l.target : l.source).y;
    list.sort((a, c) => other(a) - other(c) || (a.order || 0) - (c.order || 0));
    const step = Math.min(12, (b.h - 16) / Math.max(1, list.length));
    list.forEach((l, i) => at.set(`${l.key}\u0000${side}`, b.y + b.h / 2 + (i - (list.length - 1) / 2) * step));
  });
  const links = drawn.map((l) => {
    const s = box.get(l.source);
    const t = box.get(l.target);
    const x1 = s.x + s.w;
    const x2 = t.x;
    const y1 = at.get(`${l.key}\u0000out`);
    const y2 = at.get(`${l.key}\u0000in`);
    const mx = (x1 + x2) / 2;
    // Point on the cubic bezier at t = 0.25.
    const q = 0.25;
    const bez = (p0, p1, p2, p3) => (1 - q) ** 3 * p0 + 3 * (1 - q) ** 2 * q * p1 + 3 * (1 - q) * q ** 2 * p2 + q ** 3 * p3;
    return {
      ...l,
      d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`,
      width: l.col === 0 ? 1.5 : l.used > 0 ? Math.max(2, (l.used / max) * 14) : 1.5,
      labelX: bez(x1, mx, mx, x2),
      labelY: bez(y1, y1, y2, y2),
    };
  });
  return { width, height, colX, nodeW, box, links };
}
