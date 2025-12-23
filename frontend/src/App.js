import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { Card, CardContent, CardHeader, CardTitle } from './components/ui/card';
import { Button } from './components/ui/button';
import { Alert, AlertDescription, AlertTitle } from './components/ui/alert';
import { Badge } from './components/ui/badge';
import { Loader2 } from 'lucide-react';
import { Settings } from 'lucide-react';
import './App.css';
import NodePoolCard from './components/NodePoolCard';
import DisruptionTracker from './components/DisruptionTracker';
import NodeUsageView from './components/NodeUsageView';
import GlobalClusterSummary from './components/GlobalClusterSummary';
import AgentRecommendations from './components/AgentRecommendations';
import { cn } from './lib/utils';

// Use runtime configuration from window.ENV (set via config.js) or build-time env var
const API_URL = (window.ENV && window.ENV.hasOwnProperty('REACT_APP_API_URL')) 
  ? window.ENV.REACT_APP_API_URL 
  : (process.env.REACT_APP_API_URL || '');

if (typeof window !== 'undefined') {
  console.log('=== Frontend API Configuration Debug ===');
  console.log('API_URL configured as:', API_URL || '(empty - using relative URLs)');
  console.log('window.ENV:', window.ENV);
  console.log('window.ENV.REACT_APP_API_URL:', window.ENV?.REACT_APP_API_URL);
  console.log('process.env.REACT_APP_API_URL:', process.env.REACT_APP_API_URL);
  console.log('Full API URL for requests:', API_URL || '(relative URLs - same origin)');
  console.log('========================================');
}

function App() {
  const [recommendations, setRecommendations] = useState([]);
  const [error] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [clusterCost, setClusterCost] = useState(null);
  const [config, setConfig] = useState(null);
  const [configLoading, setConfigLoading] = useState(false);

  useEffect(() => {
    checkHealth();
    fetchConfig();
  }, []);

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
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 shadow-sm">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-2xl font-bold text-blue-600 m-0">Karpenter Optimizer</h1>
              <p className="text-sm text-muted-foreground m-0">Cluster-level cost optimization</p>
            </div>
            <Button 
              onClick={() => setShowSettings(!showSettings)}
              variant={showSettings ? 'default' : 'outline'}
            >
              <Settings className="h-4 w-4 mr-2" />
              {showSettings ? 'Hide' : 'Show'} Settings
            </Button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-6 py-6">
        <div className="space-y-6">
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

          <GlobalClusterSummary 
            onRecommendationsGenerated={null}
            onClusterCostUpdate={setClusterCost}
          />
          
          <NodeUsageView />
          
          <DisruptionTracker />
          
          <AgentRecommendations 
            onRecommendationsGenerated={setRecommendations}
            onClusterCostUpdate={setClusterCost}
          />

          {/* Cluster Cost Summary Card */}
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
                      ${clusterCost.current.toFixed(2)}/hr
                    </p>
                    <p className="text-xs text-muted-foreground">
                      ${(clusterCost.current * 24).toFixed(2)}/day
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
                      ${clusterCost.recommended.toFixed(2)}/hr
                    </p>
                    <p className="text-xs text-muted-foreground">
                      ${(clusterCost.recommended * 24).toFixed(2)}/day
                    </p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Potential Savings</p>
                    <p className={cn("text-2xl font-bold", clusterCost.savings > 0 ? "text-green-600" : "text-yellow-600")}>
                      {clusterCost.savings > 0 ? '-' : '+'}${Math.abs(clusterCost.savings).toFixed(2)}/hr
                    </p>
                    {clusterCost.current > 0 && (
                      <p className={cn("text-xs mt-1", clusterCost.savings > 0 ? "text-green-600" : "text-yellow-600")}>
                        {((clusterCost.savings / clusterCost.current) * 100).toFixed(1)}% {clusterCost.savings > 0 ? 'reduction' : 'increase'}
                        {' • '}${(Math.abs(clusterCost.savings) * 24).toFixed(2)}/day
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

          {error && (
            <Alert variant="destructive">
              <AlertTitle>Error</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {recommendations.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {recommendations.map((rec, index) => (
                <NodePoolCard key={index} recommendation={rec} />
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export default App;
