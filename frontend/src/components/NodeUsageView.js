import React, { useState, useEffect } from 'react';
import axios from 'axios';

// Use runtime configuration from window.ENV (set via config.js) or build-time env var
const API_URL = (window.ENV && window.ENV.hasOwnProperty('REACT_APP_API_URL')) 
  ? window.ENV.REACT_APP_API_URL 
  : (process.env.REACT_APP_API_URL || '');

function NodeUsageView() {
  const [nodes, setNodes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true); // Default to true for real-time updates
  const [refreshInterval, setRefreshInterval] = useState(60); // Default to 60 seconds (1 minute)
  const [groupBy, setGroupBy] = useState('nodepool'); // 'nodepool' or 'none'
  const [sortBy, setSortBy] = useState('cpu'); // 'cpu', 'memory', 'pods', 'creation'
  const [sortOrder, setSortOrder] = useState('desc'); // 'asc' or 'desc'

  useEffect(() => {
    fetchNodes();
  }, []);

  useEffect(() => {
    let interval;
    if (autoRefresh) {
      interval = setInterval(() => {
        fetchNodes();
      }, refreshInterval * 1000); // Convert seconds to milliseconds
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [autoRefresh, refreshInterval]);

  const fetchNodes = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await axios.get(`${API_URL}/api/v1/nodes`);
      const nodesData = response.data.nodes || [];
      setNodes(nodesData);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to fetch nodes');
      console.error('Nodes error:', err);
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

  // Color scheme similar to eks-node-viewer (green -> orange -> red gradient)
  const getUsageColor = (percent) => {
    if (percent >= 90) return '#FF0000'; // red (bad)
    if (percent >= 70) return '#FF8C00'; // orange (ok - more readable than yellow)
    return '#04B575'; // green (good)
  };

  const getNodeAge = (creationTime) => {
    if (!creationTime) return 'N/A';
    const now = new Date();
    const created = new Date(creationTime);
    const diffMs = now - created;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    
    if (diffDays > 0) return `${diffDays}d`;
    if (diffHours > 0) return `${diffHours}h`;
    return `${diffMins}m`;
  };

  const sortNodes = (nodeList) => {
    const sorted = [...nodeList];
    sorted.sort((a, b) => {
      let aValue, bValue;
      
      switch (sortBy) {
        case 'cpu':
          aValue = a.cpuUsage?.percent || 0;
          bValue = b.cpuUsage?.percent || 0;
          break;
        case 'memory':
          aValue = a.memoryUsage?.percent || 0;
          bValue = b.memoryUsage?.percent || 0;
          break;
        case 'pods':
          aValue = a.podCount || 0;
          bValue = b.podCount || 0;
          break;
        case 'creation':
          aValue = a.creationTime ? new Date(a.creationTime).getTime() : 0;
          bValue = b.creationTime ? new Date(b.creationTime).getTime() : 0;
          break;
        default:
          return 0;
      }
      
      if (sortOrder === 'desc') {
        return bValue - aValue;
      } else {
        return aValue - bValue;
      }
    });
    return sorted;
  };

  const calculateNodePoolSummary = (nodeList) => {
    let totalCPUUsed = 0;
    let totalCPUAllocatable = 0;
    let totalMemoryUsed = 0;
    let totalMemoryAllocatable = 0;
    let totalPods = 0;

    nodeList.forEach(node => {
      if (node.cpuUsage) {
        totalCPUUsed += node.cpuUsage.used;
        totalCPUAllocatable += node.cpuUsage.allocatable;
      }
      if (node.memoryUsage) {
        totalMemoryUsed += node.memoryUsage.used;
        totalMemoryAllocatable += node.memoryUsage.allocatable;
      }
      totalPods += node.podCount || 0;
    });

    const cpuPercent = totalCPUAllocatable > 0 ? (totalCPUUsed / totalCPUAllocatable) * 100 : 0;
    const memoryPercent = totalMemoryAllocatable > 0 ? (totalMemoryUsed / totalMemoryAllocatable) * 100 : 0;

    return {
      cpuUsed: totalCPUUsed,
      cpuAllocatable: totalCPUAllocatable,
      cpuPercent: Math.min(cpuPercent, 100),
      memoryUsed: totalMemoryUsed,
      memoryAllocatable: totalMemoryAllocatable,
      memoryPercent: Math.min(memoryPercent, 100),
      totalPods: totalPods,
      nodeCount: nodeList.length
    };
  };

  const groupedNodes = () => {
    const sortedNodes = sortNodes(nodes);
    if (groupBy === 'nodepool') {
      const grouped = {};
      sortedNodes.forEach(node => {
        const key = node.nodePool || 'No NodePool';
        if (!grouped[key]) {
          grouped[key] = [];
        }
        grouped[key].push(node);
      });
      return grouped;
    }
    return { 'All Nodes': sortedNodes };
  };

  const BarGauge = ({ label, used, capacity, allocatable, percent, type }) => {
    const gradientColor = getUsageColor(percent);
    
    return (
      <div style={{ marginBottom: '0.75rem' }}>
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '0.25rem',
          fontSize: '0.75rem'
        }}>
          <span style={{ fontWeight: 500, color: '#374151' }}>{label}</span>
          <span style={{ fontWeight: 600, color: gradientColor }}>
            {percent.toFixed(1)}% ({formatResource(used, type)} / {formatResource(allocatable, type)})
          </span>
        </div>
        <div style={{
          width: '100%',
          height: '24px',
          background: '#e5e7eb',
          borderRadius: '4px',
          overflow: 'hidden',
          position: 'relative',
          border: '1px solid #d1d5db'
        }}>
          <div style={{
            width: `${Math.min(percent, 100)}%`,
            height: '100%',
            background: gradientColor,
            transition: 'width 0.5s ease, background 0.5s ease',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            paddingRight: '6px',
            boxShadow: percent > 0 ? 'inset 0 1px 2px rgba(0,0,0,0.1)' : 'none'
          }}>
            {percent > 12 && (
              <span style={{
                color: percent >= 70 ? '#000' : '#fff',
                fontSize: '0.6875rem',
                fontWeight: 700,
                textShadow: percent >= 70 ? 'none' : '0 1px 2px rgba(0,0,0,0.3)'
              }}>
                {percent.toFixed(0)}%
              </span>
            )}
          </div>
          {percent <= 12 && (
            <span style={{
              position: 'absolute',
              left: '6px',
              top: '50%',
              transform: 'translateY(-50%)',
              fontSize: '0.6875rem',
              fontWeight: 600,
              color: '#6b7280'
            }}>
              {percent.toFixed(0)}%
            </span>
          )}
        </div>
        <div style={{
          fontSize: '0.6875rem',
          color: '#6b7280',
          marginTop: '0.125rem',
          display: 'flex',
          justifyContent: 'space-between'
        }}>
          <span>Capacity: {formatResource(capacity, type)}</span>
          <span>Allocatable: {formatResource(allocatable, type)}</span>
        </div>
      </div>
    );
  };

  const grouped = groupedNodes();

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
            Node Resource Usage
          </h2>
          <p style={{
            margin: '0.25rem 0 0 0',
            fontSize: '0.875rem',
            color: '#6b7280'
          }}>
            Real-time CPU and memory usage per node (based on pod resource requests)
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <select
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value)}
            style={{
              padding: '0.5rem 0.75rem',
              border: '1px solid #d1d5db',
              borderRadius: '6px',
              fontSize: '0.875rem',
              background: 'white',
              color: '#374151'
            }}
          >
            <option value="nodepool">Group by NodePool</option>
            <option value="none">All Nodes</option>
          </select>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            style={{
              padding: '0.5rem 0.75rem',
              border: '1px solid #d1d5db',
              borderRadius: '6px',
              fontSize: '0.875rem',
              background: 'white',
              color: '#374151'
            }}
          >
            <option value="cpu">Sort by CPU</option>
            <option value="memory">Sort by Memory</option>
            <option value="pods">Sort by Pods</option>
            <option value="creation">Sort by Creation</option>
          </select>
          <select
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value)}
            style={{
              padding: '0.5rem 0.75rem',
              border: '1px solid #d1d5db',
              borderRadius: '6px',
              fontSize: '0.875rem',
              background: 'white',
              color: '#374151'
            }}
          >
            <option value="desc">Descending</option>
            <option value="asc">Ascending</option>
          </select>
          <button
            onClick={fetchNodes}
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
              <option value={10}>Every 10s</option>
              <option value={30}>Every 30s</option>
              <option value={60}>Every 1m</option>
              <option value={120}>Every 2m</option>
              <option value={300}>Every 5m</option>
            </select>
          )}
        </div>
      </div>

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

      {loading && nodes.length === 0 ? (
        <div style={{
          padding: '2rem',
          textAlign: 'center',
          color: '#6b7280'
        }}>
          Loading nodes...
        </div>
      ) : nodes.length === 0 ? (
        <div style={{
          padding: '2rem',
          textAlign: 'center',
          color: '#6b7280'
        }}>
          No nodes found
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {Object.entries(grouped).map(([groupName, groupNodes]) => {
            const summary = groupBy === 'nodepool' ? calculateNodePoolSummary(groupNodes) : null;
            
            return (
              <div key={groupName}>
                <h3 style={{
                  margin: '0 0 1rem 0',
                  fontSize: '1rem',
                  fontWeight: 600,
                  color: '#374151',
                  paddingBottom: '0.5rem',
                  borderBottom: '2px solid #e5e7eb'
                }}>
                  {groupName} ({groupNodes.length} node{groupNodes.length !== 1 ? 's' : ''})
                </h3>
                
                {/* NodePool Summary Card */}
                {summary && summary.cpuAllocatable > 0 && (
                  <div style={{
                    marginBottom: '1.5rem',
                    padding: '1.25rem',
                    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                    borderRadius: '8px',
                    border: '1px solid #e5e7eb',
                    boxShadow: '0 4px 6px rgba(0,0,0,0.1)'
                  }}>
                    <div style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      marginBottom: '1rem'
                    }}>
                      <h4 style={{
                        margin: 0,
                        fontSize: '0.875rem',
                        fontWeight: 600,
                        color: 'white',
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em'
                      }}>
                        📊 NodePool Overall Usage
                      </h4>
                      <span style={{
                        padding: '0.25rem 0.75rem',
                        background: 'rgba(255,255,255,0.25)',
                        color: 'white',
                        borderRadius: '12px',
                        fontSize: '0.75rem',
                        fontWeight: 600,
                        backdropFilter: 'blur(4px)'
                      }}>
                        {summary.totalPods} pod{summary.totalPods !== 1 ? 's' : ''} • {summary.nodeCount} node{summary.nodeCount !== 1 ? 's' : ''}
                      </span>
                    </div>
                    <div style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 1fr',
                      gap: '1rem',
                      background: 'rgba(255,255,255,0.95)',
                      padding: '1rem',
                      borderRadius: '6px'
                    }}>
                      <div>
                        <BarGauge
                          label="Total CPU"
                          used={summary.cpuUsed}
                          capacity={summary.cpuAllocatable}
                          allocatable={summary.cpuAllocatable}
                          percent={summary.cpuPercent}
                          type="cpu"
                        />
                      </div>
                      <div>
                        <BarGauge
                          label="Total Memory"
                          used={summary.memoryUsed}
                          capacity={summary.memoryAllocatable}
                          allocatable={summary.memoryAllocatable}
                          percent={summary.memoryPercent}
                          type="memory"
                        />
                      </div>
                    </div>
                  </div>
                )}
                
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(400px, 1fr))',
                  gap: '1rem'
                }}>
                {groupNodes.map((node) => (
                  <div
                    key={node.name}
                    style={{
                      padding: '1rem',
                      background: '#f9fafb',
                      borderRadius: '6px',
                      border: '1px solid #e5e7eb'
                    }}
                  >
                    <div style={{
                      marginBottom: '0.75rem',
                      paddingBottom: '0.75rem',
                      borderBottom: '1px solid #e5e7eb'
                    }}>
                      <div style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: '0.25rem'
                      }}>
                        <div style={{
                          fontWeight: 600,
                          color: '#111827',
                          fontFamily: 'monospace',
                          fontSize: '0.875rem'
                        }}>
                          {node.name}
                        </div>
                        {node.podCount !== undefined && (
                          <span style={{
                            padding: '0.125rem 0.5rem',
                            background: '#e0e7ff',
                            color: '#4338ca',
                            borderRadius: '12px',
                            fontSize: '0.75rem',
                            fontWeight: 600
                          }}>
                            {node.podCount} pod{node.podCount !== 1 ? 's' : ''}
                          </span>
                        )}
                      </div>
                      <div style={{
                        display: 'flex',
                        gap: '0.5rem',
                        flexWrap: 'wrap',
                        fontSize: '0.75rem',
                        alignItems: 'center'
                      }}>
                        {node.nodePool && (
                          <span style={{
                            padding: '0.125rem 0.375rem',
                            background: '#e0e7ff',
                            color: '#4338ca',
                            borderRadius: '3px',
                            fontWeight: 500
                          }}>
                            📦 {node.nodePool}
                          </span>
                        )}
                        {node.instanceType && (
                          <span style={{
                            padding: '0.125rem 0.375rem',
                            background: '#f3f4f6',
                            color: '#374151',
                            borderRadius: '3px',
                            fontFamily: 'monospace'
                          }}>
                            {node.instanceType}
                          </span>
                        )}
                        {node.capacityType && (
                          <span style={{
                            padding: '0.125rem 0.375rem',
                            background: node.capacityType === 'spot' ? '#fef3c7' : '#dbeafe',
                            color: node.capacityType === 'spot' ? '#92400e' : '#1e40af',
                            borderRadius: '3px',
                            fontWeight: 500,
                            textTransform: 'capitalize'
                          }}>
                            {node.capacityType}
                          </span>
                        )}
                        {node.creationTime && (
                          <span style={{
                            padding: '0.125rem 0.375rem',
                            background: '#f9fafb',
                            color: '#6b7280',
                            borderRadius: '3px',
                            fontSize: '0.6875rem'
                          }}>
                            Age: {getNodeAge(node.creationTime)}
                          </span>
                        )}
                      </div>
                    </div>

                    {node.cpuUsage && (
                      <BarGauge
                        label="CPU"
                        used={node.cpuUsage.used}
                        capacity={node.cpuUsage.capacity}
                        allocatable={node.cpuUsage.allocatable}
                        percent={node.cpuUsage.percent}
                        type="cpu"
                      />
                    )}

                    {node.memoryUsage && (
                      <BarGauge
                        label="Memory"
                        used={node.memoryUsage.used}
                        capacity={node.memoryUsage.capacity}
                        allocatable={node.memoryUsage.allocatable}
                        percent={node.memoryUsage.percent}
                        type="memory"
                      />
                    )}

                    {(!node.cpuUsage && !node.memoryUsage) && (
                      <div style={{
                        fontSize: '0.75rem',
                        color: '#6b7280',
                        fontStyle: 'italic'
                      }}>
                        No usage data available
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default NodeUsageView;

