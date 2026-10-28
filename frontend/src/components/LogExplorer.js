import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import axios from 'axios';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from './ui/card';
import { Button } from './ui/button';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Badge } from './ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Switch } from './ui/switch';
import { Input } from './ui/input';
import { Label } from './ui/label';
import {
  RefreshCw, Loader2, Search, FileText, AlertTriangle, AlertCircle, Info,
  CheckCircle, Sparkles, ListFilter, X, ChevronUp, ChevronDown, ScrollText,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { EmptyState } from './ui/empty-state';
import { SkeletonRows } from './ui/skeleton';

const API_URL = (window.ENV && window.ENV.hasOwnProperty('REACT_APP_API_URL'))
  ? window.ENV.REACT_APP_API_URL
  : (process.env.REACT_APP_API_URL || '');

const TAIL_OPTIONS = ['100', '500', '1000', '5000'];
// "any" is a non-empty sentinel for "no time window" (Radix Select.Item
// forbids value=""; the empty string is reserved for clearing the selection).
// fetchLogs maps it back to omitting the sinceSeconds query param.
const SINCE_OPTIONS = [
  { value: 'any', label: 'Any time (by tail)' },
  { value: '300', label: 'Last 5m' },
  { value: '900', label: 'Last 15m' },
  { value: '3600', label: 'Last 1h' },
  { value: '86400', label: 'Last 24h' },
];

// isErrorLine is a cheap client-side heuristic that tints likely error lines
// and powers the "errors only" filter. Deliberately broad: false positives are
// cheap (the user still reads the line), false negatives hide real problems.
const ERROR_LINE_RE = /(?:\bERROR\b|level="?error|level=error|error\b|exception|fatal|panic|segfault|denied|refused|timeout|timed out|crash|failed|killed|oom)/i;

function statusVariant(status) {
  switch (status) {
    case 'Running': return 'text-green-600 dark:text-green-400';
    case 'Pending': return 'text-yellow-600 dark:text-yellow-400';
    case 'Failed': return 'text-red-600 dark:text-red-400';
    case 'Succeeded': return 'text-muted-foreground';
    default: return 'text-muted-foreground';
  }
}

// PodRow is one selectable entry in the picker list.
function PodRow({ pod, active, onSelect }) {
  const restarts = pod.restartCount || 0;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'w-full rounded-md border px-3 py-2 text-left transition-colors hover:bg-muted/60',
        active ? 'border-primary bg-muted/40' : 'border-border'
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <code className="truncate text-xs font-semibold" title={`${pod.namespace}/${pod.name}`}>{pod.name}</code>
        <span className={cn('shrink-0 text-[11px] font-medium', statusVariant(pod.status))}>{pod.status}</span>
      </div>
      <div className="mt-0.5 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="truncate">
          {pod.namespace}{pod.nodeName ? ` · ${pod.nodeName}` : ''}
        </span>
        <span className="shrink-0">
          {pod.ready}
          {restarts > 0 && <span className="ml-1 text-red-500" title={`${restarts} container restarts`}>({restarts} restarts)</span>}
          <span className="ml-1">{pod.age}</span>
        </span>
      </div>
    </button>
  );
}

// LogLine renders one log line, optionally tinting error lines and
// highlighting search matches.
function LogLine({ line, isError, query, matchIdx }) {
  const segments = useMemo(() => {
    if (!query) return [line];
    const lower = line.toLowerCase();
    const q = query.toLowerCase();
    const parts = [];
    let i = 0;
    for (;;) {
      const at = lower.indexOf(q, i);
      if (at < 0) { parts.push(line.slice(i)); break; }
      if (at > i) parts.push(line.slice(i, at));
      parts.push({ hit: true, text: line.slice(at, at + q.length) });
      i = at + q.length;
      if (i >= line.length) break;
    }
    return parts;
  }, [line, query]);

  return (
    <div className={cn('flex whitespace-pre px-2 text-xs leading-5', isError && 'bg-red-500/10')}>
      <span className="w-10 shrink-0 select-none pr-2 text-right text-[10px] text-muted-foreground/60">{matchIdx}</span>
      <span className={cn('break-all font-mono', isError && 'text-red-700 dark:text-red-300')}>
        {segments.map((seg, i) => (
          seg && seg.hit
            ? <mark key={i} className="bg-yellow-300/70 text-foreground rounded-[2px]">{seg.text}</mark>
            : <React.Fragment key={i}>{seg}</React.Fragment>
        ))}
      </span>
    </div>
  );
}

function LogExplorer({ seedPod }) {
  const [pods, setPods] = useState([]);
  const [podsLoading, setPodsLoading] = useState(false);
  const [podsError, setPodsError] = useState(null);
  const [nsFilter, setNsFilter] = useState('');
  const [podSearch, setPodSearch] = useState('');
  const [selected, setSelected] = useState(null); // {namespace, name}
  const [containers, setContainers] = useState([]);
  const [container, setContainer] = useState('');
  const [tail, setTail] = useState('500');
  const [since, setSince] = useState('any');
  const [previous, setPrevious] = useState(false);
  const [errorOnly, setErrorOnly] = useState(false);
  const [logs, setLogs] = useState([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState(null);
  const [lastFetched, setLastFetched] = useState(null);
  const [search, setSearch] = useState('');
  const [matchCursor, setMatchCursor] = useState(0);

  // Analysis state
  const [analysis, setAnalysis] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState(null);
  const [analysisSource, setAnalysisSource] = useState(null); // what text was analyzed
  const viewerRef = useRef(null);

  const fetchPods = useCallback(async () => {
    setPodsLoading(true);
    setPodsError(null);
    try {
      const params = {};
      if (nsFilter) params.namespace = nsFilter;
      const res = await axios.get(`${API_URL}/api/v1/pods`, { params });
      setPods(res.data.pods || []);
    } catch (err) {
      setPodsError(err.response?.data?.error || err.message || 'Failed to list pods');
    } finally {
      setPodsLoading(false);
    }
  }, [nsFilter]);

  const fetchLogs = useCallback(async (sel, opts) => {
    if (!sel) return;
    setLogsLoading(true);
    setLogsError(null);
    setAnalysis(null);
    setAnalysisSource(null);
    try {
      const params = {
        namespace: sel.namespace,
        pod: sel.name,
        tailLines: opts?.tail ?? tail,
      };
      if (opts?.container ?? container) params.container = opts?.container ?? container;
      const sinceVal = opts?.since ?? since;
      if (sinceVal && sinceVal !== 'any') params.sinceSeconds = sinceVal;
      if (opts?.previous ?? previous) params.previous = 'true';
      const res = await axios.get(`${API_URL}/api/v1/pods/logs`, { params });
      setLogs(res.data.logs || []);
      setContainers(sel.containers || []);
      setLastFetched(new Date());
    } catch (err) {
      setLogsError(err.response?.data?.error || err.message || 'Failed to fetch logs');
    } finally {
      setLogsLoading(false);
    }
  }, [tail, since, container, previous]);

  useEffect(() => {
    fetchPods();
  }, [fetchPods]);

  // Deep-link from other tabs: a seedPod of "ns/name" selects and fetches it
  // once the pod list has loaded.
  const seedHandled = useRef(null);
  useEffect(() => {
    if (!seedPod || pods.length === 0 || seedHandled.current === seedPod) return;
    const [ns, name] = seedPod.split('/');
    seedHandled.current = seedPod;
    if (name) {
      const found = pods.find((p) => p.namespace === ns && p.name === name);
      if (found) {
        const sel = { namespace: ns, name, containers: found.containers };
        setSelected(sel);
        setNsFilter(ns);
        fetchLogs(sel);
        return;
      }
    }
    // Namespace-only seed (e.g. from a Workloads row): pre-filter and, when a
    // workload name was given, pre-fill the name filter so the user lands on
    // the right pods without an exact pod match.
    if (ns) {
      setNsFilter(ns);
      if (name) setPodSearch(name);
    }
  }, [seedPod, pods, fetchLogs]);

  const handlePodSelect = (pod) => {
    const sel = { namespace: pod.namespace, name: pod.name, containers: pod.containers };
    setSelected(sel);
    setContainer('');
    fetchLogs(sel);
  };

  const refreshLogs = () => {
    if (selected) fetchLogs(selected);
  };

  const namespaces = useMemo(
    () => [...new Set(pods.map((p) => p.namespace))].sort(),
    [pods]
  );

  const visiblePods = useMemo(() => {
    const q = podSearch.toLowerCase();
    const filtered = pods.filter((p) =>
      (!nsFilter || p.namespace === nsFilter) &&
      (!q || p.name.toLowerCase().includes(q) || p.namespace.toLowerCase().includes(q))
    );
    // Karpenter controller pods first (quick access to the old analyzer flow).
    return [...filtered].sort((a, b) => (b.karpenter - a.karpenter) || a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
  }, [pods, nsFilter, podSearch]);

  const karpenterCount = visiblePods.filter((p) => p.karpenter).length;

  // Error lines (client-side) for the "errors only" filter + analyze button.
  const errorLines = useMemo(
    () => logs.map((l, i) => ({ line: l, idx: i })).filter((e) => ERROR_LINE_RE.test(e.line)),
    [logs]
  );

  const shownLines = useMemo(() => {
    if (!errorOnly) return logs.map((l, i) => ({ line: l, idx: i }));
    return errorLines;
  }, [logs, errorOnly, errorLines]);

  // Search match indices (into shownLines) and the active match.
  const matchIdxs = useMemo(() => {
    if (!search) return [];
    const q = search.toLowerCase();
    const out = [];
    shownLines.forEach((e, i) => { if (e.line.toLowerCase().includes(q)) out.push(i); });
    return out;
  }, [search, shownLines]);

  useEffect(() => { setMatchCursor(0); }, [search]);

  // Keep the active search match in view as the user pages through matches.
  useEffect(() => {
    const el = viewerRef.current?.querySelector('[data-active-match="true"]');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [matchCursor, matchIdxs]);

  const activeMatch = matchIdxs[matchCursor];

  const handleAnalyze = async (text, sourceLabel) => {
    const body = (text || '').trim();
    if (!body) {
      setAnalysisError('Nothing to analyze: select lines or widen the log window.');
      return;
    }
    setAnalyzing(true);
    setAnalysisError(null);
    setAnalysis(null);
    setAnalysisSource(sourceLabel);
    try {
      const res = await axios.post(`${API_URL}/api/v1/logs/analyze`, { log: body });
      setAnalysis(res.data);
    } catch (err) {
      setAnalysisError(err.response?.data?.error || err.message || 'Failed to analyze log');
    } finally {
      setAnalyzing(false);
    }
  };

  const handleAnalyzeSelection = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) {
      setAnalysisError('Select log text first (drag inside the log pane), then click Analyze selection.');
      return;
    }
    handleAnalyze(sel.toString(), 'selected text');
  };

  const handleAnalyzeErrors = () => {
    if (errorLines.length === 0) {
      setAnalysisError('No error-looking lines in the current log window.');
      return;
    }
    handleAnalyze(errorLines.map((e) => e.line).join('\n'), `${errorLines.length} error line(s)`);
  };

  const handleAnalyzeTail = () => {
    const tailLines = logs.slice(-50);
    if (tailLines.length === 0) {
      setAnalysisError('No logs fetched yet.');
      return;
    }
    handleAnalyze(tailLines.join('\n'), `last ${tailLines.length} line(s)`);
  };

  const severityColor = (severity) => {
    switch (severity) {
      case 'critical': return 'bg-red-100 text-red-800 border-red-300 dark:bg-red-500/20 dark:text-red-300 dark:border-red-500/40';
      case 'warning': return 'bg-yellow-100 text-yellow-800 border-yellow-300 dark:bg-yellow-500/20 dark:text-yellow-300 dark:border-yellow-500/40';
      default: return 'bg-blue-100 text-blue-800 border-blue-300 dark:bg-blue-500/20 dark:text-blue-300 dark:border-blue-500/40';
    }
  };

  const severityIcon = (severity) => {
    switch (severity) {
      case 'critical': return <AlertCircle className="h-4 w-4" />;
      case 'warning': return <AlertTriangle className="h-4 w-4" />;
      default: return <Info className="h-4 w-4" />;
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex justify-between items-start">
            <div>
              <CardTitle className="flex items-center gap-2">
                <ScrollText className="h-5 w-5 text-primary" />
                Log Explorer
              </CardTitle>
              <CardDescription>
                Pick any pod in the cluster, read its container logs, and get AI (or heuristic)
                analysis of the error lines.
              </CardDescription>
            </div>
            <Button onClick={fetchPods} disabled={podsLoading} size="sm" variant="outline">
              <RefreshCw className={cn('h-4 w-4 mr-2', podsLoading && 'animate-spin')} />
              Refresh pods
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {podsError && (
            <Alert variant="destructive">
              <AlertTitle>Failed to list pods</AlertTitle>
              <AlertDescription>{podsError}</AlertDescription>
            </Alert>
          )}

          {/* Pod picker controls */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Namespace</Label>
              <Select value={nsFilter || 'all'} onValueChange={(v) => setNsFilter(v === 'all' ? '' : v)}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All namespaces</SelectItem>
                  {namespaces.map((ns) => (
                    <SelectItem key={ns} value={ns}>{ns}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label className="text-xs">Pod</Label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Filter by pod or namespace name..."
                  value={podSearch}
                  onChange={(e) => setPodSearch(e.target.value)}
                  className="pl-9 h-9"
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Pod list */}
            <div className="rounded-lg border">
              <div className="flex items-center justify-between border-b px-3 py-2">
                <span className="text-xs font-semibold text-muted-foreground">
                  {visiblePods.length} pod{visiblePods.length !== 1 ? 's' : ''}
                </span>
                {karpenterCount > 0 && (
                  <Badge variant="outline" className="text-[10px]">{karpenterCount} Karpenter</Badge>
                )}
              </div>
              <div className="max-h-[420px] space-y-1.5 overflow-y-auto p-2">
                {podsLoading && pods.length === 0 ? (
                  <SkeletonRows rows={5} />
                ) : visiblePods.length === 0 ? (
                  <EmptyState
                    icon={FileText}
                    title={pods.length === 0 ? 'No pods found' : 'No pods match the filter'}
                    hint={pods.length === 0
                      ? 'Pods appear here once the cluster reports them.'
                      : 'Clear the namespace or name filter.'}
                    className="py-6"
                  />
                ) : (
                  visiblePods.map((pod) => (
                    <PodRow
                      key={`${pod.namespace}/${pod.name}`}
                      pod={pod}
                      active={selected?.namespace === pod.namespace && selected?.name === pod.name}
                      onSelect={() => handlePodSelect(pod)}
                    />
                  ))
                )}
              </div>
            </div>

            {/* Log viewer */}
            <div className="rounded-lg border flex flex-col">
              {!selected ? (
                <div className="flex flex-1 items-center justify-center p-6">
                  <EmptyState
                    icon={ScrollText}
                    title="Select a pod"
                    hint="Choose a pod on the left to fetch its logs. Pods with restarts or non-Running status are usually worth a look."
                    className="border-0"
                  />
                </div>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
                    <code className="text-xs font-semibold">{selected.namespace}/{selected.name}</code>
                    {containers.length > 1 && (
                      <Select value={container || (containers[0] || '')} onValueChange={(v) => { setContainer(v); fetchLogs(selected, { container: v }); }}>
                        <SelectTrigger className="h-7 w-[150px] text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {containers.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    )}
                    <Select value={tail} onValueChange={(v) => { setTail(v); fetchLogs(selected, { tail: v }); }}>
                      <SelectTrigger className="h-7 w-[110px] text-xs" title="Tail lines">
                        <SelectValue placeholder="Tail" />
                      </SelectTrigger>
                      <SelectContent>
                        {TAIL_OPTIONS.map((n) => <SelectItem key={n} value={n}>{n} lines</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <Select value={since} onValueChange={(v) => { setSince(v); fetchLogs(selected, { since: v }); }}>
                      <SelectTrigger className="h-7 w-[150px] text-xs" title="Time window">
                        <SelectValue placeholder="Since" />
                      </SelectTrigger>
                      <SelectContent>
                        {SINCE_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title="Fetch logs from the previous terminated container">
                      <Switch checked={previous} onCheckedChange={(v) => { setPrevious(v); fetchLogs(selected, { previous: v }); }} />
                      previous
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Switch checked={errorOnly} onCheckedChange={setErrorOnly} />
                      errors only
                    </label>
                    <Button variant="outline" size="sm" className="ml-auto h-7" onClick={refreshLogs} disabled={logsLoading}>
                      <RefreshCw className={cn('h-3.5 w-3.5 mr-1', logsLoading && 'animate-spin')} />
                      Refetch
                    </Button>
                    {lastFetched && (
                      <span className="text-[10px] text-muted-foreground" title={lastFetched.toISOString()}>
                        fetched {lastFetched.toLocaleTimeString()}
                      </span>
                    )}
                  </div>

                  {/* Search + analyze toolbar */}
                  <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
                    <div className="relative flex-1 min-w-[180px]">
                      <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        placeholder="Search logs..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="h-7 pl-8 text-xs"
                      />
                      {search && (
                        <button
                          type="button"
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                          onClick={() => setSearch('')}
                          aria-label="Clear search"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                    {search && matchIdxs.length > 0 && (
                      <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                        <button type="button" className="rounded border p-0.5 hover:bg-muted" onClick={() => { setMatchCursor((c) => (c - 1 + matchIdxs.length) % matchIdxs.length); }} aria-label="Previous match"><ChevronUp className="h-3 w-3" /></button>
                        {matchCursor + 1}/{matchIdxs.length}
                        <button type="button" className="rounded border p-0.5 hover:bg-muted" onClick={() => { setMatchCursor((c) => (c + 1) % matchIdxs.length); }} aria-label="Next match"><ChevronDown className="h-3 w-3" /></button>
                      </span>
                    )}
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={handleAnalyzeErrors} disabled={logsLoading || logs.length === 0}>
                      <ListFilter className="h-3 w-3 mr-1" />
                      Analyze errors ({errorLines.length})
                    </Button>
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={handleAnalyzeTail} disabled={logsLoading || logs.length === 0}>
                      Last 50
                    </Button>
                    <Button size="sm" className="h-7 text-xs" onClick={handleAnalyzeSelection} disabled={analyzing}>
                      {analyzing ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Sparkles className="h-3 w-3 mr-1" />}
                      Analyze selection
                    </Button>
                  </div>

                  {/* Log content */}
                  <div className="max-h-[380px] min-h-[220px] overflow-auto bg-muted/20">
                    {logsLoading ? (
                      <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" /> Fetching logs...
                      </div>
                    ) : logsError ? (
                      <Alert variant="destructive" className="m-3">
                        <AlertTitle>Failed to fetch logs</AlertTitle>
                        <AlertDescription>{logsError}</AlertDescription>
                      </Alert>
                    ) : shownLines.length === 0 ? (
                      <div className="p-6 text-center text-sm text-muted-foreground">
                        {logs.length === 0
                          ? 'No log lines in this window.'
                          : 'No error-looking lines in this window. Try disabling "errors only" or widening the tail.'}
                      </div>
                    ) : (
                      <div ref={viewerRef}>
                        {shownLines.map((e, i) => (
                          <div key={e.idx} data-active-match={i === activeMatch ? 'true' : undefined} className={cn(i === activeMatch && 'outline outline-1 outline-yellow-400/70')}>
                            <LogLine
                              line={e.line}
                              isError={ERROR_LINE_RE.test(e.line)}
                              query={search}
                              matchIdx={e.idx + 1}
                            />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Analysis results */}
      {analysis && (
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-2">
              <div>
                <CardTitle className="text-lg flex items-center gap-2">
                  <CheckCircle className="h-5 w-5 text-green-600" />
                  Analysis Complete
                </CardTitle>
                {analysisSource && (
                  <CardDescription>
                    Analyzed: {analysisSource}
                  </CardDescription>
                )}
              </div>
              <Button variant="ghost" size="sm" onClick={() => { setAnalysis(null); setAnalysisSource(null); }}>
                <X className="h-4 w-4 mr-1" /> Close
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <Alert>
              <AlertTitle>Summary</AlertTitle>
              <AlertDescription>{analysis.summary}</AlertDescription>
            </Alert>

            {analysis.explanation && (
              <div className="rounded-lg border p-4">
                <p className="mb-2 text-sm font-semibold">Explanation</p>
                <p className="whitespace-pre-wrap text-sm">{analysis.explanation}</p>
              </div>
            )}

            {analysis.errorCauses && analysis.errorCauses.length > 0 && (
              <div className="space-y-3">
                <p className="text-sm font-semibold">Error Causes</p>
                {analysis.errorCauses.map((cause, idx) => (
                  <div key={idx} className={cn('rounded-lg border p-3', severityColor(cause.severity))}>
                    <div className="flex items-start gap-2">
                      {severityIcon(cause.severity)}
                      <div className="flex-1 space-y-1">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="text-xs">{cause.category}</Badge>
                          <Badge variant="outline" className="text-xs">{cause.severity}</Badge>
                        </div>
                        <p className="break-all font-mono text-xs opacity-80">{cause.error}</p>
                        <p className="text-sm opacity-90">{cause.explanation}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {analysis.recommendations && analysis.recommendations.length > 0 && (
              <div className="rounded-lg border p-4">
                <p className="mb-2 text-sm font-semibold">Recommendations</p>
                <ul className="list-disc list-inside space-y-2">
                  {analysis.recommendations.map((rec, idx) => (
                    <li key={idx} className="text-sm">{rec}</li>
                  ))}
                </ul>
              </div>
            )}

            {analysis.parsedError && (
              <div className="rounded-lg border p-4 space-y-2 text-sm">
                <p className="font-semibold">Parsed Log Details</p>
                <div>
                  <span className="font-medium">Pod:</span>{' '}
                  {analysis.parsedError.Pod?.name || 'N/A'} ({analysis.parsedError.Pod?.namespace || 'N/A'})
                </div>
                <div>
                  <span className="font-medium">NodePool:</span>{' '}
                  {analysis.parsedError.NodePool?.name || 'N/A'}
                </div>
                {analysis.parsedError.Taints && analysis.parsedError.Taints.length > 0 && (
                  <div>
                    <span className="font-medium">Taints:</span>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {analysis.parsedError.Taints.map((taint, idx) => (
                        <Badge key={idx} variant="outline" className="text-xs">{taint}</Badge>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {analysisError && (
        <Alert variant="destructive">
          <AlertTitle>Analysis failed</AlertTitle>
          <AlertDescription>{analysisError}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

export default LogExplorer;
