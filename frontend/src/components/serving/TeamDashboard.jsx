import React, { useMemo } from 'react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AlertTriangle, Users } from 'lucide-react';
import { cn } from '../../lib/utils';
import { SimpleSelect } from '../ui/simple-select';
import { SkeletonRows } from '../ui/skeleton';
import { useUrlParam } from '../../hooks/useUrlParam';
import { useGatewayDashboard } from '../../hooks/useGatewayDashboard';
import {
  RANGES,
  RANGE_VALUES,
  budgetLine,
  count,
  errorShare,
  errorTone,
  failedPanels,
  money,
  pct,
  seconds,
  selectOptions,
  spendChart,
  tokenChart,
} from '../../lib/teamDashboard';

const TONE = {
  '': 'text-foreground',
  warn: 'text-amber-600 dark:text-amber-400',
  bad: 'text-red-600 dark:text-red-400',
};

const TOKEN_LINES = {
  input: { label: 'Input', color: '#6d28d9' },
  cached: { label: 'Cached input', color: '#c4b5fd' },
  output: { label: 'Output', color: '#14b8a6' },
};

const axisTick = { fontSize: 11, fill: 'hsl(var(--muted-foreground))' };
const tooltipStyle = {
  background: 'hsl(var(--popover))',
  border: '1px solid hsl(var(--border))',
  borderRadius: 8,
  fontSize: 12,
};
const shortDay = (d) => d.slice(5);

function Tile({ label, value, detail, tone = '' }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn('text-lg font-semibold tabular-nums', TONE[tone])}>{value}</div>
      {detail && <div className="text-xs text-muted-foreground">{detail}</div>}
    </div>
  );
}

function Panel({ title, note, children }) {
  return (
    <section className="rounded-lg border p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        {note && <span className="text-xs text-muted-foreground">{note}</span>}
      </div>
      {children}
    </section>
  );
}

function Empty({ children = 'No data in this window.' }) {
  return <p className="py-6 text-center text-xs text-muted-foreground">{children}</p>;
}

// TeamDashboard is the per-team view of LiteLLM usage on the Gateway page:
// spend against budget, requests and errors, spend and tokens per day, one
// row per API key and latency per model, read from Prometheus. Anyone who
// can open the app sees every team; the team is a filter, not a login.
// Filters are URL params (?team=&model=&key=&range=) so a view can be shared.
export function TeamDashboard() {
  const [team, setTeam] = useUrlParam('team', '');
  const [model, setModel] = useUrlParam('model', '');
  const [key, setKey] = useUrlParam('key', '');
  const [range, setRange] = useUrlParam('range', 'month', RANGE_VALUES);
  const { status, data, error } = useGatewayDashboard({ team, model, key, range });

  const spend = useMemo(() => spendChart(data?.spendByDay), [data]);
  const tokens = useMemo(() => tokenChart(data?.tokensByDay), [data]);

  if (status === 'unavailable') {
    return (
      <p className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
        Team usage, budgets and spend per day come from LiteLLM's metrics in Prometheus. Set{' '}
        <code className="text-xs">PROMETHEUS_URL</code> (chart value <code className="text-xs">usage.prometheusUrl</code>)
        to a Prometheus that scrapes LiteLLM to see them here.
      </p>
    );
  }

  const options = data?.options || {};
  const s = data?.summary || {};
  const budget = budgetLine(data?.budget);
  const errRate = s.errorRatePct ?? errorShare(s.failed, s.requests);
  const failed = failedPanels(data?.errors);
  const rangeLabel = RANGES.find((r) => r.value === range)?.label;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Users className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <SimpleSelect
          ariaLabel="Team"
          value={team}
          onValueChange={setTeam}
          options={selectOptions(options.teams, team, 'All teams')}
          className="w-44"
        />
        <SimpleSelect
          ariaLabel="Model alias"
          value={model}
          onValueChange={setModel}
          options={selectOptions(options.models, model, 'All models')}
          className="w-52"
        />
        <SimpleSelect
          ariaLabel="API key"
          value={key}
          onValueChange={setKey}
          options={selectOptions(options.keys, key, 'All API keys')}
          className="w-44"
        />
        <SimpleSelect ariaLabel="Range" value={range} onValueChange={setRange} options={RANGES} className="w-32" />
        {data?.from && data?.to && (
          <span className="text-xs text-muted-foreground">
            UTC days · {String(data.from).slice(0, 10)} → {String(data.to).slice(0, 10)}
          </span>
        )}
      </div>

      {status === 'error' && (
        <p role="alert" className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          Could not load team usage{error ? `: ${error}` : ''}.{data ? ' Showing the last answer.' : ''}
        </p>
      )}
      {failed.length > 0 && (
        <p className="text-xs text-muted-foreground" title={failed.map((f) => `${f.panel}: ${f.error}`).join('\n')}>
          Prometheus did not answer for: {failed.map((f) => f.panel).join(', ')}.
        </p>
      )}

      {!data ? (
        <SkeletonRows rows={5} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
            <Tile label={`Spend · ${rangeLabel}`} value={money(s.spend)} />
            {budget ? (
              <Tile label="Team budget left" value={budget.value} detail={budget.detail} tone={budget.tone} />
            ) : (
              <Tile label="Team budget left" value="—" detail={team ? 'No budget set' : 'Pick a team'} />
            )}
            <Tile label="Requests" value={count(s.requests)} />
            <Tile label="Active API keys" value={count(s.activeDevelopers)} />
            <Tile label="Error rate" value={pct(errRate)} detail={`${count(s.failed)} failed`} tone={errorTone(errRate)} />
            <Tile label="Throttled (429)" value={count(s.throttled)} tone={s.throttled > 0 ? 'warn' : ''} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Spend per day by model" note={`${money(spend.total)} total`}>
              {spend.rows.length === 0 ? (
                <Empty />
              ) : (
                <>
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={spend.rows} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                      <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
                      <XAxis dataKey="day" tickFormatter={shortDay} tick={axisTick} tickLine={false} axisLine={false} />
                      <YAxis tickFormatter={(v) => `$${count(v)}`} tick={axisTick} tickLine={false} axisLine={false} width={48} />
                      <Tooltip contentStyle={tooltipStyle} formatter={(v, n) => [money(v), n]} cursor={{ fill: 'hsl(var(--muted))' }} />
                      {spend.series.map((m) => (
                        <Bar key={m.key} dataKey={m.key} stackId="s" fill={m.color} isAnimationActive={false} />
                      ))}
                    </BarChart>
                  </ResponsiveContainer>
                  <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    {spend.series.map((m) => (
                      <li key={m.key} className="flex items-center gap-1">
                        <span className="inline-block h-2 w-2 rounded-sm" style={{ background: m.color }} />
                        {m.key}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </Panel>

            <Panel title="Tokens per day">
              {tokens.rows.length === 0 || tokens.kinds.length === 0 ? (
                <Empty />
              ) : (
                <>
                  <ResponsiveContainer width="100%" height={220}>
                    <LineChart data={tokens.rows} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                      <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
                      <XAxis dataKey="day" tickFormatter={shortDay} tick={axisTick} tickLine={false} axisLine={false} />
                      <YAxis tickFormatter={count} tick={axisTick} tickLine={false} axisLine={false} width={48} />
                      <Tooltip contentStyle={tooltipStyle} formatter={(v, n) => [count(v), TOKEN_LINES[n]?.label || n]} />
                      {tokens.kinds.map((k) => (
                        <Line
                          key={k}
                          dataKey={k}
                          stroke={TOKEN_LINES[k].color}
                          strokeWidth={2}
                          dot={false}
                          connectNulls
                          isAnimationActive={false}
                        />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                  <ul className="mt-2 flex gap-3 text-xs text-muted-foreground">
                    {tokens.kinds.map((k) => (
                      <li key={k} className="flex items-center gap-1">
                        <span className="inline-block h-0.5 w-3" style={{ background: TOKEN_LINES[k].color }} />
                        {TOKEN_LINES[k].label}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </Panel>
          </div>

          <Panel title="API keys" note={key ? 'Filtered to one key' : 'Click a key to filter'}>
            {!data.developers?.length ? (
              <Empty />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="py-1 pr-3 font-normal">API key</th>
                      <th className="py-1 pr-3 text-right font-normal">Spend</th>
                      <th className="py-1 pr-3 text-right font-normal">Tokens</th>
                      <th className="py-1 pr-3 text-right font-normal">Requests</th>
                      <th className="py-1 pr-3 text-right font-normal">Errors</th>
                      <th className="py-1 pr-3 text-right font-normal">Key budget left</th>
                      <th className="py-1 text-right font-normal">TTFT p95</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.developers.map((d) => {
                      const rate = errorShare(d.failed, d.requests);
                      return (
                        <tr key={d.key} className="border-t">
                          <td className="py-1 pr-3">
                            <button
                              type="button"
                              className={cn('font-mono text-xs hover:underline', d.key === key && 'font-semibold text-primary')}
                              onClick={() => setKey(d.key === key ? '' : d.key)}
                            >
                              {d.key}
                            </button>
                          </td>
                          <td className="py-1 pr-3 text-right tabular-nums">{money(d.spend)}</td>
                          <td className="py-1 pr-3 text-right tabular-nums">{count(d.tokens)}</td>
                          <td className="py-1 pr-3 text-right tabular-nums">{count(d.requests)}</td>
                          <td className={cn('py-1 pr-3 text-right tabular-nums', TONE[errorTone(rate)])}>{pct(rate)}</td>
                          <td className="py-1 pr-3 text-right tabular-nums">{money(d.budgetRemaining)}</td>
                          <td className="py-1 text-right tabular-nums">{seconds(d.ttftP95Seconds)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Time to first token by model">
              {!data.models?.length ? (
                <Empty />
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="py-1 pr-3 font-normal">Model alias</th>
                      <th className="py-1 pr-3 text-right font-normal">Requests</th>
                      <th className="py-1 pr-3 text-right font-normal">p50</th>
                      <th className="py-1 text-right font-normal">p95</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.models.map((m) => (
                      <tr key={m.model} className="border-t">
                        <td className="py-1 pr-3">
                          <button
                            type="button"
                            className={cn('text-left hover:underline', m.model === model && 'font-semibold text-primary')}
                            onClick={() => setModel(m.model === model ? '' : m.model)}
                          >
                            {m.model}
                          </button>
                        </td>
                        <td className="py-1 pr-3 text-right tabular-nums">{count(m.requests)}</td>
                        <td className="py-1 pr-3 text-right tabular-nums">{seconds(m.ttftP50Seconds)}</td>
                        <td className="py-1 text-right tabular-nums">{seconds(m.ttftP95Seconds)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>
            <Panel title="Output speed per model" note="All teams: LiteLLM does not label it by team">
              {!data.outputSpeed?.length ? (
                <Empty />
              ) : (
                <table className="w-full text-sm">
                  <tbody>
                    {data.outputSpeed.map((m) => (
                      <tr key={m.modelGroup} className="border-t first:border-t-0">
                        <td className="py-1 pr-3">{m.modelGroup}</td>
                        <td className="py-1 text-right tabular-nums">{m.tokensPerSecond.toFixed(1)} tok/s</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}
