import React, { Suspense, lazy, useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import { Card, CardContent, CardHeader, CardTitle } from './components/ui/card';
import { Button } from './components/ui/button';
import { Alert, AlertTitle } from './components/ui/alert';
import { Badge } from './components/ui/badge';
import { Loader2, Settings, Info, X, Sun, Moon, Server, BrainCircuit, Sparkles, FileText, Search } from 'lucide-react';
import NodePoolCard from './components/NodePoolCard';
import GlobalClusterSummary from './components/GlobalClusterSummary';
import { LogDrawer } from './components/LogDrawer';
import { SkeletonRows } from './components/ui/skeleton';
import { CommandPalette, isPaletteShortcut } from './components/CommandPalette';
import { StatusStrip } from './components/StatusStrip';
import AlertsSettings from './components/AlertsSettings';
import { cn } from './lib/utils';
import { CurrencyRegionContext, formatCurrency } from './lib/currency';
import { API_URL } from './lib/api';
import { usePolling } from './hooks/usePolling';
import { AREAS, areaOf, buildUrl, logsParam, pagePath, parseLocation } from './lib/routes';

// Pages other than the Overview load on first visit, so the first paint
// does not wait for Topology, Serving and the rest.
const DisruptionTracker = lazy(() => import('./components/DisruptionTracker'));
const NodeUsageView = lazy(() => import('./components/NodeUsageView'));
const TopologyView = lazy(() => import('./components/topology/TopologyView'));
const WorkloadUsageView = lazy(() => import('./components/WorkloadUsageView'));
const AgentRecommendations = lazy(() => import('./components/AgentRecommendations'));
const GatewayPage = lazy(() => import('./components/serving/GatewayPage'));
const ServingHealth = lazy(() => import('./components/serving/ServingHealth'));

const PageFallback = () => (
  <div className="py-6" aria-label="Loading page">
    <SkeletonRows rows={5} />
  </div>
);

const AREA_ICONS = { cluster: Server, inference: BrainCircuit, optimize: Sparkles };

const readLocation = () => parseLocation(window.location.pathname, window.location.search);

function NavItem({ label, Icon, active, badge, onClick, href }) {
  return (
    <a
      href={href}
      aria-current={active ? 'page' : undefined}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        onClick();
      }}
      className={cn(
        'flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors',
        active
          ? 'border-primary text-primary'
          : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border hover:bg-muted/40'
      )}
    >
      <Icon className="h-4 w-4" />
      {label}
      <CountBadge count={badge} />
    </a>
  );
}

function CountBadge({ count }) {
  if (!(count > 0)) return null;
  return (
    <span className="ml-0.5 rounded-full bg-destructive px-1.5 text-[10px] font-semibold leading-4 text-destructive-foreground">
      {count}
    </span>
  );
}

// PageNav is the second row: the pages of the active area as pills.
function PageNav({ area, page, badges, onSelect }) {
  return (
    <nav className="flex flex-wrap gap-1" aria-label={`${area.label} pages`}>
      {area.pages.map((p) => (
        <a
          key={p.id}
          href={pagePath(p.id)}
          aria-current={p.id === page ? 'page' : undefined}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            onSelect(p.id);
          }}
          className={cn(
            'flex items-center rounded-md px-3 py-1.5 text-sm',
            p.id === page ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
          )}
        >
          {p.label}
          <CountBadge count={badges[p.id]} />
        </a>
      ))}
    </nav>
  );
}

function App() {
  const [recommendations, setRecommendations] = useState([]);
  const [showSettings, setShowSettings] = useState(false);
  const [clusterCost, setClusterCost] = useState(null);
  const [config, setConfig] = useState(null);
  const [configLoading, setConfigLoading] = useState(false);
  const [initialLocation] = useState(readLocation);
  const [activeTab, setActiveTab] = useState(initialLocation.page);
  const [tabFocus, setTabFocus] = useState(initialLocation.focus);
  const [logsPod, setLogsPod] = useState(initialLocation.logs);
  const [showKarpenterBanner, setShowKarpenterBanner] = useState(true);
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains('dark')
  );
  const [disruptionCount, setDisruptionCount] = useState(0);

  // Old ?tab= links and non-canonical paths become the new URL in place.
  useEffect(() => {
    if (initialLocation.redirect) window.history.replaceState(window.history.state, '', initialLocation.redirect);
  }, [initialLocation]);

  // navigate opens a page (and its focus). The log drawer stays as it is;
  // the page's own filters are kept only when staying on the same page.
  // params (from the command palette) replace the page's own params.
  const navigate = useCallback((page, focus = null, params = null) => {
    const here = readLocation();
    setActiveTab(page);
    setTabFocus(focus);
    const keep = params ? new URLSearchParams(params).toString() : here.page === page ? window.location.search : '';
    const next = buildUrl(page, { focus, logs: here.logs, keep });
    if (next !== `${window.location.pathname}${window.location.search}`) {
      window.history.pushState({ tab: page, from: here.page }, '', next);
    }
  }, []);

  // openLogs opens the drawer on a pod ("namespace/name", a {namespace,
  // name} pod, or '' for the picker) without leaving the page.
  const openLogs = useCallback((pod) => {
    const here = readLocation();
    const logs = logsParam(pod);
    setLogsPod(logs);
    const next = buildUrl(here.page, { focus: here.focus, logs, keep: window.location.search });
    window.history.pushState({ ...window.history.state, drawer: true }, '', next);
  }, []);

  // closeLogs steps back when the drawer was opened in this session (so
  // Back does not reopen it), else drops ?logs= in place.
  const closeLogs = useCallback(() => {
    setLogsPod(null);
    if (window.history.state?.drawer) {
      window.history.back();
      return;
    }
    const here = readLocation();
    window.history.replaceState(window.history.state, '', buildUrl(here.page, { focus: here.focus, keep: window.location.search }));
  }, []);

  // Command palette: ⌘K / Ctrl+K anywhere. A palette jump remounts the page
  // (navSeq) so it reads the new URL params even when it is already open.
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [navSeq, setNavSeq] = useState(0);
  useEffect(() => {
    const onKey = (e) => {
      if (isPaletteShortcut(e)) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const onPop = () => {
      const { page, focus, logs } = readLocation();
      setActiveTab(page);
      setTabFocus(focus);
      setLogsPod(logs);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // "Back to Serving" from a focused Topology view: pop the history entry when
  // we came from Serving (so Back/Forward don't pile up a Serving↔Topology
  // loop); otherwise, e.g. after opening a shared link, navigate there.
  const backToServing = useCallback(() => {
    if (window.history.state && window.history.state.from === 'serving') {
      window.history.back();
    } else {
      navigate('serving');
    }
  }, [navigate]);

  const toggleTheme = () => {
    setDark((d) => {
      const next = !d;
      document.documentElement.classList.toggle('dark', next);
      localStorage.setItem('karpenter-optimizer-theme', next ? 'dark' : 'light');
      return next;
    });
  };

  const currentArea = areaOf(activeTab);
  // An area remembers the page you last had open in it.
  const lastPage = useRef({});
  lastPage.current[currentArea.id] = activeTab;
  const karpenterDetected = config?.karpenter?.detected ?? false;
  const kubernetesConnected = config?.kubernetes?.connected ?? false;
  const showNoKarpenterBanner = showKarpenterBanner && kubernetesConnected && !karpenterDetected;
  const currency = (value) => formatCurrency(value, config?.aws?.region);

  useEffect(() => {
    checkHealth();
    fetchConfig();
  }, []);

  // Poll the disruption summary so the Disruptions tab can show a live
  // count badge (blocked + active). Non-fatal: a failed poll just leaves the
  // badge at 0.
  const fetchDisruptionCount = useCallback(() => {
    axios.get(`${API_URL}/api/v1/disruptions`, { params: { hours: 24 } })
      .then((res) => {
        const s = res.data.summary || {};
        setDisruptionCount((s.blockedCount || 0) + (s.activeCount || 0));
      })
      .catch(() => setDisruptionCount(0));
  }, []);
  usePolling(fetchDisruptionCount, 60000, kubernetesConnected);

  const fetchConfig = async () => {
    setConfigLoading(true);
    try {
      const response = await axios.get(`${API_URL}/api/v1/config`);
      setConfig(response.data);
    } catch (err) {
      console.error('Failed to fetch config:', err);
    } finally {
      setConfigLoading(false);
    }
  };

  const checkHealth = async () => {
    try {
      await axios.get(`${API_URL}/api/v1/health`);
    } catch (err) {
      console.error('Health check failed:', err);
    }
  };

  return (
    <CurrencyRegionContext.Provider value={config?.aws?.region || ''}>
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="bg-card border-b border-border shadow-sm">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-2xl font-bold text-primary m-0">Karpenter Optimizer</h1>
              <p className="text-sm text-muted-foreground m-0">Karpenter capacity and GPU inference operations</p>
            </div>
            <div className="flex items-center gap-2">
              <StatusStrip
                config={config}
                onOpenAlerts={() => {
                  setShowSettings(true);
                }}
              />
              <Button onClick={() => setPaletteOpen(true)} variant="outline" size="sm" aria-label="Search (⌘K)">
                <Search className="h-4 w-4 mr-2" />
                Search
                <kbd className="ml-2 rounded border px-1 font-sans text-[10px] text-muted-foreground">⌘K</kbd>
              </Button>
              <Button onClick={() => openLogs('')} variant="outline" size="sm">
                <FileText className="h-4 w-4 mr-2" />
                Logs
              </Button>
              <Button
                onClick={toggleTheme}
                variant="outline"
                size="icon"
                aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
                title={dark ? 'Switch to light theme' : 'Switch to dark theme'}
              >
                {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </Button>
              <Button 
                onClick={() => setShowSettings(!showSettings)}
                variant={showSettings ? 'default' : 'outline'}
                size="sm"
              >
                <Settings className="h-4 w-4 mr-2" />
                {showSettings ? 'Hide' : 'Show'} Settings
              </Button>
            </div>
          </div>
        </div>
      </header>

      {showNoKarpenterBanner && (
        <div className="max-w-7xl mx-auto px-6 pt-4">
          <div className="flex items-start gap-3 rounded-lg border border-border bg-muted px-4 py-3">
            <Info className="h-5 w-5 text-primary mt-0.5 shrink-0" />
            <p className="text-sm text-foreground flex-1">
              Karpenter not detected — NodePool-based features are unavailable.
              Recommendations use cluster-wide analysis, and node cost is shown as "n/a".
            </p>
            <button
              type="button"
              onClick={() => setShowKarpenterBanner(false)}
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="Dismiss"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-6 py-6">
        {/* Three areas, then the active area's pages */}
        <div className="mb-6 space-y-3">
          <div className="border-b">
          <nav className="-mb-px flex space-x-1" aria-label="Areas">
            {AREAS.map((area) => (
              <NavItem
                key={area.id}
                label={area.label}
                Icon={AREA_ICONS[area.id]}
                href={pagePath(lastPage.current[area.id] || area.pages[0].id)}
                active={currentArea.id === area.id}
                badge={area.id === 'cluster' ? disruptionCount : 0}
                onClick={() => navigate(lastPage.current[area.id] || area.pages[0].id)}
              />
            ))}
          </nav>
          </div>
          <PageNav
            area={currentArea}
            page={activeTab}
            badges={{ disruptions: disruptionCount }}
            onSelect={(page) => navigate(page)}
          />
        </div>

        <div key={`${activeTab}:${navSeq}`} className="space-y-6 animate-tab-in">
          <Suspense fallback={<PageFallback />}>
          {showSettings && (
            <Card>
              <CardHeader>
                <div className="flex justify-between items-center">
                  <CardTitle>Configuration</CardTitle>
                  <Badge variant="secondary">Live</Badge>
                </div>
              </CardHeader>
              <CardContent>
                {configLoading ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                  </div>
                ) : config ? (
                  <div className="space-y-4">
                    {/* Kubernetes Configuration */}
                    <Card>
                      <CardHeader>
                        <CardTitle className="text-lg">Kubernetes</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <Alert variant={config.kubernetes?.connected ? 'default' : 'destructive'} className="mb-4">
                          <AlertTitle>{config.kubernetes?.connected ? 'Connected' : 'Not Connected'}</AlertTitle>
                        </Alert>
                        <div className="space-y-2">
                          {config.kubernetes?.kubeconfigPath && (
                            <div className="flex gap-2">
                              <span className="text-sm font-medium">Kubeconfig:</span>
                              <span className="text-sm">{config.kubernetes.kubeconfigPath}</span>
                            </div>
                          )}
                          {config.kubernetes?.kubeContext && (
                            <div className="flex gap-2">
                              <span className="text-sm font-medium">Context:</span>
                              <span className="text-sm">{config.kubernetes.kubeContext}</span>
                            </div>
                          )}
                        </div>
                        {!config.kubernetes?.connected && (
                          <Alert variant="destructive" className="mt-4">
                            <AlertTitle>Set KUBECONFIG environment variable or ensure kubeconfig is accessible.</AlertTitle>
                          </Alert>
                        )}
                      </CardContent>
                    </Card>

                    {/* LLM Configuration */}
                    <Card>
                      <CardHeader>
                        <CardTitle className="text-lg">LLM (AI Explanations)</CardTitle>
                      </CardHeader>
                      <CardContent>
                        {(() => {
                          const llmConfig = config.llm?.configured ? config.llm : config.ollama;
                          const isConfigured = llmConfig?.configured || false;
                          const provider = config.llm?.provider || (config.ollama?.configured ? 'ollama' : null);
                          const url = llmConfig?.url || 'Not set';
                          const model = llmConfig?.model || 'Not set';
                          
                          return (
                            <>
                              <div className="flex gap-2 mb-4">
                                <Badge variant={isConfigured ? 'default' : 'destructive'}>
                                  {isConfigured ? 'Configured' : 'Not Configured'}
                                </Badge>
                                {provider && (
                                  <Badge variant="outline">{provider.toUpperCase()}</Badge>
                                )}
                              </div>
                              <div className="space-y-2">
                                <div className="flex gap-2">
                                  <span className="text-sm font-medium">URL:</span>
                                  <span className="text-sm">{url}</span>
                                </div>
                                <div className="flex gap-2">
                                  <span className="text-sm font-medium">Model:</span>
                                  <span className="text-sm">{model}</span>
                                </div>
                                {config.llm?.hasApiKey && (
                                  <div className="flex gap-2">
                                    <span className="text-sm font-medium">API Key:</span>
                                    <code className="text-sm">{'*'.repeat(20)} (configured)</code>
                                  </div>
                                )}
                              </div>
                              {!isConfigured && (
                                <Alert className="mt-4">
                                  <AlertTitle>Set LLM_URL and LLM_MODEL (or OLLAMA_URL and OLLAMA_MODEL for legacy) environment variables to enable AI-enhanced explanations.</AlertTitle>
                                </Alert>
                              )}
                            </>
                          );
                        })()}
                      </CardContent>
                    </Card>

                    {/* AWS Configuration */}
                    <Card>
                      <CardHeader>
                        <CardTitle className="text-lg">AWS Pricing API</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <Alert className="mb-2">
                          <AlertTitle>Enabled</AlertTitle>
                        </Alert>
                        <p className="text-xs text-muted-foreground">
                          Instance pricing is fetched dynamically from AWS Pricing API for accurate cost calculations.
                        </p>
                        <p className="text-xs text-muted-foreground mt-2">
                          Region: {config.aws?.region || 'Not configured'} · Currency: {config.aws?.currency || 'USD'}
                        </p>
                      </CardContent>
                    </Card>

                    {/* API Configuration */}
                    <Card>
                      <CardHeader>
                        <CardTitle className="text-lg">API Server</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="space-y-2">
                          <div className="flex gap-2">
                            <span className="text-sm font-medium">Port:</span>
                            <span className="text-sm">{config.api?.port || '8080'}</span>
                          </div>
                          <div className="flex gap-2">
                            <span className="text-sm font-medium">Frontend API URL:</span>
                            <code className="text-sm">{API_URL || '(relative URLs)'}</code>
                          </div>
                        </div>
                      </CardContent>
                    </Card>

                    {/* Alerting (webhook/ntfy/Discord/Slack) */}
                    <AlertsSettings />

                    <Alert>
                      <AlertTitle>Configuration is read from environment variables. Restart the backend server after changing environment variables.</AlertTitle>
                    </Alert>
                  </div>
                ) : (
                  <Alert variant="destructive">
                    <AlertTitle>Failed to load configuration</AlertTitle>
                  </Alert>
                )}
              </CardContent>
            </Card>
          )}

          {/* Overview Tab */}
          {activeTab === 'overview' && (
            <>
              <GlobalClusterSummary
                onRecommendationsGenerated={setRecommendations}
                onClusterCostUpdate={setClusterCost}
              />
              {recommendations.length > 0 && clusterCost && (
                <Card>
                  <CardHeader>
                    <CardTitle>Cluster Cost Summary</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
                      <div>
                        <p className="text-sm text-muted-foreground">Current Nodes</p>
                        <p className="text-2xl font-bold">
                          {clusterCost.clusterNodes?.current ?? recommendations.reduce((sum, rec) => {
                            const isNewFormat = rec.nodePoolName !== undefined;
                            return sum + (isNewFormat ? rec.currentNodes : (rec.currentState?.totalNodes || 0));
                          }, 0)}
                        </p>
                      </div>
                      <div>
                        <p className="text-sm text-muted-foreground">Current Cost</p>
                        <p className="text-2xl font-bold">
                          {currency(clusterCost.current)}/hr
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {currency(clusterCost.current * 24)}/day
                        </p>
                      </div>
                      <div>
                        <p className="text-sm text-muted-foreground">Recommended Nodes</p>
                        <p className="text-2xl font-bold text-green-600">
                          {clusterCost.clusterNodes?.recommended ?? recommendations.reduce((sum, rec) => {
                            const isNewFormat = rec.nodePoolName !== undefined;
                            if (isNewFormat) {
                              return sum + (rec.recommendedNodes || 0);
                            } else {
                              return sum + (rec.maxSize > 0 ? Math.ceil(rec.maxSize / 2) : 0);
                            }
                          }, 0)}
                        </p>
                      </div>
                      <div>
                        <p className="text-sm text-muted-foreground">Recommended Cost</p>
                        <p className="text-2xl font-bold text-green-600">
                          {currency(clusterCost.recommended)}/hr
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {currency(clusterCost.recommended * 24)}/day
                        </p>
                      </div>
                      <div>
                        <p className="text-sm text-muted-foreground">Potential Savings</p>
                        <p className={cn("text-2xl font-bold", clusterCost.savings > 0 ? "text-green-600" : "text-yellow-600")}>
                          {clusterCost.savings > 0 ? '-' : '+'}{currency(Math.abs(clusterCost.savings))}/hr
                        </p>
                        {clusterCost.current > 0 && (
                          <p className={cn("text-xs mt-1", clusterCost.savings > 0 ? "text-green-600" : "text-yellow-600")}>
                            {((clusterCost.savings / clusterCost.current) * 100).toFixed(1)}% {clusterCost.savings > 0 ? 'reduction' : 'increase'}
                            {' • '}{currency(Math.abs(clusterCost.savings) * 24)}/day
                          </p>
                        )}
                      </div>
                      {clusterCost.totalNodePools !== undefined && (
                        <div>
                          <p className="text-sm text-muted-foreground">NodePools with Changes</p>
                          <p className="text-2xl font-bold">
                            {clusterCost.recommendedCount ?? recommendations.length} / {clusterCost.totalNodePools}
                          </p>
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )}
              {recommendations.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {recommendations.map((rec, index) => (
                    <NodePoolCard key={index} recommendation={rec} />
                  ))}
                </div>
              )}
            </>
          )}

          {/* Nodes Tab */}
          {activeTab === 'nodes' && <NodeUsageView />}

          {/* Topology Tab */}
          {activeTab === 'topology' && (
            <TopologyView
              focus={tabFocus}
              onClearFocus={() => navigate('topology')}
              onBackToServing={backToServing}
              onFocusDone={() => setTabFocus(null)}
              onOpenServing={(pod) => navigate('serving', { pod: `${pod.namespace}/${pod.name}` })}
              onOpenDisruptions={() => navigate('disruptions')}
              onOpenLogs={openLogs}
            />
          )}

          {/* Serving Tab */}
          {activeTab === 'serving' && (
            <ServingHealth
              onOpenTopology={(focus) => navigate('topology', focus)}
              onOpenLogs={openLogs}
              focusPod={tabFocus?.pod}
            />
          )}

          {/* Gateway page */}
          {activeTab === 'gateway' && <GatewayPage />}

          {/* Workloads Tab */}
          {activeTab === 'workloads' && <WorkloadUsageView />}

          {/* Disruptions Tab */}
          {activeTab === 'disruptions' && <DisruptionTracker />}


          {/* Recommendations Tab */}
          {activeTab === 'recommendations' && (
            <AgentRecommendations 
              onRecommendationsGenerated={setRecommendations}
              onClusterCostUpdate={setClusterCost}
            />
          )}
          </Suspense>
        </div>
      </main>
      <LogDrawer pod={logsPod} onClose={closeLogs} />
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onRun={(run) => {
          if (run.type === 'logs') openLogs(run.pod);
          else if (run.type === 'theme') toggleTheme();
          else {
            navigate(run.page, run.focus || null, run.params || null);
            setNavSeq((n) => n + 1);
          }
        }}
      />
    </div>
    </CurrencyRegionContext.Provider>
  );
}

export default App;
