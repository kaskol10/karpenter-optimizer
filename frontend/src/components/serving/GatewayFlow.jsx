import React, { useMemo, useState } from 'react';
import { Layer, Rectangle, ResponsiveContainer, Sankey, Tooltip } from 'recharts';
import { cn } from '../../lib/utils';
import { buildFlow, topFlows } from '../../lib/gatewayFlow';
import { formatTokens } from './shared';

// Same single-hue ramp as the Usage by day chart: the biggest source is the
// darkest, so a source keeps its shade between the two charts.
const SOURCE_RAMP = ['#4c1d95', '#6d28d9', '#7c3aed', '#8b5cf6', '#a78bfa', '#c4b5fd', '#d4c6fe', '#e3dcff'];
const OTHER_COLOR = '#a1a1aa';
const TARGET_COLOR = '#64748b';

const METRICS = [
  { key: 'tokens', label: 'Tokens' },
  { key: 'spend', label: 'Spend' },
];

const NOUN = { apps: 'app', apiKeys: 'API key', teams: 'team' };

export const formatFlowValue = (metric, v) => (metric === 'spend' ? `$${v.toFixed(2)}` : formatTokens(Math.round(v)));
const pct = (share) => `${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%`;

function nodeColor(node, index) {
  if (node.other) return OTHER_COLOR;
  if (node.side === 'target') return TARGET_COLOR;
  return SOURCE_RAMP[Math.min(index, SOURCE_RAMP.length - 1)];
}

// FlowNode draws a node bar with its name and value; sources are labelled
// on their right, models on their left, so labels sit inside the chart.
function FlowNode({ x, y, width, height, index, payload, metric, total }) {
  const isSource = payload.side === 'source';
  const color = nodeColor(payload, index);
  const labelX = isSource ? x + width + 6 : x - 6;
  return (
    <Layer key={`node-${index}`}>
      <Rectangle x={x} y={y} width={width} height={height} fill={color} fillOpacity={0.9} radius={2} />
      {height >= 8 && (
        <text
          x={labelX}
          y={y + height / 2}
          textAnchor={isSource ? 'start' : 'end'}
          dominantBaseline="middle"
          className="fill-foreground text-[11px]"
        >
          {payload.name}
          <tspan className="fill-muted-foreground">
            {'  '}
            {formatFlowValue(metric, payload.value)} · {pct(total ? payload.value / total : 0)}
          </tspan>
        </text>
      )}
    </Layer>
  );
}

// FlowLink draws a link in its source's colour, stronger when hovered.
function FlowLink({ sourceX, targetX, sourceY, targetY, sourceControlX, targetControlX, linkWidth, index, payload, active, onHover }) {
  const color = nodeColor(payload.source, payload.source.sourceRank ?? 0);
  return (
    <path
      key={`link-${index}`}
      d={`M${sourceX},${sourceY} C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}`}
      fill="none"
      stroke={color}
      strokeWidth={Math.max(1, linkWidth)}
      strokeOpacity={active === null ? 0.35 : active === index ? 0.75 : 0.12}
      onMouseEnter={() => onHover(index)}
      onMouseLeave={() => onHover(null)}
    />
  );
}

function FlowTooltip({ active, payload, metric, total }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload?.payload || payload[0].payload;
  if (!p) return null;
  const isLink = p.source && p.target;
  const name = isLink ? `${p.source.name} → ${p.target.name}` : p.name;
  return (
    <div className="rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md">
      <p className="font-medium">{name}</p>
      <p className="text-muted-foreground">
        {formatFlowValue(metric, p.value)} · {pct(total ? p.value / total : 0)} of all
      </p>
    </div>
  );
}

// GatewayFlow is the gateway's flow view: a Sankey from the Split-by values
// (apps, API keys or teams) on the left to models on the right, links sized
// by tokens or spend, with the largest flows listed underneath (the list is
// also what screen readers get). width is for tests; the chart is
// responsive otherwise.
export function GatewayFlow({ gateway, dimField = 'apps', dimLabel = 'App', width }) {
  const [metric, setMetric] = useState('tokens');
  const [activeLink, setActiveLink] = useState(null);
  const flow = useMemo(() => buildFlow(gateway, { dimField, noun: NOUN[dimField] || 'app', metric }), [gateway, dimField, metric]);
  const rows = useMemo(() => topFlows(flow, 5), [flow]);

  // recharts mutates node and link objects while laying out; hand it copies,
  // and remember each source's rank for its colour.
  const data = useMemo(() => {
    const nodes = flow.nodes.map((n, i) => ({ ...n, sourceRank: n.side === 'source' ? i : undefined }));
    return { nodes, links: flow.links.map((l) => ({ ...l })) };
  }, [flow]);

  const sourceCount = flow.nodes.filter((n) => n.side === 'source').length;
  const targetCount = flow.nodes.length - sourceCount;
  const height = Math.max(180, Math.min(420, Math.max(sourceCount, targetCount) * 34));

  const chart = (
    <Sankey
      data={data}
      nodePadding={14}
      nodeWidth={10}
      margin={{ top: 8, right: 8, bottom: 8, left: 8 }}
      node={<FlowNode metric={metric} total={flow.total} />}
      link={<FlowLink active={activeLink} onHover={setActiveLink} />}
      iterations={32}
      {...(width ? { width, height } : {})}
    >
      <Tooltip content={<FlowTooltip metric={metric} total={flow.total} />} />
    </Sankey>
  );

  return (
    <section aria-label="Gateway flow" className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <span>
          {dimLabel} → model, by
        </span>
        <div className="flex items-center gap-1" role="group" aria-label="Flow measure">
          {METRICS.map((m) => (
            <button
              key={m.key}
              type="button"
              aria-pressed={metric === m.key}
              onClick={() => setMetric(m.key)}
              className={cn(
                'rounded px-2 py-0.5 font-medium transition-colors',
                metric === m.key ? 'bg-purple-600 text-white' : 'bg-muted/40 hover:bg-accent',
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
        {(flow.folded.sources > 0 || flow.folded.targets > 0) && <span>Smaller flows are grouped as “other”.</span>}
      </div>

      {flow.links.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
          No {metric === 'spend' ? 'spend' : 'token'} usage per {dimLabel.toLowerCase()} and model yet.
          {metric === 'spend' ? ' The gateway may not track spend.' : ''}
        </p>
      ) : (
        <>
          <div aria-hidden="true">
            {width ? (
              chart
            ) : (
              <ResponsiveContainer width="100%" height={height}>
                {chart}
              </ResponsiveContainer>
            )}
          </div>
          <table className="w-full text-xs">
            <caption className="sr-only">Largest flows</caption>
            <thead>
              <tr className="border-b border-purple-500/30 text-left text-muted-foreground">
                <th className="py-1 pr-2 font-normal">Largest flows</th>
                <th className="py-1 pr-2 text-right font-normal">{metric === 'spend' ? 'Spend' : 'Tokens'}</th>
                <th className="py-1 text-right font-normal">Share</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {rows.map((r) => (
                <tr key={`${r.from}→${r.to}`} className="border-b border-purple-500/20 last:border-0">
                  <td className="py-1 pr-2 font-sans">
                    {r.from} → {r.to}
                  </td>
                  <td className="py-1 pr-2 text-right">{formatFlowValue(metric, r.value)}</td>
                  <td className="py-1 text-right">{pct(r.share)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
