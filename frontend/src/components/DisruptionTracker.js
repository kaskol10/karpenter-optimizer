import React, { useState, useEffect } from 'react';
import axios from 'axios';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:8080';

function DisruptionTracker() {
  const [disruptions, setDisruptions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedTypes, setSelectedTypes] = useState(new Set()); // Empty set means all types selected
  const [showOnlyBlocked, setShowOnlyBlocked] = useState(false); // Focus on blocked disruptions

  // No automatic refresh - user must click refresh button

  const fetchDisruptions = async () => {
    setLoading(true);
    setError(null);
    try {
      // Hours parameter is only used for historical events (deleted nodes)
      // Main disruptions are based on live node state
      const response = await axios.get(`${API_URL}/api/v1/disruptions`, {
        params: { hours: 24 } // Only for historical deleted nodes
      });
      setDisruptions(response.data.disruptions || []);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to fetch disruptions');
      console.error('Disruptions error:', err);
    } finally {
      setLoading(false);
    }
  };

  const formatTime = (timeStr) => {
    if (!timeStr) return 'N/A';
    try {
      const date = new Date(timeStr);
      const now = new Date();
      const diffMs = now - date;
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);

      if (diffMins < 1) return 'Just now';
      if (diffMins < 60) return `${diffMins}m ago`;
      if (diffHours < 24) return `${diffHours}h ago`;
      return `${diffDays}d ago`;
    } catch {
      return timeStr;
    }
  };

  const getReasonColor = (reason) => {
    const reasonLower = reason?.toLowerCase() || '';
    if (reasonLower.includes('consolidat')) {
      return { bg: '#dbeafe', text: '#1e40af', label: 'Consolidation' };
    }
    if (reasonLower.includes('expir') || reasonLower.includes('drift')) {
      return { bg: '#fef3c7', text: '#92400e', label: 'Expiration/Drift' };
    }
    if (reasonLower.includes('terminat') || reasonLower.includes('delet')) {
      return { bg: '#fee2e2', text: '#991b1b', label: 'Termination' };
    }
    return { bg: '#f3f4f6', text: '#374151', label: reason || 'Unknown' };
  };

  const groupByReason = (disruptions) => {
    const grouped = {};
    disruptions.forEach(d => {
      const reason = d.reason || 'Unknown';
      if (!grouped[reason]) {
        grouped[reason] = [];
      }
      grouped[reason].push(d);
    });
    return grouped;
  };

  const getReasonType = (reason) => {
    const reasonLower = reason?.toLowerCase() || '';
    if (reasonLower.includes('consolidat')) {
      return 'consolidation';
    }
    if (reasonLower.includes('expir') || reasonLower.includes('drift')) {
      return 'expiration';
    }
    if (reasonLower.includes('terminat') || reasonLower.includes('delet')) {
      return 'termination';
    }
    return 'other';
  };

  const toggleTypeFilter = (type) => {
    const newSelected = new Set(selectedTypes);
    if (newSelected.has(type)) {
      newSelected.delete(type);
    } else {
      newSelected.add(type);
    }
    setSelectedTypes(newSelected);
  };

  const selectAllTypes = () => {
    setSelectedTypes(new Set());
  };

  const getAvailableTypes = (disruptions) => {
    const types = new Set();
    disruptions.forEach(d => {
      types.add(getReasonType(d.reason));
    });
    return Array.from(types).sort();
  };

  const filteredDisruptions = disruptions.filter(d => {
    // First filter by blocked status
    if (showOnlyBlocked && !d.isBlocked) {
      return false;
    }
    
    // Then filter by type
    if (selectedTypes.size === 0) {
      return true; // Show all if no filters selected
    }
    const type = getReasonType(d.reason);
    return selectedTypes.has(type);
  });

  const blockedDisruptions = disruptions.filter(d => d.isBlocked);

  const groupedDisruptions = groupByReason(filteredDisruptions);
  const availableTypes = getAvailableTypes(disruptions);

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
            Node Disruptions
          </h2>
          <p style={{
            margin: '0.25rem 0 0 0',
            fontSize: '0.875rem',
            color: '#6b7280'
          }}>
            Live node disruptions based on current node state
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <button
            onClick={fetchDisruptions}
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

      {loading && disruptions.length === 0 ? (
        <div style={{
          padding: '2rem',
          textAlign: 'center',
          color: '#6b7280'
        }}>
          Loading disruptions...
        </div>
      ) : disruptions.length === 0 ? (
        <div style={{
          padding: '2rem',
          textAlign: 'center',
          color: '#6b7280',
          background: '#f9fafb',
          borderRadius: '6px'
        }}>
          <p style={{ margin: 0, fontSize: '0.875rem' }}>
            No active disruptions found
          </p>
        </div>
      ) : (
        <div>
          {/* Blocked Disruptions Focus Section */}
          {blockedDisruptions.length > 0 && (
            <div style={{
              marginBottom: '1rem',
              padding: '1rem',
              background: 'linear-gradient(135deg, #fef2f2 0%, #fee2e2 100%)',
              borderRadius: '6px',
              border: '2px solid #dc2626',
              boxShadow: '0 2px 4px rgba(220, 38, 38, 0.1)'
            }}>
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '0.75rem'
              }}>
                <div>
                  <div style={{
                    fontSize: '1rem',
                    fontWeight: 700,
                    color: '#991b1b',
                    marginBottom: '0.25rem'
                  }}>
                    ⚠️ {blockedDisruptions.length} Node(s) Blocked from Deletion
                  </div>
                  <div style={{
                    fontSize: '0.8125rem',
                    color: '#991b1b'
                  }}>
                    These nodes cannot be removed due to Pod Disruption Budgets or pod eviction constraints
                  </div>
                </div>
                <button
                  onClick={() => setShowOnlyBlocked(!showOnlyBlocked)}
                  style={{
                    padding: '0.5rem 1rem',
                    background: showOnlyBlocked ? '#dc2626' : 'white',
                    color: showOnlyBlocked ? 'white' : '#991b1b',
                    border: '2px solid #dc2626',
                    borderRadius: '6px',
                    fontSize: '0.8125rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                    transition: 'all 0.2s'
                  }}
                  onMouseEnter={(e) => {
                    if (!showOnlyBlocked) {
                      e.target.style.background = '#fee2e2';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!showOnlyBlocked) {
                      e.target.style.background = 'white';
                    }
                  }}
                >
                  {showOnlyBlocked ? 'Show All' : 'Focus on Blocked'}
                </button>
              </div>
              
              {/* Quick stats for blocked nodes */}
              <div style={{
                display: 'flex',
                gap: '1rem',
                flexWrap: 'wrap',
                fontSize: '0.75rem',
                color: '#991b1b'
              }}>
                {blockedDisruptions.filter(d => d.blockingPDBs && d.blockingPDBs.length > 0).length > 0 && (
                  <span>
                    <strong>{blockedDisruptions.filter(d => d.blockingPDBs && d.blockingPDBs.length > 0).length}</strong> blocked by PDBs
                  </span>
                )}
                {blockedDisruptions.reduce((sum, d) => sum + (d.affectedPods?.length || 0), 0) > 0 && (
                  <span>
                    <strong>{blockedDisruptions.reduce((sum, d) => sum + (d.affectedPods?.length || 0), 0)}</strong> pods affected
                  </span>
                )}
                {new Set(blockedDisruptions.map(d => d.nodePool).filter(Boolean)).size > 0 && (
                  <span>
                    Across <strong>{new Set(blockedDisruptions.map(d => d.nodePool).filter(Boolean)).size}</strong> NodePool(s)
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Type Filter Section - Compact */}
          {availableTypes.length > 0 && (
            <div style={{
              marginBottom: '0.75rem',
              padding: '0.5rem',
              background: '#f9fafb',
              borderRadius: '4px',
              border: '1px solid #e5e7eb'
            }}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                flexWrap: 'wrap'
              }}>
                <span style={{
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  color: '#374151'
                }}>
                  Filter:
                </span>
                <button
                  onClick={selectAllTypes}
                  style={{
                    padding: '0.375rem 0.625rem',
                    background: selectedTypes.size === 0 ? '#111827' : 'white',
                    color: selectedTypes.size === 0 ? 'white' : '#374151',
                    border: '1px solid #d1d5db',
                    borderRadius: '4px',
                    fontSize: '0.75rem',
                    fontWeight: 500,
                    cursor: 'pointer',
                    transition: 'all 0.2s'
                  }}
                  onMouseEnter={(e) => {
                    if (selectedTypes.size !== 0) {
                      e.target.style.borderColor = '#9ca3af';
                      e.target.style.background = '#f9fafb';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (selectedTypes.size !== 0) {
                      e.target.style.borderColor = '#d1d5db';
                      e.target.style.background = 'white';
                    }
                  }}
                >
                  All
                </button>
                {availableTypes.map(type => {
                  const color = getReasonColor(type === 'consolidation' ? 'Consolidating' : 
                                                type === 'expiration' ? 'Expiring' : 
                                                type === 'termination' ? 'Terminating' : 'Other');
                  const isSelected = selectedTypes.size === 0 || selectedTypes.has(type);
                  const count = disruptions.filter(d => getReasonType(d.reason) === type).length;
                  
                  return (
                    <label
                      key={type}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.375rem',
                        padding: '0.375rem 0.625rem',
                        background: isSelected ? color.bg : 'white',
                        color: isSelected ? color.text : '#6b7280',
                        border: `1px solid ${isSelected ? color.text : '#d1d5db'}`,
                        borderRadius: '4px',
                        fontSize: '0.75rem',
                        fontWeight: 500,
                        cursor: 'pointer',
                        transition: 'all 0.2s',
                        userSelect: 'none'
                      }}
                      onMouseEnter={(e) => {
                        if (!isSelected) {
                          e.currentTarget.style.borderColor = '#9ca3af';
                          e.currentTarget.style.background = '#f9fafb';
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!isSelected) {
                          e.currentTarget.style.borderColor = '#d1d5db';
                          e.currentTarget.style.background = 'white';
                        }
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleTypeFilter(type)}
                        style={{
                          cursor: 'pointer',
                          margin: 0
                        }}
                      />
                      <span style={{ textTransform: 'capitalize' }}>
                        {type === 'consolidation' ? 'Consolidation' :
                         type === 'expiration' ? 'Expiration/Drift' :
                         type === 'termination' ? 'Termination' : 'Other'}
                      </span>
                      <span style={{
                        padding: '0.125rem 0.25rem',
                        background: isSelected ? 'rgba(255,255,255,0.3)' : '#e5e7eb',
                        borderRadius: '2px',
                        fontSize: '0.6875rem',
                        fontWeight: 600
                      }}>
                        {count}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {/* Summary Stats - Compact */}
          <div style={{
            display: 'flex',
            gap: '0.375rem',
            marginBottom: '0.75rem',
            flexWrap: 'wrap'
          }}>
            {Object.entries(groupedDisruptions).map(([reason, items]) => {
              const color = getReasonColor(reason);
              return (
                <div
                  key={reason}
                  style={{
                    padding: '0.25rem 0.5rem',
                    background: color.bg,
                    color: color.text,
                    borderRadius: '3px',
                    fontSize: '0.75rem',
                    fontWeight: 500
                  }}
                >
                  {color.label}: {items.length}
                </div>
              );
            })}
            {filteredDisruptions.length === 0 && disruptions.length > 0 && (
              <div style={{
                padding: '0.375rem 0.75rem',
                background: '#fef2f2',
                color: '#991b1b',
                borderRadius: '4px',
                fontSize: '0.8125rem',
                fontWeight: 500
              }}>
                No disruptions match selected filters
              </div>
            )}
          </div>

          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '0.5rem',
            maxHeight: showOnlyBlocked ? '400px' : '500px',
            overflowY: 'auto'
          }}>
            {filteredDisruptions
              .sort((a, b) => {
                // Always sort blocked disruptions to the top
                if (a.isBlocked && !b.isBlocked) return -1;
                if (!a.isBlocked && b.isBlocked) return 1;
                // If both blocked, sort by number of blocking PDBs
                if (a.isBlocked && b.isBlocked) {
                  const aPDBs = (a.blockingPDBs?.length || 0);
                  const bPDBs = (b.blockingPDBs?.length || 0);
                  if (aPDBs !== bPDBs) return bPDBs - aPDBs;
                }
                return 0;
              })
              .map((disruption, index) => {
              const color = getReasonColor(disruption.reason);
              const isBlocked = disruption.isBlocked || false;
              const pods = disruption.affectedPods || [];
              
              return (
                <div
                  key={`${disruption.nodeName}-${index}`}
                  style={{
                    padding: isBlocked ? '0.875rem' : '0.75rem',
                    background: isBlocked ? '#fef2f2' : 'white',
                    borderRadius: '4px',
                    border: isBlocked ? '3px solid #dc2626' : '1px solid #e5e7eb',
                    fontSize: '0.8125rem',
                    boxShadow: isBlocked ? '0 2px 4px rgba(220, 38, 38, 0.15)' : 'none'
                  }}
                >
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'auto 1fr auto auto',
                    gap: '0.75rem',
                    alignItems: 'center'
                  }}>
                    {/* Reason Badge */}
                    <div style={{
                      padding: '0.25rem 0.5rem',
                      background: color.bg,
                      color: color.text,
                      borderRadius: '3px',
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      whiteSpace: 'nowrap'
                    }}>
                      {color.label}
                    </div>
                    
                    {/* Node Info */}
                    <div>
                      <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                        marginBottom: '0.25rem',
                        flexWrap: 'wrap'
                      }}>
                        <span style={{
                          fontWeight: 600,
                          color: '#111827',
                          fontFamily: 'monospace',
                          fontSize: '0.8125rem'
                        }}>
                          {disruption.nodeName}
                        </span>
                        {isBlocked && (
                          <span style={{
                            padding: '0.125rem 0.375rem',
                            background: '#dc2626',
                            color: 'white',
                            borderRadius: '3px',
                            fontSize: '0.6875rem',
                            fontWeight: 600
                          }}>
                            BLOCKED
                          </span>
                        )}
                        {disruption.nodePool && (
                          <span style={{
                            padding: '0.25rem 0.5rem',
                            background: '#e0e7ff',
                            color: '#4338ca',
                            borderRadius: '4px',
                            fontSize: '0.75rem',
                            fontWeight: 600,
                            border: '1px solid #c7d2fe'
                          }}>
                            📦 {disruption.nodePool}
                          </span>
                        )}
                        {disruption.instanceType && (
                          <span style={{
                            padding: '0.25rem 0.5rem',
                            background: '#f3f4f6',
                            color: '#374151',
                            borderRadius: '4px',
                            fontSize: '0.75rem',
                            fontFamily: 'monospace'
                          }}>
                            {disruption.instanceType}
                          </span>
                        )}
                      </div>
                      
                      {/* Pods Running on Node - Enhanced Display */}
                      {pods.length > 0 && (
                        <div style={{
                          marginTop: '0.5rem',
                          padding: '0.5rem',
                          background: '#f9fafb',
                          borderRadius: '4px',
                          border: '1px solid #e5e7eb'
                        }}>
                          <div style={{
                            fontSize: '0.75rem',
                            fontWeight: 600,
                            color: '#374151',
                            marginBottom: '0.375rem',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.5rem'
                          }}>
                            <span>📦 Pods Running ({pods.length}):</span>
                          </div>
                          <div style={{
                            display: 'flex',
                            flexWrap: 'wrap',
                            gap: '0.375rem'
                          }}>
                            {pods.map((pod, podIndex) => {
                              // Ensure we have pod name - use name first, then workloadName, then index
                              const podName = pod.name || pod.workloadName || `pod-${podIndex}`;
                              const namespace = pod.namespace || 'default';
                              
                              return (
                                <div
                                  key={podIndex}
                                  style={{
                                    padding: '0.25rem 0.5rem',
                                    background: 'white',
                                    borderRadius: '3px',
                                    fontSize: '0.75rem',
                                    color: '#374151',
                                    fontFamily: 'monospace',
                                    border: '1px solid #e5e7eb',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.25rem'
                                  }}
                                  title={`Pod: ${pod.name || podName} | Namespace: ${namespace} | Workload: ${pod.workloadName || 'N/A'} | Type: ${pod.workloadType || 'pod'}`}
                                >
                                  <span style={{
                                    padding: '0.125rem 0.25rem',
                                    background: pod.workloadType === 'deployment' ? '#dbeafe' : 
                                               pod.workloadType === 'statefulset' ? '#e0e7ff' :
                                               pod.workloadType === 'daemonset' ? '#f3e8ff' : '#f3f4f6',
                                    color: pod.workloadType === 'deployment' ? '#1e40af' :
                                           pod.workloadType === 'statefulset' ? '#4338ca' :
                                           pod.workloadType === 'daemonset' ? '#7c3aed' : '#6b7280',
                                    borderRadius: '2px',
                                    fontSize: '0.6875rem',
                                    fontWeight: 600,
                                    textTransform: 'uppercase'
                                  }}>
                                    {pod.workloadType ? pod.workloadType.charAt(0) : 'P'}
                                  </span>
                                  <span style={{ fontWeight: 500 }}>
                                    {namespace}/{podName}
                                  </span>
                                  {pod.workloadName && pod.workloadName !== podName && (
                                    <span style={{ color: '#9ca3af', fontSize: '0.6875rem' }}>
                                      (workload: {pod.workloadName})
                                    </span>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                      {pods.length === 0 && disruption.nodeStillExists && (
                        <div style={{
                          marginTop: '0.5rem',
                          padding: '0.375rem',
                          fontSize: '0.75rem',
                          color: '#6b7280',
                          fontStyle: 'italic'
                        }}>
                          No pods found on this node
                        </div>
                      )}
                      
                      {/* Blocking info - Enhanced for blocked cases */}
                      {isBlocked && (
                        <div style={{
                          marginTop: '0.5rem',
                          padding: '0.5rem',
                          background: '#fee2e2',
                          borderRadius: '4px',
                          border: '1px solid #fecaca'
                        }}>
                          <div style={{
                            fontSize: '0.75rem',
                            color: '#991b1b',
                            fontWeight: 600,
                            marginBottom: '0.25rem'
                          }}>
                            ⚠️ Blocked: {disruption.blockingReason || 'Cannot evict pods'}
                          </div>
                          {disruption.blockingPDBs && disruption.blockingPDBs.length > 0 && (
                            <div style={{
                              fontSize: '0.75rem',
                              color: '#991b1b',
                              marginTop: '0.25rem'
                            }}>
                              <strong>PDBs:</strong> {disruption.blockingPDBs.map((pdb, idx) => (
                                <span key={idx} style={{
                                  marginLeft: '0.25rem',
                                  padding: '0.125rem 0.375rem',
                                  background: 'white',
                                  borderRadius: '3px',
                                  fontFamily: 'monospace'
                                }}>
                                  {pdb}
                                </span>
                              ))}
                            </div>
                          )}
                          {disruption.blockingPods && disruption.blockingPods.length > 0 && (
                            <div style={{
                              fontSize: '0.75rem',
                              color: '#991b1b',
                              marginTop: '0.25rem'
                            }}>
                              <strong>Blocking Pods:</strong> {disruption.blockingPods.slice(0, 3).map((pod, idx) => (
                                <span key={idx} style={{
                                  marginLeft: '0.25rem',
                                  padding: '0.125rem 0.375rem',
                                  background: 'white',
                                  borderRadius: '3px',
                                  fontFamily: 'monospace'
                                }}>
                                  {pod}
                                </span>
                              ))}
                              {disruption.blockingPods.length > 3 && (
                                <span style={{ marginLeft: '0.25rem', color: '#6b7280' }}>
                                  +{disruption.blockingPods.length - 3} more
                                </span>
                              )}
                            </div>
                          )}
                          <div style={{
                            fontSize: '0.6875rem',
                            color: '#92400e',
                            marginTop: '0.375rem',
                            fontStyle: 'italic'
                          }}>
                            💡 Tip: Review PDB minAvailable/maxUnavailable settings or pod eviction policies
                          </div>
                        </div>
                      )}
                    </div>
                    
                    {/* Time */}
                    <div style={{
                      fontSize: '0.75rem',
                      color: '#9ca3af',
                      whiteSpace: 'nowrap'
                    }}>
                      {formatTime(disruption.lastSeen)}
                    </div>
                    
                    {/* Pod Count Badge */}
                    {pods.length > 0 && (
                      <div style={{
                        padding: '0.25rem 0.5rem',
                        background: '#eff6ff',
                        color: '#1e40af',
                        borderRadius: '3px',
                        fontSize: '0.75rem',
                        fontWeight: 600,
                        whiteSpace: 'nowrap'
                      }}>
                        {pods.length} pod{pods.length !== 1 ? 's' : ''}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default DisruptionTracker;

