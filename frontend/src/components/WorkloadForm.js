import React from 'react';

function WorkloadForm({ workload, index, onChange, onRemove }) {
  const handleChange = (field, value) => {
    onChange(index, field, value);
  };

  return (
    <div className="workload-form">
      <div className="workload-form-header">
        <h3>Workload #{index + 1}</h3>
        {index > 0 && (
          <button 
            className="btn btn-danger"
            onClick={() => onRemove(index)}
          >
            Remove
          </button>
        )}
      </div>
      <div className="workload-form-grid">
        <div className="form-group">
          <label>Name</label>
          <input
            type="text"
            value={workload.name}
            onChange={(e) => handleChange('name', e.target.value)}
            placeholder="workload-name"
          />
        </div>
        <div className="form-group">
          <label>Namespace</label>
          <input
            type="text"
            value={workload.namespace}
            onChange={(e) => handleChange('namespace', e.target.value)}
            placeholder="default"
          />
        </div>
        <div className="form-group">
          <label>CPU</label>
          <input
            type="text"
            value={workload.cpu}
            onChange={(e) => handleChange('cpu', e.target.value)}
            placeholder="500m"
          />
        </div>
        <div className="form-group">
          <label>Memory</label>
          <input
            type="text"
            value={workload.memory}
            onChange={(e) => handleChange('memory', e.target.value)}
            placeholder="512Mi"
          />
        </div>
        <div className="form-group">
          <label>GPU</label>
          <input
            type="number"
            value={workload.gpu}
            onChange={(e) => handleChange('gpu', parseInt(e.target.value) || 0)}
            min="0"
          />
        </div>
      </div>
    </div>
  );
}

export default WorkloadForm;

