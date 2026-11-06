import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { Card, CardContent, CardHeader, CardTitle } from './components/ui/card';
import { Button } from './components/ui/button';
import { Alert, AlertTitle } from './components/ui/alert';
import { Badge } from './components/ui/badge';
import { Loader2, Settings, Info, X, Sun, Moon, LayoutDashboard, Server, Network, Cpu, Boxes, AlertTriangle, Sparkles, FileText } from 'lucide-react';
import NodePoolCard from './components/NodePoolCard';
import DisruptionTracker from './components/DisruptionTracker';
import NodeUsageView from './components/NodeUsageView';
import TopologyView from './components/topology/TopologyView';
import WorkloadUsageView from './components/WorkloadUsageView';
import GlobalClusterSummary from './components/GlobalClusterSummary';
import AgentRecommendations from './components/AgentRecommendations';
import LogExplorer from './components/LogExplorer';
import AlertsSettings from './components/AlertsSettings';
import ServingHealth from './components/serving/ServingHealth';
import { cn } from './lib/utils';
import { CurrencyRegionContext, formatCurrency } from './lib/currency';
import { API_URL } from './lib/api';
import { usePolling, useLastRefresh } from './hooks/usePolling';

// Tab definitions: id, label, and icon. Order is the nav order.
const TABS = [
  { id: 'overview', label: 'Overview', Icon: LayoutDashboard },
  { id: 'nodes', label: 'Nodes', Icon: Server },
  { id: 'topology', label: 'Topology', Icon: Network },
  { id: 'serving', label: 'Serving', Icon: Cpu },
  { id: 'workloads', label: 'Workloads', Icon: Boxes },
  { id: 'disruptions', label: 'Disruptions', Icon: AlertTriangle },
  { id: 'recommendations', label: 'Recommendations', Icon: Sparkles },
  { id: 'logs', label: 'Log Analyzer', Icon: FileText },
];

const TAB_IDS = new Set(TABS.map((t) => t.id));

// The active tab (and a Topology focus target) live in the URL so views can be
// shared, survive a refresh, and the browser back button returns from a
// Serving → Topology jump: ?tab=topology&node=<node>&pod=<ns/name>&gpu=<uuid>
function readLocation() {
  const q = new URLSearchParams(window.location.search);
  const tab = TAB_IDS.has(q.get('tab')) ? q.get('tab') : 'overview';
  const focus =
    tab === 'topology' && q.get('node')
      ? { node: q.get('node'), pod: q.get('pod') || '', gpu: q.get('gpu') || '' }
      : null;
  return { tab, focus };
}

const FOCUS_PARAMS = ['node', 'pod', 'gpu'];

// buildSearch builds the query string for a tab and optional Topology focus.
// keep carries the current tab's own params (its filters, see useUrlParam)
// when staying on the same tab; a different tab starts with a clean URL.
function buildSearch(tab, focus, keep = '') {
  const q = new URLSearchParams();
  if (tab !== 'overview') q.set('tab', tab);
  if (focus) {
    q.set('node', focus.node);
    if (focus.pod) q.set('pod', focus.pod);
    if (focus.gpu) q.set('gpu', focus.gpu);
  }
  new URLSearchParams(keep).forEach((value, key) => {
    if (key !== 'tab' && !FOCUS_PARAMS.includes(key)) q.set(key, value);
  });
  const str = q.toString();
  return str ? `?${str}` : window.location.pathname;
}

// LastUpdated shows when the polled panels last refreshed on the shared
// polling clock, so everyone reading the screen knows how fresh it is.
function LastUpdated() {
  const at = useLastRefresh();
  if (!at) return null;
  const time = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return (
    <span className="mr-2 text-xs text-muted-foreground tabular-nums" title="Polling pauses while this browser tab is hidden">
      Updated {time}
    </span>
  );
}

function NavItem({ id, label, Icon, active, badge, onClick }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors',
        active
          ? 'border-primary text-primary'
          : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border hover:bg-muted/40'
      )}
    >
      <Icon className="h-4 w-4" />
      {label}
      {badge > 0 && (
        <span className="ml-0.5 rounded-full bg-destructive px-1.5 text-[10px] font-semibold leading-4 text-destructive-foreground">
          {badge}
        </span>
      )}
    </button>
  );
}

function App() {
  const [recommendations, setRecommendations] = useState([]);
  const [showSettings, setShowSettings] = useState(false);
  const [clusterCost, setClusterCost] = useState(null);
  const [config, setConfig] = useState(null);
  const [configLoading, setConfigLoading] = useState(false);
  const [activeTab, setActiveTab] = useState(() => readLocation().tab);
  const [topologyFocus, setTopologyFocus] = useState(() => readLocation().focus);
  const [showKarpenterBanner, setShowKarpenterBanner] = useState(true);
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains('dark')
  );
  const [disruptionCount, setDisruptionCount] = useState(0);

  const navigate = useCallback((tab, focus = null) => {
    setActiveTab(tab);
    setTopologyFocus(focus);
    const sameTab = readLocation().tab === tab;
    const next = buildSearch(tab, focus, sameTab ? window.location.search : '');
    const current = window.location.search || window.location.pathname;
    if (next !== current) {
      window.history.pushState({ tab, from: readLocation().tab }, '', next);
    }
  }, []);

  useEffect(() => {
    const onPop = () => {
      const { tab, focus } = readLocation();
      setActiveTab(tab);
      setTopologyFocus(focus);
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
              <p className="text-sm text-muted-foreground m-0">Cluster-level cost optimization</p>
            </div>
            <div className="flex items-center gap-2">
              <LastUpdated />
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
        {/* Minimalist Tab Navigation */}
        <div className="mb-6 border-b">
          <nav className="flex space-x-1 -mb-px">
            {TABS.map(({ id, label, Icon }) => (
              <NavItem
                key={id}
                id={id}
                label={label}
                Icon={Icon}
                active={activeTab === id}
                badge={id === 'disruptions' ? disruptionCount : 0}
                onClick={() => navigate(id)}
              />
            ))}
          </nav>
        </div>

        <div key={activeTab} className="space-y-6 animate-tab-in">
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
              focus={topologyFocus}
              onClearFocus={() => navigate('topology')}
              onBackToServing={backToServing}
            />
          )}

          {/* Serving Tab */}
          {activeTab === 'serving' && (
            <ServingHealth onOpenTopology={(focus) => navigate('topology', focus)} />
          )}

          {/* Workloads Tab */}
          {activeTab === 'workloads' && <WorkloadUsageView />}

          {/* Disruptions Tab */}
          {activeTab === 'disruptions' && <DisruptionTracker />}

          {/* Log Analyzer Tab */}
          {activeTab === 'logs' && <LogExplorer />}

          {/* Recommendations Tab */}
          {activeTab === 'recommendations' && (
            <AgentRecommendations 
              onRecommendationsGenerated={setRecommendations}
              onClusterCostUpdate={setClusterCost}
            />
          )}


        </div>
      </main>
    </div>
    </CurrencyRegionContext.Provider>
  );
}

export default App;
