// The command palette (⌘K): jump to any page, node, pod, GPU or model by
// typing part of its name, or run an action by starting with a verb
// ("drain ip-10-0-7-88", "logs vllm", "fit 40GiB 2"). Items are built from
// lists the app already loads (/topology, /serving); this file is pure so
// the matching can be tested on its own.
import { AREAS } from './routes';
import { formatMiB, parseSize } from './gpuFit';

const shortUuid = (uuid) => (uuid && uuid.length > 12 ? `${uuid.slice(0, 12)}…` : uuid || '');

// Each item: {id, kind, label, hint, run}. run is what App does with it:
//   {type: 'navigate', page, focus?, params?}
//   {type: 'logs', pod: 'ns/name'}
//   {type: 'theme'}
export function buildItems({ nodes = [], servingPods = [] } = {}) {
  const items = [];
  AREAS.forEach((area) =>
    area.pages.forEach((p) =>
      items.push({ id: `page:${p.id}`, kind: 'page', label: p.label, hint: area.label, run: { type: 'navigate', page: p.id } }),
    ),
  );
  items.push({ id: 'action:logs', kind: 'action', label: 'Open logs', hint: 'Log Explorer', run: { type: 'logs', pod: '' } });
  items.push({ id: 'action:theme', kind: 'action', label: 'Toggle dark mode', hint: 'Theme', run: { type: 'theme' } });

  const gpuSeen = new Set();
  nodes.forEach((node) => {
    const meta = [node.nodePool, node.instanceType, node.zone].filter(Boolean).join(' · ');
    items.push({
      id: `node:${node.name}`,
      kind: 'node',
      label: node.name,
      hint: meta,
      node: node.name,
      run: { type: 'navigate', page: 'topology', params: { zoom: 'node', at: node.name } },
    });
    (node.pods || []).forEach((pod) => {
      const key = `${pod.namespace}/${pod.name}`;
      items.push({
        id: `pod:${key}`,
        kind: 'pod',
        label: key,
        hint: `on ${node.name}`,
        pod: key,
        run: { type: 'navigate', page: 'topology', focus: { node: node.name, pod: key } },
      });
      (pod.gpuDevices || []).forEach((d) => {
        if (!d.uuid || gpuSeen.has(d.uuid)) return;
        gpuSeen.add(d.uuid);
        items.push({
          id: `gpu:${d.uuid}`,
          kind: 'gpu',
          label: `${node.gpuModel || 'GPU'} ${shortUuid(d.uuid)}`,
          hint: `${node.name}${node.gpuMemTotalMiB && node.gpuCapacity ? ` · ${formatMiB(node.gpuMemTotalMiB / node.gpuCapacity)}` : ''}`,
          keywords: d.uuid,
          run: { type: 'navigate', page: 'topology', params: { zoom: 'gpu', at: node.name, card: d.uuid } },
        });
      });
    });
  });

  const models = new Map();
  servingPods.forEach((p) => {
    const model = p.model || p.name;
    if (!models.has(model)) models.set(model, []);
    models.get(model).push(p);
  });
  models.forEach((replicas, model) => {
    const first = replicas[0];
    items.push({
      id: `model:${model}`,
      kind: 'model',
      label: model,
      hint: `${replicas.length} replica${replicas.length === 1 ? '' : 's'} · ${first.backend || 'serving'}`,
      run: { type: 'navigate', page: 'serving', focus: { pod: `${first.namespace}/${first.name}` } },
    });
  });
  return items;
}

const KIND_ORDER = { page: 0, action: 1, model: 2, node: 3, gpu: 4, pod: 5 };

// scoreText: how well one query token matches a text (0 = no match).
function scoreText(token, text) {
  const t = text.toLowerCase();
  if (t === token) return 100;
  if (t.startsWith(token)) return 80;
  if (t.split(/[\s/._:-]+/).some((w) => w.startsWith(token))) return 60;
  if (t.includes(token)) return 40;
  // Subsequence ("ip1012" in "ip-10-0-10-12"): weak but useful for names.
  let i = 0;
  for (const ch of t) if (ch === token[i]) i += 1;
  return i === token.length && token.length >= 3 ? 10 : 0;
}

function scoreItem(tokens, item) {
  let total = 0;
  for (const token of tokens) {
    const s = Math.max(scoreText(token, item.label), scoreText(token, item.hint || '') / 2, scoreText(token, item.keywords || '') / 2);
    if (!s) return 0;
    total += s;
  }
  return total;
}

// search ranks items for a query: every word must match the label, hint or
// keywords; label matches beat hint matches; pages and actions first on ties.
export function search(items, query, limit = 30) {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return items.filter((i) => i.kind === 'page' || i.kind === 'action').slice(0, limit);
  return items
    .map((item) => ({ item, score: scoreItem(tokens, item) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || KIND_ORDER[a.item.kind] - KIND_ORDER[b.item.kind] || a.item.label.localeCompare(b.item.label))
    .slice(0, limit)
    .map((r) => r.item);
}

const VERBS = ['drain', 'logs', 'fit'];

// parseCommand splits a leading verb off the query: {verb, rest} or null.
export function parseCommand(query) {
  const m = query.trim().match(/^(\S+)\s*(.*)$/);
  if (!m) return null;
  const verb = m[1].toLowerCase();
  return VERBS.includes(verb) ? { verb, rest: m[2] } : null;
}

// commandResults turns a verb query into actions:
//   drain <node>   → simulate draining that node in Topology
//   logs <pod>     → open that pod's logs
//   fit <size> [n] → where n replicas of that size would fit
export function commandResults(items, query, limit = 30) {
  const cmd = parseCommand(query);
  if (!cmd) return null;
  if (cmd.verb === 'fit') {
    const [sizeText, replicasText] = cmd.rest.trim().split(/\s+/);
    const mib = parseSize(sizeText);
    if (!mib) {
      return [{ id: 'hint:fit', kind: 'hint', label: 'Type a GPU memory size, e.g. "fit 40GiB" or "fit 24GiB 3"', run: null }];
    }
    const replicas = Math.max(1, Math.min(16, parseInt(replicasText, 10) || 1));
    const params = { fit: sizeText };
    if (replicas > 1) params.replicas = String(replicas);
    return [
      {
        id: `fit:${sizeText}:${replicas}`,
        kind: 'action',
        label: `Where would ${replicas > 1 ? `${replicas} × ` : ''}${formatMiB(mib)} fit?`,
        hint: 'Topology placement planner',
        run: { type: 'navigate', page: 'topology', params },
      },
    ];
  }
  const kind = cmd.verb === 'drain' ? 'node' : 'pod';
  const pool = items.filter((i) => i.kind === kind);
  const matches = cmd.rest.trim() ? search(pool, cmd.rest, limit) : pool.slice(0, limit);
  return matches.map((i) =>
    cmd.verb === 'drain'
      ? {
          id: `drain:${i.node}`,
          kind: 'action',
          label: `Simulate draining ${i.node}`,
          hint: i.hint,
          run: { type: 'navigate', page: 'topology', params: { drain: i.node } },
        }
      : { id: `logs:${i.pod}`, kind: 'action', label: `Logs for ${i.pod}`, hint: i.hint, run: { type: 'logs', pod: i.pod } },
  );
}

// paletteResults is what the palette lists for a query.
export function paletteResults(items, query, limit = 30) {
  return commandResults(items, query, limit) || search(items, query, limit);
}
