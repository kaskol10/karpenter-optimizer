import React, { useMemo, useState } from 'react';
import { Copy, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { COLUMNS, MAX_PER_COLUMN, breakdown, buildRoutingMap, highlight, hostOf, layout } from '../../lib/routingMap';
import { copyText } from './shared';

const NODE_CLASS = {
  team: 'fill-card stroke-border',
  key: 'fill-card stroke-border',
  alias: 'fill-violet-50 stroke-violet-300 dark:fill-violet-950 dark:stroke-violet-800',
  deployment: 'fill-teal-50 stroke-teal-300 dark:fill-teal-950 dark:stroke-teal-800',
  cluster: 'fill-teal-50 stroke-teal-300 dark:fill-teal-950 dark:stroke-teal-800',
  outside: 'fill-muted stroke-border',
  external: 'fill-muted stroke-border',
  other: 'fill-muted stroke-border',
};
const LINK_COLOR = ['#8b5cf6', '#14b8a6', '#14b8a6'];
const FALLBACK_COLOR = '#f97316';
const TONE_TEXT = {
  '': 'fill-muted-foreground',
  warn: 'fill-amber-600 dark:fill-amber-400',
  bad: 'fill-red-600 dark:fill-red-400',
};
const TONE_CLASS = {
  '': 'text-muted-foreground',
  warn: 'text-amber-600 dark:text-amber-400',
  bad: 'text-red-600 dark:text-red-400',
};
const STATE_BAR = { 1: '#f59e0b', 2: '#ef4444' };

const trunc = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || '');
// mid keeps both ends of a long name, where models and hosts differ.
const mid = (s, n) => {
  if (!s || s.length <= n) return s || '';
  const head = Math.ceil((n - 1) / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - (n - 1 - head))}`;
};
const pct = (v) => `${v < 10 ? v.toFixed(1) : Math.round(v)}%`;
// antWidth sizes the marching-ants overlay to sit inside its link.
const antWidth = (l) => Math.max(1.25, Math.min((l.fallback ? Math.min(l.width, 3) : l.width) * 0.45, 4));
const num = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : `${Math.round(v)}`);

function Node({ n, box, dimmed, selected, onSelect, onExpand }) {
  const flag = n.flags[0];
  const name = n.label;
  const lines = [
    n.sub && { key: 'sub', text: mid(n.sub, 34), tone: '' },
    { key: 'fact', text: trunc(n.fact, 34), tone: '' },
    flag && { key: 'flag', text: trunc(n.flags.length > 1 ? `${flag.text} +${n.flags.length - 1}` : flag.text, 34), tone: flag.tone },
  ].filter(Boolean);
  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={
        n.kind === 'other'
          ? `${name}: ${n.members.map((m) => m.name).join(', ')}. Show them all`
          : `${name}${n.sub ? ` (${n.sub})` : ''}: ${n.fact}${n.flags.length ? `, ${n.flags.map((f) => f.text).join(', ')}` : ''}`
      }
      aria-pressed={n.kind === 'other' ? undefined : selected}
      className={cn('cursor-pointer outline-none transition-opacity', dimmed && 'opacity-20')}
      onClick={() => (n.kind === 'other' ? onExpand(n.col) : onSelect(selected ? null : n.id))}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (n.kind === 'other') onExpand(n.col);
          else onSelect(selected ? null : n.id);
        }
      }}
    >
      <title>
        {n.kind === 'other'
          ? [`${n.label}, click to show them all:`, ...n.members.slice(0, 20).map((m) => m.name), n.members.length > 20 ? '…' : null].filter(Boolean).join('\n')
          : [n.alias || name, n.kind === 'alias' ? null : n.sub, n.fact, ...n.flags.map((f) => f.text)].filter(Boolean).join('\n')}
      </title>
      <rect
        x={box.x}
        y={box.y}
        width={box.w}
        height={box.h}
        rx={8}
        strokeWidth={selected ? 2 : 1}
        strokeDasharray={n.kind === 'external' ? '4 3' : undefined}
        className={cn(NODE_CLASS[n.kind], selected && 'stroke-primary')}
      />
      {STATE_BAR[n.state] && <rect x={box.x} y={box.y + 6} width={3} height={box.h - 12} rx={1.5} fill={STATE_BAR[n.state]} />}
      <text x={box.x + 12} y={box.y + 19} className="fill-foreground text-[13px] font-medium">
        {mid(name, 23)}
      </text>
      {lines.map((l, i) => (
        <text key={l.key} x={box.x + 12} y={box.y + 36 + i * 15} className={cn('text-[11px]', TONE_TEXT[l.tone])}>
          {l.text}
        </text>
      ))}
    </g>
  );
}

function Rows({ title, rows, render, extra }) {
  if (!rows.length) return null;
  return (
    <div>
      <h4 className="mb-1 text-xs font-medium text-muted-foreground">{title}</h4>
      <ul className="space-y-0.5 text-sm">
        {rows.slice(0, 8).map((r) => (
          <li key={r.id} className="flex items-baseline justify-between gap-3">
            <span className="flex min-w-0 items-baseline gap-1">
              <span className="truncate">{render ? render(r) : r.node?.label}</span>
              {extra && <span className="shrink-0 whitespace-nowrap">{extra(r)}</span>}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">{pct(r.share)}</span>
          </li>
        ))}
        {rows.length > 8 && <li className="text-xs text-muted-foreground">and {rows.length - 8} more</li>}
      </ul>
    </div>
  );
}

function Details({ map, node, data, onClose, onFilter }) {
  const [copied, setCopied] = useState('');
  const col = (c) => breakdown(map, node.id, c);
  const model = node.kind === 'alias' ? (data.models || []).find((m) => m.model === node.alias) : null;
  const teamStat = node.kind === 'team' ? (data.teams || []).find((t) => t.team === node.team) : null;
  const keys =
    node.kind === 'team'
      ? Object.values(
          map.routes
            .filter((p) => p.path[0] === node.id)
            .reduce((acc, p) => {
              const k = p.key || 'No key';
              acc[k] = acc[k] || { id: k, requests: 0, failures: 0 };
              acc[k].requests += p.requests;
              acc[k].failures += p.failures;
              return acc;
            }, {}),
        ).sort((a, b) => b.requests + b.failures - (a.requests + a.failures))
      : [];
  const fullName = node.alias || node.label;
  const aliasName = (r) => (
    <>
      {r.node?.owner && <span className="text-muted-foreground">{r.node.owner}/</span>}
      {r.node?.label}
    </>
  );
  const fallbackMark = (r) => (r.fallback > 0 ? <span className="text-orange-600 dark:text-orange-400">fallback</span> : null);
  const marks = (r) => (
    <>
      {r.node?.state >= 1 && <span className={TONE_CLASS[r.node.state >= 2 ? 'bad' : 'warn']}>{r.node.state >= 2 ? 'outage' : 'partial outage'} </span>}
      {fallbackMark(r)}
    </>
  );
  const withHost = (r) => (
    <>
      {r.node?.label}
      {r.node?.apiBase && <span className="text-muted-foreground"> · {hostOf(r.node.apiBase)}</span>}
    </>
  );
  const copy = (label, value) => (
    <button
      type="button"
      className="inline-flex items-center gap-1 font-mono text-xs hover:underline"
      onClick={() => copyText(value, () => setCopied(value))}
      title={`Copy ${label}`}
    >
      {value}
      <Copy className="h-3 w-3" aria-hidden="true" />
      {copied === value && <span className="font-sans text-muted-foreground">copied</span>}
    </button>
  );

  return (
    <section aria-label={`Details for ${fullName}`} className="mt-3 rounded-lg border bg-card p-3">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-medium" title={fullName}>
            {fullName}
          </div>
          <div className="text-xs text-muted-foreground">
            {[node.sub, node.fact].filter(Boolean).join(' · ')}
          </div>
          {node.flags.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-x-3 text-xs">
              {node.flags.map((f) => (
                <span key={f.text} className={TONE_CLASS[f.tone]}>
                  {f.text}
                </span>
              ))}
            </div>
          )}
        </div>
        <button type="button" aria-label="Close details" className="text-muted-foreground hover:text-foreground" onClick={onClose}>
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {node.kind === 'alias' && (
          <>
            <Rows title="Where its traffic goes" rows={col(2)} render={withHost} extra={marks} />
            <Rows title="Who calls it" rows={col(0)} />
            {model && (
              <div className="text-sm">
                <h4 className="mb-1 text-xs font-medium text-muted-foreground">Health over the range</h4>
                <div>Spend {model.spend == null ? '—' : `$${model.spend.toFixed(2)}`}</div>
                <div>
                  Time to first token {model.ttftP50Seconds == null ? '—' : `${model.ttftP50Seconds.toFixed(2)} s`} p50 ·{' '}
                  {model.ttftP95Seconds == null ? '—' : `${model.ttftP95Seconds.toFixed(2)} s`} p95
                </div>
              </div>
            )}
          </>
        )}
        {node.kind === 'deployment' && (
          <>
            <Rows title="Who reaches it" rows={col(1)} render={aliasName} extra={fallbackMark} />
            <Rows title="Teams behind them" rows={col(0)} />
            <div className="space-y-1 text-sm">
              <h4 className="text-xs font-medium text-muted-foreground">Runs on</h4>
              {col(3).map((r) => (
                <div key={r.id}>
                  {r.node?.label} <span className="text-muted-foreground">· {r.node?.sub}</span>
                </div>
              ))}
              <h4 className="pt-1 text-xs font-medium text-muted-foreground">Identifiers</h4>
              {node.apiBase && <div>{copy('api_base', node.apiBase)}</div>}
              {node.provider && <div className="text-xs text-muted-foreground">provider {node.provider}</div>}
            </div>
          </>
        )}
        {(node.kind === 'team' || node.kind === 'key') && (
          <>
            <Rows title="What it uses" rows={col(1)} render={aliasName} />
            {keys.length > 0 && (
              <div>
                <h4 className="mb-1 text-xs font-medium text-muted-foreground">Its API keys</h4>
                <ul className="space-y-0.5 text-sm">
                  {keys.slice(0, 8).map((k) => (
                    <li key={k.id} className="flex justify-between gap-3">
                      <span className="truncate">{k.id}</span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {num(k.requests + k.failures)} req{k.failures > 0 && ` · ${pct((k.failures / (k.requests + k.failures)) * 100)} err`}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <Rows title="Deployments it reaches" rows={col(2)} render={withHost} extra={marks} />
            {teamStat?.budgetMax > 0 && (
              <div className="text-sm">
                <h4 className="mb-1 text-xs font-medium text-muted-foreground">Budget</h4>
                ${(teamStat.budgetRemaining ?? 0).toFixed(2)} left of ${teamStat.budgetMax.toFixed(2)}
              </div>
            )}
          </>
        )}
        {(node.kind === 'cluster' || node.kind === 'outside' || node.kind === 'external') && (
          <>
            <Rows title="Deployments here" rows={col(2)} render={withHost} extra={marks} />
            <Rows title="Aliases routed here" rows={col(1)} render={aliasName} />
          </>
        )}
      </div>

      {node.kind === 'alias' && (
        <button type="button" className="mt-3 text-sm text-primary hover:underline" onClick={() => onFilter({ model: node.alias })}>
          Filter Team usage by this alias
        </button>
      )}
      {node.kind === 'team' && (
        <button type="button" className="mt-3 text-sm text-primary hover:underline" onClick={() => onFilter({ team: node.team })}>
          Filter Team usage by this team
        </button>
      )}
      {node.kind === 'key' && (
        <button type="button" className="mt-3 text-sm text-primary hover:underline" onClick={() => onFilter({ key: node.key })}>
          Filter Team usage by this API key
        </button>
      )}
    </section>
  );
}

// RoutingMap draws who calls which alias, which deployment serves it and
// where that runs, for the card's filters and range. Link width = requests;
// dashed orange = served by a fallback model group. Clicking a node lights
// every path through it and opens its details.
export function RoutingMap({ data, groups, filtered, onFilter }) {
  const [byKey, setByKey] = useState(false);
  const [expanded, setExpanded] = useState([]);
  const [selected, setSelected] = useState(null);
  const map = useMemo(
    () => buildRoutingMap({ routes: data.routes, deployments: data.deployments, teams: data.teams, groups }, { byKey, idle: !filtered, expanded }),
    [data, groups, byKey, filtered, expanded],
  );
  const lay = useMemo(() => layout(map), [map]);
  const nodes = map.columns.flat();
  const current = nodes.find((n) => n.id === selected) || null;
  const lit = useMemo(() => highlight(map, current?.id), [map, current]);

  if (!data.routes?.length) {
    return <p className="py-6 text-center text-xs text-muted-foreground">No routed requests in this window.</p>;
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <div role="group" aria-label="Callers" className="inline-flex rounded-md border p-0.5">
          {[
            [false, 'Teams'],
            [true, 'API keys'],
          ].map(([v, label]) => (
            <button
              key={label}
              type="button"
              aria-pressed={byKey === v}
              className={cn('rounded px-2 py-0.5', byKey === v ? 'bg-muted text-foreground' : 'hover:text-foreground')}
              onClick={() => {
                setByKey(v);
                setSelected(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-1.5 w-5 rounded-sm bg-violet-400/50" /> width = requests
        </span>
        <span className="inline-flex items-center gap-1">
          <svg width="20" height="6" aria-hidden="true">
            <line x1="0" y1="3" x2="20" y2="3" stroke={FALLBACK_COLOR} strokeWidth="2" strokeDasharray="4 3" />
          </svg>
          fallback
        </span>
        <span>Click a node to follow its paths.</span>
        {expanded
          .filter((c) => map.columns[c].length > MAX_PER_COLUMN)
          .map((c) => (
            <button
              key={c}
              type="button"
              className="rounded-md border px-2 py-0.5 hover:text-foreground"
              onClick={() => setExpanded((e) => e.filter((x) => x !== c))}
            >
              Show fewer {COLUMNS[c].toLowerCase()}
            </button>
          ))}
      </div>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${lay.width} ${lay.height}`} className="min-w-[760px]" role="group" aria-label="Routing map">
          {COLUMNS.map((c, i) => (
            <text key={c} x={lay.colX[i] + lay.nodeW / 2} y={14} textAnchor="middle" className="fill-muted-foreground text-[12px]">
              {c}
            </text>
          ))}
          {lay.links.map((l) => (
            <path
              key={l.key}
              d={l.d}
              fill="none"
              stroke={l.fallback ? FALLBACK_COLOR : LINK_COLOR[l.col]}
              strokeWidth={l.fallback ? Math.max(1.5, Math.min(l.width, 3)) : l.width}
              strokeDasharray={l.fallback ? '5 4' : undefined}
              strokeOpacity={lit ? (lit.links.has(l.key) ? 0.75 : 0.06) : l.fallback ? 0.9 : 0.35}
            >
              <title>{`${num(l.requests + l.failures)} requests${l.fallback ? ' (fallback)' : ''}`}</title>
            </path>
          ))}
          {lit &&
            lay.links
              .filter((l) => lit.links.has(l.key))
              .map((l) => <path key={`ants-${l.key}`} d={l.d} fill="none" stroke="white" strokeOpacity={0.85} strokeWidth={antWidth(l)} className="marching-ants" data-testid="ants" />)}
          {nodes.map((n) => (
            <Node
              key={n.id}
              n={n}
              box={lay.box.get(n.id)}
              dimmed={Boolean(lit) && !lit.nodes.has(n.id)}
              selected={n.id === current?.id}
              onSelect={setSelected}
              onExpand={(c) => {
                setSelected(null);
                setExpanded((e) => (e.includes(c) ? e : [...e, c]));
              }}
            />
          ))}
        </svg>
      </div>
      {current && (
        <Details
          map={map}
          node={current}
          data={data}
          onClose={() => setSelected(null)}
          onFilter={(f) => {
            setSelected(null);
            onFilter(f);
          }}
        />
      )}
    </div>
  );
}
