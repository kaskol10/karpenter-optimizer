import React, { useMemo, useState } from 'react';
import { AlertTriangle, CircleAlert, Info, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { FALLBACK_COLUMNS, buildFallbackMap, compact, layoutFallbackMap, neighbours, ordinal, reasonLabel } from '../../lib/fallbackMap';

const NODE_CLASS = {
  alias: 'fill-card stroke-border',
  group: 'fill-violet-50 stroke-violet-300 dark:fill-violet-950 dark:stroke-violet-800',
  target: 'fill-orange-50 stroke-orange-300 dark:fill-orange-950 dark:stroke-orange-800',
  folded: 'fill-muted stroke-border',
};
// How a fallback link is drawn, by state (see collectLinks).
const LINK_STYLE = {
  alias: { stroke: '#8b5cf6', dash: undefined, opacity: 0.4 },
  used: { stroke: '#f97316', dash: undefined, opacity: 0.6 },
  configured: { stroke: '#f97316', dash: '6 4', opacity: 0.8 },
  unused: { stroke: '#94a3b8', dash: '2 5', opacity: 0.9 },
  unconfigured: { stroke: '#ef4444', dash: undefined, opacity: 0.8 },
};
const STATE_TEXT = {
  used: 'configured and taken',
  configured: 'configured',
  unused: 'configured, never taken in this window',
  unconfigured: 'taken, but not in this config',
};
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
const ISSUE = {
  error: { icon: CircleAlert, className: 'text-red-600 dark:text-red-400' },
  warn: { icon: AlertTriangle, className: 'text-amber-600 dark:text-amber-400' },
  info: { icon: Info, className: 'text-muted-foreground' },
};

// mid keeps both ends of a long name, where models and hosts differ.
const mid = (s, n) => {
  if (!s || s.length <= n) return s || '';
  const head = Math.ceil((n - 1) / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - (n - 1 - head))}`;
};

function Node({ n, box, dimmed, selected, onSelect, onExpand }) {
  const flag = n.flags[0];
  const second = n.fact || (flag ? (n.flags.length > 1 ? `${flag.text} +${n.flags.length - 1}` : flag.text) : '');
  const secondTone = n.fact ? '' : flag?.tone || '';
  // A fact and a flag: the flag takes the right end of the second line.
  const aside = n.fact && flag ? flag : null;
  const folded = n.kind === 'folded';
  const act = () => (folded ? onExpand() : onSelect(selected ? null : n.id));
  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={
        folded
          ? `${n.label}: ${n.members.join(', ')}. Show them all`
          : [n.label, n.sub, n.fact, ...n.flags.map((f) => f.text)].filter(Boolean).join(', ')
      }
      aria-pressed={folded ? undefined : selected}
      className={cn('cursor-pointer outline-none transition-opacity', dimmed && 'opacity-20')}
      onClick={act}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          act();
        }
      }}
    >
      <title>{folded ? [`${n.label}, click to show them:`, ...n.members].join('\n') : [n.label, n.sub, n.fact, ...n.flags.map((f) => f.text)].filter(Boolean).join('\n')}</title>
      <rect
        x={box.x}
        y={box.y}
        width={box.w}
        height={box.h}
        rx={8}
        strokeWidth={selected ? 2 : 1}
        strokeDasharray={n.external || folded ? '4 3' : undefined}
        className={cn(NODE_CLASS[n.kind], selected && 'stroke-primary')}
      />
      <text x={box.x + 12} y={box.y + 18} className="fill-foreground text-[13px] font-medium">
        {mid(n.label, 34)}
      </text>
      <text x={box.x + 12} y={box.y + 33} className="fill-muted-foreground text-[11px]">
        {mid(n.sub, 42)}
      </text>
      <text x={box.x + 12} y={box.y + 48} className={cn('text-[11px]', TONE_TEXT[secondTone])}>
        {second}
      </text>
      {aside && (
        <text x={box.x + box.w - 12} y={box.y + 48} textAnchor="end" className={cn('text-[11px]', TONE_TEXT[aside.tone])}>
          {aside.short || aside.text}
        </text>
      )}
    </g>
  );
}

function Reasons({ link, window }) {
  if (!link.reasons.length) return null;
  return (
    <table className="mt-1 w-full text-xs">
      <thead>
        <tr className="text-left text-muted-foreground">
          <th className="py-0.5 font-normal">Why, in {window}</th>
          <th className="py-0.5 text-right font-normal">Fallbacks</th>
          <th className="py-0.5 text-right font-normal">Failed too</th>
        </tr>
      </thead>
      <tbody>
        {link.reasons.map((r) => (
          <tr key={`${r.reason}|${r.status}`}>
            <td className="py-0.5" title={r.reason}>
              {reasonLabel(r.reason)}
              {r.status && <span className="text-muted-foreground"> · {r.status}</span>}
            </td>
            <td className="py-0.5 text-right tabular-nums">{compact(r.succeeded + r.failed)}</td>
            <td className={cn('py-0.5 text-right tabular-nums', r.failed > 0 && TONE_CLASS.bad)}>{r.failed > 0 ? compact(r.failed) : '–'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Hop({ link, name, window }) {
  return (
    <li>
      <p className="text-sm">
        <span className="mr-1.5 text-muted-foreground">{link.order ? ordinal(link.order) : 'Not in config'}</span>
        <span className="font-medium">{name}</span>
        <span className="ml-1.5 text-xs text-muted-foreground">{STATE_TEXT[link.state]}</span>
      </p>
      <Reasons link={link} window={window} />
    </li>
  );
}

function Details({ map, node, onClose }) {
  const aliases = map.columns[0].filter((a) => a.target && a.target === node.name).map((a) => a.name);
  const hops = node.kind === 'target' ? node.users : node.out || [];
  return (
    <section className="mt-3 rounded-lg border p-3" aria-label={`Details for ${node.label}`}>
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="break-all text-sm font-medium">{node.label}</h3>
          <p className="text-xs text-muted-foreground">
            {node.kind === 'alias' ? (node.target ? `Another name for ${node.target}` : `Points to ${node.sub || 'nothing'}, which is not in model_list`) : node.sub}
          </p>
        </div>
        <button type="button" className="rounded p-1 text-muted-foreground hover:text-foreground" aria-label="Close details" onClick={onClose}>
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {node.kind !== 'alias' && (
          <div>
            <h4 className="mb-1 text-xs font-medium text-muted-foreground">
              {node.kind === 'target' ? 'Fallback for' : hops.length ? 'When it fails, LiteLLM tries' : 'When it fails'}
            </h4>
            {hops.length ? (
              <ol className="space-y-2">
                {hops.map((l) => (
                  <Hop key={l.key} link={l} name={node.kind === 'target' ? l.from : l.to} window={map.window} />
                ))}
              </ol>
            ) : (
              <p className="text-sm">Nothing: the request fails with the error of its deployment.</p>
            )}
          </div>
        )}
        <div className="space-y-3">
          {node.group?.deployments?.length > 0 && (
            <div>
              <h4 className="mb-1 text-xs font-medium text-muted-foreground">
                {node.group.deployments.length > 1 ? `Load-balanced over ${node.group.deployments.length} deployments` : 'Deployment'}
              </h4>
              <ul className="space-y-0.5 text-sm">
                {node.group.deployments.map((d, i) => (
                  // eslint-disable-next-line react/no-array-index-key
                  <li key={`${d.model}|${d.apiBase}|${i}`} className="break-all">
                    {d.model}
                    {d.apiBase && <span className="text-muted-foreground"> · {d.apiBase}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {aliases.length > 0 && (
            <div>
              <h4 className="mb-1 text-xs font-medium text-muted-foreground">Also asked for as</h4>
              <p className="break-all text-sm">{aliases.join(', ')}</p>
            </div>
          )}
          {node.flags.length > 0 && (
            <ul className="space-y-0.5 text-xs">
              {node.flags.map((f) => (
                <li key={f.text} className={TONE_CLASS[f.tone]}>
                  {f.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

function Legend({ hasObserved }) {
  const line = (state) => {
    const s = LINK_STYLE[state];
    return (
      <svg width="24" height="6" aria-hidden="true">
        <line x1="0" y1="3" x2="24" y2="3" stroke={s.stroke} strokeWidth="2" strokeDasharray={s.dash} />
      </svg>
    );
  };
  const items = hasObserved
    ? [
        ['used', 'taken (width = how often)'],
        ['unused', 'configured, never taken'],
        ['unconfigured', 'taken, not in config'],
      ]
    : [['configured', 'configured fallback']];
  return (
    <>
      {items.map(([state, text]) => (
        <span key={state} className="inline-flex items-center gap-1">
          {line(state)} {text}
        </span>
      ))}
      <span className="inline-flex items-center gap-1">
        <span className="inline-block h-3 w-4 rounded-sm border border-dashed border-orange-400" /> external API
      </span>
    </>
  );
}

// FallbackMap draws the LiteLLM fallback configuration over what happened:
// the names callers use, the model group each is served by and the groups
// LiteLLM tries, in order, when it fails. Above it, when LiteLLM gives up
// on a deployment (settings) and what to look at (issues). Clicking a node
// lights its links and opens its chain, with why each fallback was taken.
export function FallbackMap({ routing }) {
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState(null);
  const map = useMemo(() => buildFallbackMap(routing, { showAll }), [routing, showAll]);
  const lay = useMemo(() => layoutFallbackMap(map), [map]);
  const nodes = map.columns.flat();
  const current = nodes.find((n) => n.id === selected) || null;
  const lit = useMemo(() => neighbours(map, current?.id), [map, current]);
  const { totals } = map;

  return (
    <div className="space-y-3">
      <p className="text-sm">
        <span className="font-medium">{totals.withFallback}</span> of {totals.groups} model groups have a fallback
        {map.hasObserved && (
          <>
            {' · '}
            <span className="font-medium">{compact(totals.used)}</span> fallbacks taken in {map.window}
            {totals.failed > 0 && <span className={TONE_CLASS.bad}> · {compact(totals.failed)} failed there too</span>}
          </>
        )}
      </p>

      {map.settings.length > 0 && (
        <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2" aria-label="When LiteLLM falls back">
          {map.settings.map((s) => (
            <div key={s.label} className="flex gap-2">
              <dt className="shrink-0 text-muted-foreground">{s.label}</dt>
              <dd>{s.text}</dd>
            </div>
          ))}
        </dl>
      )}

      {map.issues.length > 0 && (
        <ul className="space-y-1 rounded-lg border border-dashed px-3 py-2 text-xs" aria-label="Things to look at">
          {map.issues.map((i) => {
            const Icon = ISSUE[i.severity]?.icon || Info;
            return (
              <li key={i.text} className="flex gap-2">
                <Icon className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', ISSUE[i.severity]?.className)} aria-hidden="true" />
                <span>{i.text}</span>
              </li>
            );
          })}
        </ul>
      )}

      {totals.withFallback === 0 && !map.columns[2].length ? (
        <p className="py-4 text-center text-xs text-muted-foreground">No fallbacks are configured: every failure is returned to the caller.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <Legend hasObserved={map.hasObserved} />
            <span>Click a node for its chain.</span>
            {showAll && totals.without > 0 && (
              <button type="button" className="rounded-md border px-2 py-0.5 hover:text-foreground" onClick={() => setShowAll(false)}>
                Hide groups with no fallback
              </button>
            )}
          </div>
          <div className="overflow-x-auto">
            <svg viewBox={`0 0 ${lay.width} ${lay.height}`} className="min-w-[760px]" role="group" aria-label="Fallback map">
              {FALLBACK_COLUMNS.map((c, i) => (
                <text key={c} x={lay.colX[i] + lay.nodeW / 2} y={14} textAnchor="middle" className="fill-muted-foreground text-[12px]">
                  {c}
                </text>
              ))}
              {lay.links.map((l) => {
                const s = LINK_STYLE[l.state];
                const off = lit && !lit.links.has(l.key);
                return (
                  <g key={l.key} opacity={off ? 0.08 : 1}>
                    <path d={l.d} fill="none" stroke={s.stroke} strokeWidth={l.width} strokeDasharray={s.dash} strokeOpacity={s.opacity}>
                      <title>{l.col === 0 ? 'alias' : `${l.from} → ${l.to}: ${STATE_TEXT[l.state]}${l.used ? `, ${compact(l.used)} times` : ''}`}</title>
                    </path>
                    {l.label && (
                      <text
                        x={l.labelX}
                        y={l.labelY - 5}
                        textAnchor="middle"
                        className="fill-foreground text-[10px]"
                        style={{ paintOrder: 'stroke', stroke: 'hsl(var(--card))', strokeWidth: 3 }}
                      >
                        {l.label}
                      </text>
                    )}
                  </g>
                );
              })}
              {lit &&
                lay.links
                  .filter((l) => lit.links.has(l.key) && l.state === 'used')
                  .map((l) => (
                    <path
                      key={`ants-${l.key}`}
                      d={l.d}
                      fill="none"
                      stroke="white"
                      strokeOpacity={0.85}
                      strokeWidth={Math.max(1.25, Math.min(l.width * 0.45, 4))}
                      className="marching-ants"
                      data-testid="ants"
                    />
                  ))}
              {nodes.map((n) => (
                <Node
                  key={n.id}
                  n={n}
                  box={lay.box.get(n.id)}
                  dimmed={Boolean(lit) && !lit.nodes.has(n.id)}
                  selected={n.id === current?.id}
                  onSelect={setSelected}
                  onExpand={() => {
                    setSelected(null);
                    setShowAll(true);
                  }}
                />
              ))}
            </svg>
          </div>
        </>
      )}
      {current && <Details map={map} node={current} onClose={() => setSelected(null)} />}
    </div>
  );
}
