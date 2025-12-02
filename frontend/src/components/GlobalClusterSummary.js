import React, { useState, useEffect } from 'react';
import axios from 'axios';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:8080';

function GlobalClusterSummary({ onRecommendationsGenerated, onClusterCostUpdate }) {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshInterval, setRefreshInterval] = useState(60); // Default 60 seconds
  const [generatingRecommendations, setGeneratingRecommendations] = useState(false);
  const [clusterCost, setClusterCost] = useState(null);

  useEffect(() => {
    fetchSummary();
  }, []);

  useEffect(() => {
    let interval;
    if (autoRefresh) {
      interval = setInterval(() => {
        fetchSummary();
      }, refreshInterval * 1000);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [autoRefresh, refreshInterval]);

  const fetchSummary = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await axios.get(`${API_URL}/api/v1/cluster/summary`);
      setSummary(response.data.summary);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to fetch cluster summary');
      console.error('Cluster summary error:', err);
    } finally {
      setLoading(false);
    }
  };

  const formatResource = (value, type) => {
    if (type === 'cpu') {
      return `${value.toFixed(2)} cores`;
    } else {
      return `${value.toFixed(2)} GiB`;
    }
  };

  const [progressMessage, setProgressMessage] = useState('');
  const [progressPercent, setProgressPercent] = useState(0);

  const handleGenerateRecommendations = async () => {
    if (!summary) {
      setError('Please wait for cluster summary to load');
      return;
    }

    setGeneratingRecommendations(true);
    setError(null);
    setProgressMessage('Starting...');
    setProgressPercent(0);

    try {
      // Use EventSource for Server-Sent Events to get progress updates
      const eventSource = new EventSource(`${API_URL}/api/v1/recommendations/cluster-summary/stream`);

      // Handle SSE event types (Gin sends events with specific event names)
      eventSource.addEventListener('progress', (event) => {
        try {
          const data = JSON.parse(event.data);
          setProgressMessage(data.message || 'Processing...');
          setProgressPercent(data.progress || 0);
        } catch (err) {
          console.error('Error parsing progress event:', err);
        }
      });

      eventSource.addEventListener('complete', (event) => {
        try {
          const data = JSON.parse(event.data);
          if (onRecommendationsGenerated) {
            onRecommendationsGenerated(data.recommendations || []);
          }
          // Store cluster cost information
          if (data.clusterCost) {
            const costData = {
              ...data.clusterCost,
              clusterNodes: data.clusterNodes,
              totalNodePools: data.totalNodePools,
              recommendedCount: data.count
            };
            setClusterCost(costData);
            // Pass cluster cost to parent component
            if (onClusterCostUpdate) {
              onClusterCostUpdate(costData);
            }
          }
          setProgressMessage('Complete!');
          setProgressPercent(100);
          eventSource.close();
          setTimeout(() => {
            setGeneratingRecommendations(false);
            setProgressMessage('');
            setProgressPercent(0);
          }, 1000);
        } catch (err) {
          console.error('Error parsing complete event:', err);
          eventSource.close();
          setGeneratingRecommendations(false);
          setProgressMessage('');
          setProgressPercent(0);
        }
      });

      eventSource.addEventListener('error', (event) => {
        try {
          const data = JSON.parse(event.data);
          setError(data.error || 'Failed to generate recommendations');
        } catch (err) {
          setError('Failed to generate recommendations');
        }
        eventSource.close();
        setGeneratingRecommendations(false);
        setProgressMessage('');
        setProgressPercent(0);
      });

      // Handle connection errors
      eventSource.onerror = (err) => {
        console.error('EventSource connection error:', err);
        // Only show error if we haven't received a complete event
        if (progressPercent < 100) {
          setError('Connection error. Please try again.');
        }
        eventSource.close();
        setGeneratingRecommendations(false);
        setProgressMessage('');
        setProgressPercent(0);
      };

    } catch (err) {
      setError(err.message || 'Failed to generate recommendations');
      console.error('Recommendations error:', err);
      setGeneratingRecommendations(false);
      setProgressMessage('');
      setProgressPercent(0);
    }
  };

  const getUsageColor = (percent) => {
    if (percent >= 90) return '#FF0000'; // red
    if (percent >= 70) return '#FF8C00'; // orange (replaced yellow for better readability)
    return '#04B575'; // green
  };

  if (error && !summary) {
    return (
      <div style={{
        background: 'white',
        padding: '1.5rem',
        borderRadius: '8px',
        border: '1px solid #e5e7eb',
        marginBottom: '2rem'
      }}>
        <div style={{
          padding: '1rem',
          background: '#fef2f2',
          border: '1px solid #fecaca',
          borderRadius: '6px',
          color: '#dc2626',
          fontSize: '0.875rem'
        }}>
          {error}
        </div>
      </div>
    );
  }

  if (!summary) {
    return (
      <div style={{
        background: 'white',
        padding: '1.5rem',
        borderRadius: '8px',
        border: '1px solid #e5e7eb',
        marginBottom: '2rem'
      }}>
        <div style={{
          padding: '2rem',
          textAlign: 'center',
          color: '#6b7280'
        }}>
          {loading ? 'Loading cluster summary...' : 'No cluster data available'}
        </div>
      </div>
    );
  }

  return (
    <div style={{
      background: 'white',
      padding: '1.5rem',
      borderRadius: '8px',
      border: '1px solid #e5e7eb',
      marginBottom: '2rem'
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '1.5rem'
      }}>
        <div>
          <h2 style={{
            margin: 0,
            fontSize: '1.25rem',
            fontWeight: 600,
            color: '#111827'
          }}>
            Cluster Overview
          </h2>
          <p style={{
            margin: '0.25rem 0 0 0',
            fontSize: '0.875rem',
            color: '#6b7280'
          }}>
            Global cluster statistics
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            onClick={fetchSummary}
            disabled={loading}
            style={{
              padding: '0.5rem 1rem',
              background: loading ? '#d1d5db' : '#111827',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              fontSize: '0.875rem',
              fontWeight: 500,
              cursor: loading ? 'not-allowed' : 'pointer'
            }}
          >
            {loading ? 'Loading...' : 'Refresh'}
          </button>
          <button
            onClick={handleGenerateRecommendations}
            disabled={generatingRecommendations || !summary}
            style={{
              padding: '0.5rem 1rem',
              background: generatingRecommendations || !summary ? '#d1d5db' : '#10b981',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              fontSize: '0.875rem',
              fontWeight: 500,
              cursor: generatingRecommendations || !summary ? 'not-allowed' : 'pointer'
            }}
          >
            {generatingRecommendations ? 'Generating...' : 'Generate Recommendations'}
          </button>
          <label style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            fontSize: '0.875rem',
            color: '#374151',
            cursor: 'pointer'
          }}>
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              style={{ cursor: 'pointer' }}
            />
            Auto-refresh
          </label>
          {autoRefresh && (
            <select
              value={refreshInterval}
              onChange={(e) => setRefreshInterval(Number(e.target.value))}
              style={{
                padding: '0.5rem 0.75rem',
                border: '1px solid #d1d5db',
                borderRadius: '6px',
                fontSize: '0.875rem',
                background: 'white',
                color: '#374151'
              }}
            >
              <option value={30}>Every 30s</option>
              <option value={60}>Every 1m</option>
              <option value={120}>Every 2m</option>
              <option value={300}>Every 5m</option>
            </select>
          )}
        </div>
      </div>

      {generatingRecommendations && progressMessage && (
        <div style={{
          marginTop: '1rem',
          padding: '1rem',
          background: '#f0f9ff',
          border: '1px solid #bae6fd',
          borderRadius: '6px'
        }}>
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '0.5rem'
          }}>
            <span style={{
              fontSize: '0.875rem',
              color: '#0369a1',
              fontWeight: 500
            }}>
              {progressMessage}
            </span>
            <span style={{
              fontSize: '0.875rem',
              color: '#0369a1',
              fontWeight: 600
            }}>
              {Math.round(progressPercent)}%
            </span>
          </div>
          <div style={{
            width: '100%',
            height: '8px',
            background: '#e0f2fe',
            borderRadius: '4px',
            overflow: 'hidden'
          }}>
            <div style={{
              width: `${progressPercent}%`,
              height: '100%',
              background: '#0ea5e9',
              transition: 'width 0.3s ease',
              borderRadius: '4px'
            }} />
          </div>
        </div>
      )}

      {error && (
        <div style={{
          padding: '1rem',
          background: '#fef2f2',
          border: '1px solid #fecaca',
          borderRadius: '6px',
          color: '#dc2626',
          fontSize: '0.875rem',
          marginBottom: '1rem'
        }}>
          {error}
        </div>
      )}

      {/* Cluster Cost Summary */}
      {clusterCost && (
        <div style={{
          padding: '1.25rem',
          background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
          borderRadius: '8px',
          marginBottom: '1.5rem',
          color: 'white'
        }}>
          <div style={{
            fontSize: '0.875rem',
            fontWeight: 600,
            marginBottom: '1rem',
            opacity: 0.9
          }}>
            Cluster Cost Summary
          </div>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: '1rem'
          }}>
            <div>
              <div style={{
                fontSize: '0.75rem',
                opacity: 0.8,
                marginBottom: '0.25rem'
              }}>
                Current Cost
              </div>
              <div style={{
                fontSize: '1.75rem',
                fontWeight: 700
              }}>
                ${clusterCost.current.toFixed(2)}/hr
              </div>
            </div>
            <div>
              <div style={{
                fontSize: '0.75rem',
                opacity: 0.8,
                marginBottom: '0.25rem'
              }}>
                Recommended Cost
              </div>
              <div style={{
                fontSize: '1.75rem',
                fontWeight: 700
              }}>
                ${clusterCost.recommended.toFixed(2)}/hr
              </div>
            </div>
            <div>
              <div style={{
                fontSize: '0.75rem',
                opacity: 0.8,
                marginBottom: '0.25rem'
              }}>
                Potential Savings
              </div>
              <div style={{
                fontSize: '1.75rem',
                fontWeight: 700,
                color: clusterCost.savings > 0 ? '#10b981' : '#f59e0b'
              }}>
                {clusterCost.savings > 0 ? '-' : '+'}${Math.abs(clusterCost.savings).toFixed(2)}/hr
              </div>
              {clusterCost.current > 0 && (
                <div style={{
                  fontSize: '0.75rem',
                  opacity: 0.8,
                  marginTop: '0.25rem'
                }}>
                  {((clusterCost.savings / clusterCost.current) * 100).toFixed(1)}% {clusterCost.savings > 0 ? 'reduction' : 'increase'}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        gap: '1rem'
      }}>
        {/* Total Nodes */}
        <div style={{
          padding: '1rem',
          background: '#f9fafb',
          borderRadius: '6px',
          border: '1px solid #e5e7eb'
        }}>
          <div style={{
            fontSize: '0.75rem',
            color: '#6b7280',
            marginBottom: '0.5rem',
            fontWeight: 500
          }}>
            Total Nodes
          </div>
          <div style={{
            fontSize: '2rem',
            fontWeight: 700,
            color: '#111827'
          }}>
            {summary.totalNodes}
          </div>
        </div>

        {/* Spot Instances */}
        <div style={{
          padding: '1rem',
          background: '#fef3c7',
          borderRadius: '6px',
          border: '1px solid #fbbf24'
        }}>
          <div style={{
            fontSize: '0.75rem',
            color: '#78350f',
            marginBottom: '0.5rem',
            fontWeight: 500
          }}>
            Spot Instances
          </div>
          <div style={{
            fontSize: '2rem',
            fontWeight: 700,
            color: '#78350f'
          }}>
            {summary.spotNodes}
          </div>
          {summary.totalNodes > 0 && (
            <div style={{
              fontSize: '0.75rem',
              color: '#78350f',
              marginTop: '0.25rem'
            }}>
              {((summary.spotNodes / summary.totalNodes) * 100).toFixed(1)}%
            </div>
          )}
        </div>

        {/* On-Demand Instances */}
        <div style={{
          padding: '1rem',
          background: '#dbeafe',
          borderRadius: '6px',
          border: '1px solid #bfdbfe'
        }}>
          <div style={{
            fontSize: '0.75rem',
            color: '#1e40af',
            marginBottom: '0.5rem',
            fontWeight: 500
          }}>
            On-Demand Instances
          </div>
          <div style={{
            fontSize: '2rem',
            fontWeight: 700,
            color: '#1e40af'
          }}>
            {summary.onDemandNodes}
          </div>
          {summary.totalNodes > 0 && (
            <div style={{
              fontSize: '0.75rem',
              color: '#1e40af',
              marginTop: '0.25rem'
            }}>
              {((summary.onDemandNodes / summary.totalNodes) * 100).toFixed(1)}%
            </div>
          )}
        </div>

        {/* Total Pods */}
        <div style={{
          padding: '1rem',
          background: '#f3f4f6',
          borderRadius: '6px',
          border: '1px solid #d1d5db'
        }}>
          <div style={{
            fontSize: '0.75rem',
            color: '#374151',
            marginBottom: '0.5rem',
            fontWeight: 500
          }}>
            Total Pods
          </div>
          <div style={{
            fontSize: '2rem',
            fontWeight: 700,
            color: '#111827'
          }}>
            {summary.totalPods}
          </div>
          {summary.totalNodes > 0 && (
            <div style={{
              fontSize: '0.75rem',
              color: '#6b7280',
              marginTop: '0.25rem'
            }}>
              {(summary.totalPods / summary.totalNodes).toFixed(1)} per node
            </div>
          )}
        </div>

        {/* CPU Usage */}
        <div style={{
          padding: '1rem',
          background: '#f9fafb',
          borderRadius: '6px',
          border: '1px solid #e5e7eb'
        }}>
          <div style={{
            fontSize: '0.75rem',
            color: '#6b7280',
            marginBottom: '0.5rem',
            fontWeight: 500
          }}>
            CPU Usage
          </div>
          <div style={{
            fontSize: '1.5rem',
            fontWeight: 700,
            color: getUsageColor(summary.cpuPercent)
          }}>
            {summary.cpuPercent.toFixed(1)}%
          </div>
          <div style={{
            fontSize: '0.75rem',
            color: '#6b7280',
            marginTop: '0.25rem'
          }}>
            {formatResource(summary.cpuUsed, 'cpu')} / {formatResource(summary.cpuAllocatable, 'cpu')}
          </div>
        </div>

        {/* Memory Usage */}
        <div style={{
          padding: '1rem',
          background: '#f9fafb',
          borderRadius: '6px',
          border: '1px solid #e5e7eb'
        }}>
          <div style={{
            fontSize: '0.75rem',
            color: '#6b7280',
            marginBottom: '0.5rem',
            fontWeight: 500
          }}>
            Memory Usage
          </div>
          <div style={{
            fontSize: '1.5rem',
            fontWeight: 700,
            color: getUsageColor(summary.memoryPercent)
          }}>
            {summary.memoryPercent.toFixed(1)}%
          </div>
          <div style={{
            fontSize: '0.75rem',
            color: '#6b7280',
            marginTop: '0.25rem'
          }}>
            {formatResource(summary.memoryUsed, 'memory')} / {formatResource(summary.memoryAllocatable, 'memory')}
          </div>
        </div>
      </div>
    </div>
  );
}

export default GlobalClusterSummary;

