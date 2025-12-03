import React, { useState, useEffect } from 'react';
import axios from 'axios';
import './App.css';
import NodePoolCard from './components/NodePoolCard';
import DisruptionTracker from './components/DisruptionTracker';
import NodeUsageView from './components/NodeUsageView';
import GlobalClusterSummary from './components/GlobalClusterSummary';

// Use runtime configuration from window.ENV (set via config.js) or build-time env var
// window.ENV is set at runtime from environment variables in Kubernetes
// Check if window.ENV.REACT_APP_API_URL is explicitly defined (even if empty string)
const API_URL = (window.ENV && window.ENV.hasOwnProperty('REACT_APP_API_URL')) 
  ? window.ENV.REACT_APP_API_URL 
  : (process.env.REACT_APP_API_URL || '');

// Debug: Log API_URL to console (can be removed in production)
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
  const [error] = useState(null); // Reserved for future error handling
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

  // Recommendations are generated via GlobalClusterSummary component

  return (
    <div className="App">
      <header style={{ 
        background: 'white', 
        borderBottom: '1px solid #e5e7eb',
        padding: '1.5rem 2rem',
        boxShadow: '0 1px 2px rgba(0,0,0,0.05)'
      }}>
        <div style={{ 
          display: 'flex', 
          justifyContent: 'space-between', 
          alignItems: 'center',
          maxWidth: '1400px',
          margin: '0 auto'
        }}>
          <div>
            <h1 style={{ 
              margin: 0, 
              fontSize: '1.5rem', 
              fontWeight: 700,
              color: '#111827',
              letterSpacing: '-0.025em'
            }}>
              Karpenter Optimizer
            </h1>
            <p style={{ 
              margin: '0.25rem 0 0 0', 
              fontSize: '0.875rem', 
              color: '#6b7280' 
            }}>
              Cluster-level cost optimization
            </p>
          </div>
          <button 
            onClick={() => setShowSettings(!showSettings)}
            style={{
              padding: '0.5rem 1rem',
              background: 'transparent',
              border: '1px solid #d1d5db',
              borderRadius: '6px',
              fontSize: '0.875rem',
              color: '#374151',
              cursor: 'pointer',
              transition: 'all 0.2s'
            }}
            onMouseEnter={(e) => {
              e.target.style.borderColor = '#9ca3af';
              e.target.style.background = '#f9fafb';
            }}
            onMouseLeave={(e) => {
              e.target.style.borderColor = '#d1d5db';
              e.target.style.background = 'transparent';
            }}
          >
            {showSettings ? 'Hide' : 'Show'} Settings
          </button>
        </div>
      </header>

      <main style={{ 
        padding: '2rem', 
        maxWidth: '1400px', 
        margin: '0 auto',
        minHeight: 'calc(100vh - 100px)'
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
          {showSettings && (
            <section className="settings-section" style={{
              background: 'white',
              padding: '1.5rem',
              borderRadius: '8px',
              border: '1px solid #e5e7eb',
              boxShadow: '0 1px 3px rgba(0,0,0,0.1)'
            }}>
              <h2 style={{ marginTop: 0, marginBottom: '1.5rem', fontSize: '1.25rem', fontWeight: 600 }}>Configuration</h2>
              
              {configLoading ? (
                <p style={{ color: '#6b7280' }}>Loading configuration...</p>
              ) : config ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                  {/* Kubernetes Configuration */}
                  <div>
                    <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.75rem', color: '#111827' }}>
                      Kubernetes
                    </h3>
                    <div style={{ 
                      padding: '0.75rem', 
                      background: config.kubernetes?.connected ? '#f0fdf4' : '#fef2f2',
                      borderRadius: '6px',
                      border: `1px solid ${config.kubernetes?.connected ? '#bbf7d0' : '#fecaca'}`
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                        <span style={{ 
                          width: '8px', 
                          height: '8px', 
                          borderRadius: '50%', 
                          background: config.kubernetes?.connected ? '#22c55e' : '#ef4444',
                          display: 'inline-block'
                        }}></span>
                        <strong style={{ color: config.kubernetes?.connected ? '#166534' : '#991b1b' }}>
                          {config.kubernetes?.connected ? 'Connected' : 'Not Connected'}
                        </strong>
                      </div>
                      {config.kubernetes?.kubeconfigPath && (
                        <div style={{ fontSize: '0.875rem', color: '#6b7280', marginTop: '0.25rem' }}>
                          <strong>Kubeconfig:</strong> {config.kubernetes.kubeconfigPath}
                        </div>
                      )}
                      {config.kubernetes?.kubeContext && (
                        <div style={{ fontSize: '0.875rem', color: '#6b7280', marginTop: '0.25rem' }}>
                          <strong>Context:</strong> {config.kubernetes.kubeContext}
                        </div>
                      )}
                      {!config.kubernetes?.connected && (
                        <p style={{ fontSize: '0.875rem', color: '#991b1b', marginTop: '0.5rem', marginBottom: 0 }}>
                          Set KUBECONFIG environment variable or ensure kubeconfig is accessible.
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Ollama Configuration */}
                  <div>
                    <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.75rem', color: '#111827' }}>
                      Ollama (AI Explanations)
                    </h3>
                    <div style={{ 
                      padding: '0.75rem', 
                      background: config.ollama?.configured ? '#f0fdf4' : '#fef2f2',
                      borderRadius: '6px',
                      border: `1px solid ${config.ollama?.configured ? '#bbf7d0' : '#fecaca'}`
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                        <span style={{ 
                          width: '8px', 
                          height: '8px', 
                          borderRadius: '50%', 
                          background: config.ollama?.configured ? '#22c55e' : '#ef4444',
                          display: 'inline-block'
                        }}></span>
                        <strong style={{ color: config.ollama?.configured ? '#166534' : '#991b1b' }}>
                          {config.ollama?.configured ? 'Configured' : 'Not Configured'}
                        </strong>
                      </div>
                      <div style={{ fontSize: '0.875rem', color: '#6b7280', marginTop: '0.25rem' }}>
                        <strong>URL:</strong> {config.ollama?.url || 'Not set'}
                      </div>
                      <div style={{ fontSize: '0.875rem', color: '#6b7280', marginTop: '0.25rem' }}>
                        <strong>Model:</strong> {config.ollama?.model || 'Not set'}
                      </div>
                      {!config.ollama?.configured && (
                        <p style={{ fontSize: '0.875rem', color: '#991b1b', marginTop: '0.5rem', marginBottom: 0 }}>
                          Set OLLAMA_URL and OLLAMA_MODEL environment variables to enable AI-enhanced explanations.
                        </p>
                      )}
                    </div>
                  </div>

                  {/* AWS Configuration */}
                  <div>
                    <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.75rem', color: '#111827' }}>
                      AWS Pricing API
                    </h3>
                    <div style={{ 
                      padding: '0.75rem', 
                      background: '#f0fdf4',
                      borderRadius: '6px',
                      border: '1px solid #bbf7d0'
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                        <span style={{ 
                          width: '8px', 
                          height: '8px', 
                          borderRadius: '50%', 
                          background: '#22c55e',
                          display: 'inline-block'
                        }}></span>
                        <strong style={{ color: '#166534' }}>
                          Enabled
                        </strong>
                      </div>
                      <p style={{ fontSize: '0.875rem', color: '#6b7280', marginTop: '0.25rem', marginBottom: 0 }}>
                        Instance pricing is fetched dynamically from AWS Pricing API for accurate cost calculations.
                      </p>
                    </div>
                  </div>

                  {/* API Configuration */}
                  <div>
                    <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.75rem', color: '#111827' }}>
                      API Server
                    </h3>
                    <div style={{ 
                      padding: '0.75rem', 
                      background: '#f9fafb',
                      borderRadius: '6px',
                      border: '1px solid #e5e7eb'
                    }}>
                      <div style={{ fontSize: '0.875rem', color: '#6b7280' }}>
                        <strong>Port:</strong> {config.api?.port || '8080'}
                      </div>
                      <div style={{ fontSize: '0.875rem', color: '#6b7280', marginTop: '0.25rem' }}>
                        <strong>Frontend API URL:</strong> {API_URL}
                      </div>
                    </div>
                  </div>

                  {/* Information */}
                  <div style={{ 
                    padding: '0.75rem', 
                    background: '#eff6ff',
                    borderRadius: '6px',
                    border: '1px solid #bfdbfe'
                  }}>
                    <p style={{ fontSize: '0.875rem', color: '#1e40af', margin: 0 }}>
                      <strong>💡 Note:</strong> Configuration is read from environment variables. Restart the backend server after changing environment variables.
                    </p>
                  </div>
                </div>
              ) : (
                <p style={{ color: '#ef4444' }}>Failed to load configuration</p>
              )}
            </section>
          )}

          <GlobalClusterSummary 
            onRecommendationsGenerated={setRecommendations}
            onClusterCostUpdate={setClusterCost}
          />
          
          <NodeUsageView />
          
          <DisruptionTracker />
          
          <div style={{ 
            marginBottom: '1rem'
          }}>
            <h2 style={{ 
              margin: 0, 
              fontSize: '1.25rem', 
              fontWeight: 600,
              color: '#111827'
            }}>
              NodePool Recommendations
            </h2>
            <p style={{
              margin: '0.5rem 0 0 0',
              fontSize: '0.875rem',
              color: '#6b7280'
            }}>
              Use "Generate Recommendations" button in the Cluster Overview section above to analyze your cluster and get NodePool optimization recommendations.
            </p>
          </div>

          {/* Cluster Cost Summary Card */}
          {recommendations.length > 0 && clusterCost && (
            <div style={{
              background: 'white',
              padding: '1.5rem',
              borderRadius: '8px',
              border: '1px solid #e5e7eb',
              marginBottom: '1.5rem'
            }}>
              <h3 style={{
                margin: '0 0 1rem 0',
                fontSize: '1.125rem',
                fontWeight: 600,
                color: '#111827'
              }}>
                Cluster Cost Summary
              </h3>
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                gap: '1.5rem'
              }}>
                <div>
                  <div style={{
                    fontSize: '0.75rem',
                    color: '#6b7280',
                    marginBottom: '0.5rem',
                    fontWeight: 500,
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em'
                  }}>
                    Current Nodes
                  </div>
                  <div style={{
                    fontSize: '2rem',
                    fontWeight: 700,
                    color: '#111827'
                  }}>
                    {clusterCost.clusterNodes?.current ?? recommendations.reduce((sum, rec) => {
                      const isNewFormat = rec.nodePoolName !== undefined;
                      return sum + (isNewFormat ? rec.currentNodes : (rec.currentState?.totalNodes || 0));
                    }, 0)}
                  </div>
                </div>
                <div>
                  <div style={{
                    fontSize: '0.75rem',
                    color: '#6b7280',
                    marginBottom: '0.5rem',
                    fontWeight: 500,
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em'
                  }}>
                    Current Cost
                  </div>
                  <div style={{
                    fontSize: '2rem',
                    fontWeight: 700,
                    color: '#111827'
                  }}>
                    ${clusterCost.current.toFixed(2)}/hr
                  </div>
                  <div style={{
                    fontSize: '0.875rem',
                    color: '#6b7280',
                    marginTop: '0.25rem'
                  }}>
                    ${(clusterCost.current * 24).toFixed(2)}/day
                  </div>
                </div>
                <div>
                  <div style={{
                    fontSize: '0.75rem',
                    color: '#6b7280',
                    marginBottom: '0.5rem',
                    fontWeight: 500,
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em'
                  }}>
                    Recommended Nodes
                  </div>
                  <div style={{
                    fontSize: '2rem',
                    fontWeight: 700,
                    color: '#10b981'
                  }}>
                    {clusterCost.clusterNodes?.recommended ?? recommendations.reduce((sum, rec) => {
                      const isNewFormat = rec.nodePoolName !== undefined;
                      if (isNewFormat) {
                        return sum + (rec.recommendedNodes || 0);
                      } else {
                        return sum + (rec.maxSize > 0 ? Math.ceil(rec.maxSize / 2) : 0);
                      }
                    }, 0)}
                  </div>
                </div>
                <div>
                  <div style={{
                    fontSize: '0.75rem',
                    color: '#6b7280',
                    marginBottom: '0.5rem',
                    fontWeight: 500,
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em'
                  }}>
                    Recommended Cost
                  </div>
                  <div style={{
                    fontSize: '2rem',
                    fontWeight: 700,
                    color: '#10b981'
                  }}>
                    ${clusterCost.recommended.toFixed(2)}/hr
                  </div>
                  <div style={{
                    fontSize: '0.875rem',
                    color: '#6b7280',
                    marginTop: '0.25rem'
                  }}>
                    ${(clusterCost.recommended * 24).toFixed(2)}/day
                  </div>
                </div>
                <div>
                  <div style={{
                    fontSize: '0.75rem',
                    color: '#6b7280',
                    marginBottom: '0.5rem',
                    fontWeight: 500,
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em'
                  }}>
                    Potential Savings
                  </div>
                  <div style={{
                    fontSize: '2rem',
                    fontWeight: 700,
                    color: clusterCost.savings > 0 ? '#10b981' : '#f59e0b'
                  }}>
                    {clusterCost.savings > 0 ? '-' : '+'}${Math.abs(clusterCost.savings).toFixed(2)}/hr
                  </div>
                  <div style={{
                    fontSize: '0.875rem',
                    color: clusterCost.savings > 0 ? '#10b981' : '#f59e0b',
                    marginTop: '0.25rem',
                    fontWeight: 500
                  }}>
                    {clusterCost.current > 0 && (
                      <>
                        {((clusterCost.savings / clusterCost.current) * 100).toFixed(1)}% {clusterCost.savings > 0 ? 'reduction' : 'increase'}
                        {' • '}${(Math.abs(clusterCost.savings) * 24).toFixed(2)}/day
                      </>
                    )}
                  </div>
                </div>
                {clusterCost.totalNodePools !== undefined && (
                  <div>
                    <div style={{
                      fontSize: '0.75rem',
                      color: '#6b7280',
                      marginBottom: '0.5rem',
                      fontWeight: 500,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em'
                    }}>
                      NodePools with Changes
                    </div>
                    <div style={{
                      fontSize: '2rem',
                      fontWeight: 700,
                      color: '#111827'
                    }}>
                      {clusterCost.recommendedCount ?? recommendations.length} / {clusterCost.totalNodePools}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {error && (
            <div style={{
              padding: '1rem 1.5rem',
              background: '#fef2f2',
              border: '1px solid #fecaca',
              borderRadius: '8px',
              color: '#dc2626',
              fontSize: '0.875rem'
            }}>
              {error}
            </div>
          )}

          {recommendations.length > 0 && (
            <div style={{ 
              display: 'grid', 
              gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', 
              gap: '1rem' 
            }}>
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

