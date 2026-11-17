// Shaping for the Gateway page's team dashboard, which reads
// /api/v1/serving/gateway/dashboard (LiteLLM metrics from Prometheus).
// Pure so it is tested on its own.

export const RANGES = [
  { value: 'month', label: 'This month' },
  { value: '24h', label: '24 h' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
];
export const RANGE_VALUES = RANGES.map((r) => r.value);

// Same violet ramp as the gateway's other charts: biggest = darkest.
export const MODEL_COLORS = ['#4c1d95', '#6d28d9', '#8b5cf6', '#a78bfa', '#c4b5fd', '#ddd6fe'];
export const OTHER_COLOR = '#a1a1aa';
const MAX_SERIES = MODEL_COLORS.length;
export const OTHER = 'Other models';

// spendChart pivots [{day, model, value}] into chart rows
// [{day, <model>: value, …}] and the models to draw, biggest spender first.
// Beyond six models the rest are summed as "Other models".
export function spendChart(spendByDay = []) {
  const totals = new Map();
  spendByDay.forEach(({ model, value }) => totals.set(model, (totals.get(model) || 0) + value));
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([m]) => m);
  const folded = ranked.length > MAX_SERIES;
  const kept = new Set(folded ? ranked.slice(0, MAX_SERIES - 1) : ranked);
  const rows = new Map();
  spendByDay.forEach(({ day, model, value }) => {
    if (!rows.has(day)) rows.set(day, { day });
    const row = rows.get(day);
    const key = kept.has(model) ? model : OTHER;
    row[key] = (row[key] || 0) + value;
  });
  const series = ranked
    .filter((m) => kept.has(m))
    .map((m, i) => ({ key: m, color: MODEL_COLORS[i] }));
  if (folded) series.push({ key: OTHER, color: OTHER_COLOR });
  return {
    rows: [...rows.values()].sort((a, b) => a.day.localeCompare(b.day)),
    series,
    total: [...totals.values()].reduce((a, b) => a + b, 0),
  };
}

// tokenChart returns the token rows and which kinds have any data, so a
// LiteLLM without cached-token metrics shows two lines, not a flat third.
export function tokenChart(tokensByDay = []) {
  const has = { input: false, cached: false, output: false };
  const rows = tokensByDay.map((d) => {
    Object.keys(has).forEach((k) => {
      if (d[k] != null) has[k] = true;
    });
    return { day: d.day, input: d.input ?? null, cached: d.cached ?? null, output: d.output ?? null };
  });
  return { rows, kinds: Object.keys(has).filter((k) => has[k]) };
}

// money formats USD (LiteLLM spend is in dollars).
export function money(v) {
  if (v == null) return '—';
  if (v !== 0 && Math.abs(v) < 0.01) return '<$0.01';
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// count formats a counter: 1234 → 1.2k, 2.5M.
export function count(v) {
  if (v == null) return '—';
  const n = Math.round(v);
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`;
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 2 : 1)}M`;
  return `${(n / 1e9).toFixed(2)}B`;
}

export function pct(v, digits = 1) {
  if (v == null) return '—';
  return `${v.toFixed(v > 0 && v < 0.1 ? 2 : digits)}%`;
}

export function seconds(v) {
  if (v == null) return '—';
  return v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`;
}

// duration prints hours as "3 d 4 h", "5 h", "40 min".
export function duration(hours) {
  if (hours == null) return null;
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  const d = Math.floor(hours / 24);
  const h = Math.round(hours % 24);
  if (d === 0) return `${h} h`;
  return h ? `${d} d ${h} h` : `${d} d`;
}

// budgetLine sums up a team budget: {value, detail, tone}. tone is 'warn'
// under 20% left and 'bad' when spent.
export function budgetLine(budget) {
  if (!budget) return null;
  const { remaining, max, remainingShare, hoursToReset } = budget;
  const reset = duration(hoursToReset);
  const value = remainingShare != null ? pct(remainingShare * 100, 0) : money(remaining);
  const parts = [];
  if (remaining != null && max != null) parts.push(`${money(remaining)} of ${money(max)}`);
  if (reset) parts.push(`resets in ${reset}`);
  let tone = '';
  if (remainingShare != null && remainingShare <= 0) tone = 'bad';
  else if (remainingShare != null && remainingShare < 0.2) tone = 'warn';
  return { value, detail: parts.join(' · '), tone };
}

// errorTone colours the error rate: amber from 1%, red from 5%.
export function errorTone(ratePct) {
  if (ratePct == null) return '';
  if (ratePct >= 5) return 'bad';
  if (ratePct >= 1) return 'warn';
  return '';
}

// PANEL_LABELS names the panels the API can report as failed.
const PANEL_LABELS = {
  summary: 'summary',
  budget: 'budget',
  spendByDay: 'spend per day',
  tokensByDay: 'tokens per day',
  developers: 'developers',
  models: 'latency per model',
  outputSpeed: 'output speed',
  options: 'filter choices',
};

// failedPanels lists the panels Prometheus could not answer, readably.
export function failedPanels(errors) {
  if (!errors) return [];
  return Object.keys(errors)
    .sort()
    .map((k) => ({ panel: PANEL_LABELS[k] || k, error: errors[k] }));
}

// selectOptions turns a list into select options with an "All" entry, and
// keeps the current value even when the window no longer lists it, so a
// shared link never shows a blank select.
export function selectOptions(values = [], current = '', allLabel = 'All') {
  const list = current && !values.includes(current) ? [current, ...values] : values;
  return [{ value: '', label: allLabel }, ...list.map((v) => ({ value: v, label: v }))];
}

// errorShare is failed / requests as a percentage (null without requests).
export function errorShare(failed, requests) {
  if (!requests) return null;
  return ((failed || 0) / requests) * 100;
}
