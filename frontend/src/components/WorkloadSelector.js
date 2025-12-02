import React, { useState, useEffect } from 'react';
import axios from 'axios';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:8080';

function WorkloadSelector({ onWorkloadsSelected, selectedWorkloads }) {
  const [namespaces, setNamespaces] = useState([]);
  const [selectedNamespace, setSelectedNamespace] = useState('');
  const [workloads, setWorkloads] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [k8sAvailable, setK8sAvailable] = useState(true);

  useEffect(() => {
    loadNamespaces();
  }, []);

  useEffect(() => {
    if (selectedNamespace) {
      loadWorkloads(selectedNamespace);
    } else {
      setWorkloads([]);
    }
  }, [selectedNamespace]);

  const loadNamespaces = async () => {
    try {
      const response = await axios.get(`${API_URL}/api/v1/namespaces`);
      setNamespaces(response.data.namespaces || []);
      setK8sAvailable(true);
    } catch (err) {
      console.error('Failed to load namespaces:', err);
      setK8sAvailable(false);
      if (err.response?.status === 503) {
        setError('Kubernetes client not configured. Please set KUBECONFIG or run in-cluster.');
      }
    }
  };

  const loadWorkloads = async (namespace) => {
    setLoading(true);
    setError(null);
    try {
      const response = await axios.get(`${API_URL}/api/v1/workloads?namespace=${namespace}`);
      setWorkloads(response.data.workloads || []);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to load workloads');
      console.error('Failed to load workloads:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleWorkloadToggle = (workload) => {
    const isSelected = selectedWorkloads.some(
      w => w.name === workload.name && w.namespace === workload.namespace
    );

    if (isSelected) {
      // Remove workload
      const updated = selectedWorkloads.filter(
        w => !(w.name === workload.name && w.namespace === workload.namespace)
      );
      onWorkloadsSelected(updated);
    } else {
      // Add workload
      const newWorkload = {
        name: workload.name,
        namespace: workload.namespace,
        cpu: workload.cpuLimit || workload.cpuRequest || '100m',
        memory: workload.memoryLimit || workload.memoryRequest || '128Mi',
        cpuRequest: workload.cpuRequest || '',
        memoryRequest: workload.memoryRequest || '',
        gpu: workload.gpu || 0,
        labels: workload.labels || {},
      };
      onWorkloadsSelected([...selectedWorkloads, newWorkload]);
    }
  };

  if (!k8sAvailable) {
    return (
      <div className="workload-selector-disabled">
        <p>⚠️ Kubernetes integration not available. Please configure KUBECONFIG or run in-cluster.</p>
        <p style={{ fontSize: '0.9rem', color: '#666', marginTop: '0.5rem' }}>
          You can still add workloads manually below.
        </p>
      </div>
    );
  }

  return (
    <div className="workload-selector">
      <h3>📦 Select Workloads from Cluster</h3>
      
      <div className="selector-controls">
        <div className="form-group">
          <label>Namespace:</label>
          <select
            value={selectedNamespace}
            onChange={(e) => setSelectedNamespace(e.target.value)}
            disabled={loading}
          >
            <option value="">Select a namespace...</option>
            {namespaces.map((ns) => (
              <option key={ns} value={ns}>
                {ns}
              </option>
            ))}
          </select>
        </div>

        {loading && (
          <div className="loading-indicator">Loading workloads...</div>
        )}

        {error && (
          <div className="error-message" style={{ marginTop: '1rem' }}>
            ⚠️ {error}
          </div>
        )}
      </div>

      {workloads.length > 0 && (
        <div className="workloads-list-selector">
          <h4>Available Workloads ({workloads.length})</h4>
          <div className="workload-checkboxes">
            {workloads.map((workload) => {
              const isSelected = selectedWorkloads.some(
                w => w.name === workload.name && w.namespace === workload.namespace
              );
              
              return (
                <div
                  key={`${workload.namespace}-${workload.name}-${workload.type}`}
                  className={`workload-checkbox ${isSelected ? 'selected' : ''}`}
                  onClick={() => handleWorkloadToggle(workload)}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => handleWorkloadToggle(workload)}
                  />
                  <div className="workload-info">
                    <div className="workload-name">
                      <strong>{workload.name}</strong>
                      <span className="workload-type">{workload.type}</span>
                    </div>
                    <div className="workload-resources">
                      <span>CPU: {workload.cpuRequest || workload.cpuLimit || 'N/A'}</span>
                      <span>Memory: {workload.memoryRequest || workload.memoryLimit || 'N/A'}</span>
                      {workload.gpu > 0 && <span>GPU: {workload.gpu}</span>}
                      <span>Replicas: {workload.replicas || 'N/A'}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {selectedWorkloads.length > 0 && (
        <div className="selected-workloads-summary">
          <h4>Selected Workloads ({selectedWorkloads.length})</h4>
          <div className="selected-tags">
            {selectedWorkloads.map((w, idx) => (
              <span key={idx} className="selected-tag">
                {w.namespace}/{w.name}
                <button
                  onClick={() => {
                    const updated = selectedWorkloads.filter((_, i) => i !== idx);
                    onWorkloadsSelected(updated);
                  }}
                  className="remove-tag"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default WorkloadSelector;

