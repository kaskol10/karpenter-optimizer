import React from 'react';

function RecommendationCard({ recommendation }) {
  const currentCost = recommendation.currentState?.estimatedCost || 0;
  const recommendedCost = recommendation.estimatedCost || 0;
  const savings = currentCost - recommendedCost;
  const savingsPercent = currentCost > 0 ? ((savings / currentCost) * 100).toFixed(1) : 0;

  return (
    <div style={{ 
      background: 'white', 
      padding: '1.5rem', 
      borderRadius: '8px', 
      border: '1px solid #e9ecef',
      display: 'flex',
      flexDirection: 'column',
      gap: '1rem'
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
        <h3 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 600 }}>{recommendation.name}</h3>
        {savings > 0 && (
          <span style={{ 
            padding: '0.25rem 0.75rem', 
            background: '#10b981', 
            color: 'white', 
            borderRadius: '4px',
            fontSize: '0.875rem',
            fontWeight: 600
          }}>
            Save {savingsPercent}%
          </span>
        )}
      </div>

      {/* Cost Comparison */}
      {currentCost > 0 && (
        <div style={{ 
          display: 'grid', 
          gridTemplateColumns: '1fr 1fr', 
          gap: '1rem',
          padding: '1rem',
          background: '#f8f9fa',
          borderRadius: '6px'
        }}>
          <div>
            <div style={{ fontSize: '0.75rem', color: '#666', marginBottom: '0.25rem' }}>Current</div>
            <div style={{ fontSize: '1.125rem', fontWeight: 600, color: '#ef4444' }}>
              ${currentCost.toFixed(2)}/hr
            </div>
            <div style={{ fontSize: '0.75rem', color: '#666', marginTop: '0.25rem' }}>
              {recommendation.currentState?.totalNodes || 0} nodes
            </div>
          </div>
          <div>
            <div style={{ fontSize: '0.75rem', color: '#666', marginBottom: '0.25rem' }}>Recommended</div>
            <div style={{ fontSize: '1.125rem', fontWeight: 600, color: '#10b981' }}>
              ${recommendedCost.toFixed(2)}/hr
            </div>
            <div style={{ fontSize: '0.75rem', color: '#666', marginTop: '0.25rem' }}>
              ~{recommendation.maxSize > 0 ? Math.ceil(recommendation.maxSize / 2) : 0} nodes
            </div>
          </div>
        </div>
      )}

      {/* Key Details */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.75rem', fontSize: '0.875rem' }}>
        <div>
          <span style={{ color: '#666' }}>Capacity:</span>
          <span style={{ marginLeft: '0.5rem', fontWeight: 500 }}>{recommendation.capacityType || 'spot'}</span>
        </div>
        <div>
          <span style={{ color: '#666' }}>Architecture:</span>
          <span style={{ marginLeft: '0.5rem', fontWeight: 500 }}>{recommendation.architecture || 'amd64'}</span>
        </div>
        {recommendation.instanceTypes && recommendation.instanceTypes.length > 0 && (
          <div style={{ gridColumn: '1 / -1' }}>
            <span style={{ color: '#666' }}>Instance Types:</span>
            <div style={{ marginTop: '0.25rem', display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
              {recommendation.instanceTypes.slice(0, 5).map((type, idx) => (
                <span key={idx} style={{ 
                  padding: '0.125rem 0.5rem', 
                  background: '#e9ecef', 
                  borderRadius: '4px',
                  fontSize: '0.75rem'
                }}>
                  {type}
                </span>
              ))}
              {recommendation.instanceTypes.length > 5 && (
                <span style={{ fontSize: '0.75rem', color: '#666' }}>
                  +{recommendation.instanceTypes.length - 5} more
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Reasoning */}
      {recommendation.reasoning && (
        <div style={{ 
          padding: '0.75rem', 
          background: '#f8f9fa', 
          borderRadius: '6px',
          fontSize: '0.875rem',
          color: '#666',
          borderLeft: '3px solid #667eea'
        }}>
          {recommendation.reasoning}
        </div>
      )}
    </div>
  );
}

export default RecommendationCard;
