import React, { useState, useCallback, useMemo } from 'react';
import axios from 'axios';
import { Area, Bar, Line, ComposedChart, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { cn } from '../../lib/utils';
import { API_URL } from '../../lib/api';
import { SimpleSelect } from '../ui/simple-select';
import { usePolling } from '../../hooks/usePolling';
import { SPLIT_DIMS } from './GatewayCard';
import { formatTokens } from './shared';

// GATEWAY_HIST_COLORS is a minimal monochrome violet ramp for the daily
// usage chart: one hue, ranked by usage across the window (index 0 =
// biggest consumer = darkest). Keeping a single hue keeps the chart calm no
// matter how many split values exist, and lets bar shade encode dominance
// without a legend.
const GATEWAY_HIST_COLORS = [
  '#4c1d95', '#6d28d9', '#7c3aed', '#8b5cf6', '#9f67f7',
  '#a78bfa', '#b4a0fb', '#c4b5fd', '#d4c6fe', '#e3dcff',
];

// Clamp a 0..1 t onto the violet ramp.
function rampColor(t) {
  const c = GATEWAY_HIST_COLORS;
  const x = Math.min(0.9999, Math.max(0, t)) * (c.length - 1);
  const i = Math.floor(x);
  return c[i];
}

// Custom tooltip for the per-day usage chart: a card with the day header, the
// hovered split value's contribution (value, % of day, % of window) and the
// day total. Richer than the default tooltip without adding visual noise.
function GatewayHistoryTooltip({ active, payload, label, focus, colorOf, fmtValue, windowSum }) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0].payload;
  if (!row) return null;
  const isToday = label === new Date().toISOString().slice(0, 10);
  // Rows in the payload are in reverse render order; surface the focused
  // series first, then the rest by size.
  const items = payload
    .filter((p) => p.value > 0)
    .sort((a, b) => (b.value - a.value) || (a.dataKey < b.dataKey ? -1 : 1));
  const first = focus || items[0];
  const share = first && row.total > 0 ? (first.value / row.total) * 100 : null;
  const windowShare = first && windowSum > 0 ? (first.value / windowSum) * 100 : null;
  return (
    <div className="rounded-lg border border-purple-500/30 bg-card px-3 py-2 text-[11px] shadow-lg backdrop-blur">
      <div className="mb-1 flex items-baseline gap-2 font-semibold text-foreground">
        <span className="font-mono">{label}</span>
        {isToday && (
          <span className="rounded bg-purple-100 px-1 text-[10px] font-medium text-purple-700 dark:bg-purple-500/25 dark:text-purple-300">today, so far</span>
        )}
      </div>
      {first && first.value > 0 && (
        <div className="mb-1 flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: colorOf(first.dataKey) }} />
          <span className="max-w-[160px] truncate font-medium" style={{ color: colorOf(first.dataKey) }}>{first.dataKey}</span>
          <span className="ml-auto font-mono font-semibold text-foreground">{fmtValue(first.value)}</span>
        </div>
      )}
      {share != null && (
        <div className="mb-1 font-mono text-[10px] text-muted-foreground">
          {share.toFixed(1)}% of day{windowShare != null && windowShare > 0 ? ` · ${windowShare.toFixed(1)}% of window` : ''}
        </div>
      )}
      <div className="flex items-center justify-between border-t border-purple-500/20 pt-1 text-[10px] text-muted-foreground">
        <span>day total</span>
        <span className="font-mono font-medium text-foreground/80">{fmtValue(row.total)}</span>
      </div>
    </div>
  );
}

// GatewayCostHistory renders the LiteLLM gateway's per-day spend and token
// usage (UTC days, 00:00–23:59) as a historical dashboard: a stacked bar chart
// (one bar per day, split by the active Split-by dimension) with an optional
// fleet-total line, plus a per-day table (day / spend / tokens / top consumer).
// It is self-contained: it fetches
// /api/v1/serving/gateway/history?split=...&window=... and refreshes every
// 60s (the backend samples the gateway's cumulative counters on the 60s
// interval and folds deltas into per-day totals in its store, so closed days
// are read only from the store and today updates live).
export function GatewayCostHistory({ split = 'app' }) {
  const [windowDays, setWindowDays] = useState('14');
  const [metric, setMetric] = useState('spend'); // 'spend' | 'tokens'
  const [showTotal, setShowTotal] = useState(true);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [focus, setFocus] = useState(null); // series hovered (chart bar or legend)
  const [pinned, setPinned] = useState(null); // series click-pinned in the legend

  const fetchHistory = useCallback(async () => {
    try {
      const res = await axios.get(`${API_URL}/api/v1/serving/gateway/history`, {
        params: { split, window: `${windowDays}d` },
      });
      setData(res.data);
      setError(null);
    } catch (err) {
      // Non-fatal: the history is an enhancement, never block the card.
      setData(null);
      setError(err.response?.data?.error || err.message || 'Failed to load cost history');
    }
  }, [split, windowDays]);

  usePolling(fetchHistory, 60000);

  // Per-day rollup: one row per UTC day (00:00–23:59). `cell` holds both
  // spend and tokens per split value (so the table can show both columns while
  // the chart shows the selected metric). `names` is the union of values
  // across ALL days in the window, so a value may be absent from any given
  // day's cell — every cell access is guarded. The fleet total is value ""
  // (label "Fleet") and only present for split=total.
  const byDay = useMemo(() => {
    try {
      if (!data || !Array.isArray(data.days)) return { rows: [], names: [] };
      const perDay = {};
      const byVal = {};
      data.days.forEach((d) => {
        const v = d.value || 'Fleet';
        if (!perDay[d.day]) perDay[d.day] = {};
        if (!perDay[d.day][v]) perDay[d.day][v] = { spend: 0, tokens: 0 };
        perDay[d.day][v].spend += d.spend;
        perDay[d.day][v].tokens += d.tokens;
        byVal[v] = true;
      });
      const names = Object.keys(byVal).sort();
      const hasSplitValues = names.some((n) => n !== 'Fleet');
      const rows = Object.keys(perDay).sort().map((day) => {
        const cell = perDay[day];
        let top = '—';
        if (hasSplitValues && names.filter((n) => n !== 'Fleet').length > 1) {
          // Only values that actually have activity on THIS day are candidates.
          top =
            names
              .filter((n) => n !== 'Fleet')
              .filter((n) => cell[n])
              .sort((a, b) => cell[b][metric] - cell[a][metric])[0] || '—';
        }
        const row = { day, top, today: day === new Date().toISOString().slice(0, 10) };
        let sumSpend = 0;
        let sumTokens = 0;
        let sumMetric = 0;
        names.forEach((n) => {
          const c = cell[n];
          row[n] = c ? c[metric] : 0;
          if (n !== 'Fleet' && c) {
            sumSpend += c.spend;
            sumTokens += c.tokens;
            sumMetric += row[n];
          }
        });
        const fleet = cell['Fleet'];
        row.spend = hasSplitValues ? sumSpend : fleet ? fleet.spend : 0;
        row.tokens = hasSplitValues ? sumTokens : fleet ? fleet.tokens : 0;
        row.total = hasSplitValues ? sumMetric : fleet ? fleet[metric] : 0;
        return row;
      });
      return { rows, names };
    } catch (e) {
      // A malformed history payload must degrade to "no chart", never crash
      // the whole Serving tab.
      console.error('gateway cost history: failed to build per-day rollup', e);
      return { rows: [], names: [] };
    }
  }, [data, metric]);

  const fmtValue = (v) =>
    metric === 'spend' ? `$${v != null ? v.toFixed(2) : '0'}` : formatTokens(v);
  const fmtAxis = (v) =>
    metric === 'spend' ? (v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(0)}`) : formatTokens(v);

  const colLabel = (SPLIT_DIMS.find((d) => d.key === split) || SPLIT_DIMS[0]).label;
  const stackSeries = byDay.names;
  const hasData = byDay.rows.length > 0;

  // Series are colored on a single-hue ramp ranked by their window total
  // (biggest consumer = darkest). The ranking is computed per active metric
  // so the shading always matches what the bars show.
  const seriesStats = useMemo(() => {
    const per = {};
    byDay.rows.forEach((r) => {
      byDay.names.forEach((n) => {
        const c = (per[n] || (per[n] = { sum: 0, days: 0 }));
        const v = r[n];
        if (v) {
          c.sum += v;
          c.days += 1;
        }
      });
    });
    const totals = byDay.names.map((n) => per[n] ? per[n].sum : 0);
    const max = Math.max(1, ...totals);
    const order = byDay.names
      .slice()
      .sort((a, b) => (per[b] ? per[b].sum : 0) - (per[a] ? per[a].sum : 0));
    return { per, max, order, total: totals.reduce((a, b) => a + b, 0) };
  }, [byDay]);

  const colorOf = (n) => {
    const rank = seriesStats.order.indexOf(n);
    if (rank < 0) return GATEWAY_HIST_COLORS[0];
    return rampColor(rank / Math.max(1, seriesStats.order.length - 1));
  };

  // Active highlight series: hover wins, pinned series is the fallback.
  const focusSeries = focus || pinned;
  const dimOthers = Boolean(focusSeries);

  // Window-level stats for the highlighted series (stat strip + tooltip).
  const focusStats = useMemo(() => {
    if (!focusSeries) return null;
    const per = seriesStats.per[focusSeries];
    if (!per || per.sum <= 0) return null;
    const days = byDay.rows.length || 1;
    let today = 0;
    const last = byDay.rows[byDay.rows.length - 1];
    if (last) today = last[focusSeries] || 0;
    return {
      sum: per.sum,
      days: per.days,
      avg: per.sum / Math.max(1, per.days),
      share: seriesStats.total > 0 ? (per.sum / seriesStats.total) * 100 : 0,
      todayDelta: today - per.sum / days,
    };
  }, [focusSeries, byDay, seriesStats]);

  return (
    <div className="mt-3 rounded-md border border-purple-500/20 bg-card p-2">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold text-purple-700">
          Usage by day <span className="font-normal text-muted-foreground">(UTC, 00:00–23:59)</span>
        </span>
        <div className="ml-auto flex items-center gap-1">
          {(['spend', 'tokens'].map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMetric(m)}
              className={cn(
                'rounded px-2 py-0.5 text-[11px] font-medium capitalize transition-colors',
                metric === m ? 'bg-purple-600 text-white' : 'bg-muted/40 text-muted-foreground hover:bg-accent'
              )}
            >
              {m}
            </button>
          )))}
          <button
            type="button"
            onClick={() => setShowTotal((s) => !s)}
            className={cn(
              'rounded px-2 py-0.5 text-[11px] font-medium transition-colors',
              showTotal ? 'bg-purple-600 text-white' : 'bg-muted/40 text-muted-foreground hover:bg-accent'
            )}
            title="Overlay the daily total as a line"
          >
            Total
          </button>
          <SimpleSelect
            className="h-6 w-[68px] border-purple-500/30 bg-muted/40 px-1.5 py-0 text-[11px] text-muted-foreground"
            ariaLabel="History window"
            title="History window"
            value={windowDays}
            onValueChange={setWindowDays}
            options={['7', '14', '30'].map((w) => ({ value: w, label: `${w}d` }))}
          />
        </div>
      </div>

      {error && (
        <p className="text-[11px] text-amber-600">history unavailable: {error}</p>
      )}

      {hasData ? (
        <>
          <div className="h-[180px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={byDay.rows}
                margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
              >
                <XAxis
                  dataKey="day"
                  tick={{ fontSize: 10 }}
                  tickFormatter={(d) => d.slice(5)} // MM-DD
                  stroke="#a78bfa"
                />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={fmtAxis} width={56} stroke="#a78bfa" />
                <Tooltip
                  content={<GatewayHistoryTooltip
                    focus={focusSeries}
                    colorOf={colorOf}
                    fmtValue={fmtValue}
                    windowSum={seriesStats.total}
                  />}
                  cursor={{ fill: 'rgba(124,58,237,0.06)' }}
                />
                <defs>
                  {focusSeries && (
                    <linearGradient id="gwFocusFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={colorOf(focusSeries)} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={colorOf(focusSeries)} stopOpacity={0.02} />
                    </linearGradient>
                  )}
                </defs>
                {stackSeries.map((n) => (
                  <Bar
                    key={n}
                    dataKey={n}
                    name={n}
                    stackId="day"
                    fill={colorOf(n)}
                    fillOpacity={dimOthers && n !== focusSeries ? 0.18 : 1}
                    isAnimationActive={false}
                    mouseEnter={() => setFocus(n)}
                    mouseLeave={() => setFocus(null)}
                  />
                ))}
                {/* Evolution curve for the highlighted series (all days). */}
                {focusSeries && (
                  <>
                    <Area
                      type="monotone"
                      dataKey={focusSeries}
                      stroke="none"
                      fill="url(#gwFocusFill)"
                      isAnimationActive={false}
                      legendType="none"
                      activeDot={false}
                    />
                    <Line
                      type="monotone"
                      dataKey={focusSeries}
                      name={`${focusSeries} trend`}
                      stroke={colorOf(focusSeries)}
                      strokeWidth={2}
                      dot={{ r: 2.5, strokeWidth: 0, fill: colorOf(focusSeries) }}
                      activeDot={{ r: 4 }}
                      isAnimationActive={false}
                      legendType="none"
                    />
                  </>
                )}
                {showTotal && (
                  <Line
                    type="monotone"
                    dataKey="total"
                    name="Total"
                    stroke="#1f2937"
                    strokeWidth={1.5}
                    dot={false}
                    isAnimationActive={false}
                  />
                )}
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* Pill legend: click to pin, hover to preview; shade = usage rank. */}
          {stackSeries.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {stackSeries.map((n) => {
                const st = seriesStats.per[n];
                const share = st && seriesStats.total > 0 ? (st.sum / seriesStats.total) * 100 : 0;
                const active = focusSeries === n;
                return (
                  <button
                    key={n}
                    type="button"
                    onMouseEnter={() => setFocus(n)}
                    onMouseLeave={() => setFocus(null)}
                    onClick={() => {
                      setFocus(null);
                      setPinned((prev) => (prev === n ? null : n));
                    }}
                    title={`${n} — ${fmtValue(st ? st.sum : 0)} over the window${pinned === n ? ' (pinned — click to release)' : ' (click to pin)'}`}
                    className={cn(
                      'flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium transition-all',
                      active
                        ? 'border-transparent shadow-sm ring-2 ring-purple-300'
                        : 'border-purple-500/20 bg-muted/40 hover:border-purple-500/50 hover:bg-accent',
                      dimOthers && !active && 'opacity-50'
                    )}
                    style={active ? { backgroundColor: colorOf(n) + '14' } : undefined}
                  >
                    <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: colorOf(n) }} />
                    <span className={active ? 'text-foreground' : 'text-muted-foreground'}>{n}</span>
                    <span className="font-mono text-[9px] text-muted-foreground">{share.toFixed(0)}%</span>
                    {pinned === n && (
                      <span className="text-[9px] font-semibold text-purple-600">●</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {/* Live stat strip for the highlighted series. */}
          {focusSeries && focusStats && (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-md border border-purple-500/20 bg-purple-500/10 px-2.5 py-1.5 text-[11px]">
              <span className="flex items-center gap-1.5 font-semibold" style={{ color: colorOf(focusSeries) }}>
                <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: colorOf(focusSeries) }} />
                {focusSeries}
              </span>
              <span className="text-muted-foreground">
                <span className="font-mono font-semibold text-foreground">{fmtValue(focusStats.sum)}</span> over the window
              </span>
              <span className="text-muted-foreground">
                <span className="font-mono font-semibold text-foreground">{focusStats.share.toFixed(1)}%</span> share
              </span>
              <span className="text-muted-foreground">
                <span className="font-mono font-semibold text-foreground">{fmtValue(focusStats.avg)}/day</span> avg
              </span>
              <span className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground">
                <span
                  className={cn(
                    'font-mono font-semibold',
                    focusStats.todayDelta >= 0 ? 'text-emerald-600' : 'text-amber-600'
                  )}
                >
                  {focusStats.todayDelta >= 0 ? '▲' : '▼'} {fmtValue(Math.abs(focusStats.todayDelta))}
                </span>
                today vs avg
              </span>
            </div>
          )}
          {!focusSeries && (
            <p className="mt-1.5 text-[10px] text-muted-foreground/70">
              Hover or click a chip to follow one {colLabel.toLowerCase()} across all days
            </p>
          )}

          <div className="max-h-[160px] overflow-y-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground border-b border-purple-500/30">
                  <th className="py-1 pr-2">Day (UTC)</th>
                  <th className="py-1 pr-2 text-right">Spend</th>
                  <th className="py-1 pr-2 text-right">Tokens</th>
                  <th className="py-1 text-right">Top {colLabel}</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {byDay.rows.slice().reverse().map((r) => (
                  <tr key={r.day} className="border-b border-purple-500/20 last:border-0">
                    <td className="py-1 pr-2">
                      {r.day}
                      {r.today && (
                        <span className="ml-1 rounded bg-purple-500/15 px-1 text-[10px] text-purple-500">
                          today
                        </span>
                      )}
                    </td>
                    <td className="py-1 pr-2 text-right">${r.spend.toFixed(2)}</td>
                    <td className="py-1 pr-2 text-right" title={String(r.tokens)}>{formatTokens(r.tokens)}</td>
                    <td className="py-1 text-right font-sans" title={r.top === '—' ? `single ${colLabel.toLowerCase()} or no split data` : `Highest ${metric} on ${r.day}`}>{r.top}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="py-6 text-center text-[11px] text-muted-foreground">
          {data && data.store === 'memory'
            ? 'no history yet — sampled every 60s; the in-memory store starts empty and resets on restart'
            : 'no history yet'}
        </p>
      )}
    </div>
  );
}
