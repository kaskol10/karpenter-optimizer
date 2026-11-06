import React from 'react';

function ClusterSummary({ recommendations }) {
  if (!recommendations || recommendations.length === 0) {
    return null;
  }

  const totalCurrentNodes = recommendations.reduce((sum, rec) => 
    sum + (rec.currentState?.totalNodes || 0), 0
  );
  const totalRecommendedNodes = recommendations.reduce((sum, rec) => {
    const avgNodes = rec.maxSize > 0 ? Math.ceil(rec.maxSize / 2) : 0;
    return sum + avgNodes;
  }, 0);
  const totalCurrentCost = recommendations.reduce((sum, rec) => 
    sum + (rec.currentState?.estimatedCost || 0), 0
  );
  const totalRecommendedCost = recommendations.reduce((sum, rec) => 
    sum + (rec.estimatedCost || 0), 0
  );

  const nodePoolsWithChanges = recommendations.filter(rec => {
    const currentNodes = rec.currentState?.totalNodes || 0;
    const recommendedNodes = rec.maxSize > 0 ? Math.ceil(rec.maxSize / 2) : 0;
    const currentTypes = rec.currentState?.instanceTypes || [];
    const recommendedTypes = rec.instanceTypes || [];
    const currentCapacity = rec.currentState?.capacityType || '';
    const recommendedCapacity = rec.capacityType || '';
    
    return currentNodes !== recommendedNodes ||
           JSON.stringify(currentTypes.sort()) !== JSON.stringify(recommendedTypes.sort()) ||
           currentCapacity !== recommendedCapacity;
  }).length;

  return (
    <div>
      <div style={{ 
        display: 'grid', 
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', 
        gap: '1rem',
        marginBottom: '1.5rem'
      }}>
        <div style={{ 
          padding: '1rem', 
          background: '#f9fafb',
          borderRadius: '8px',
          border: '1px solid #e5e7eb'
        }}>
          <div style={{ fontSize: '0.75rem', color: '#6b7280', marginBottom: '0.5rem' }}>Current Nodes</div>
          <div style={{ fontSize: '1.5rem', fontWeight: 600, color: '#111827' }}>{totalCurrentNodes}</div>
          <div style={{ fontSize: '0.75rem', color: '#6b7280', marginTop: '0.25rem' }}>
            ${totalCurrentCost.toFixed(2)}/hr
          </div>
        </div>
        
        <div style={{ 
          padding: '1rem', 
          background: '#f0fdf4',
          borderRadius: '8px',
          border: '1px solid #bbf7d0'
        }}>
          <div style={{ fontSize: '0.75rem', color: '#166534', marginBottom: '0.5rem' }}>Recommended Nodes</div>
          <div style={{ fontSize: '1.5rem', fontWeight: 600, color: '#166534' }}>{totalRecommendedNodes}</div>
          <div style={{ fontSize: '0.75rem', color: '#166534', marginTop: '0.25rem' }}>
            ${totalRecommendedCost.toFixed(2)}/hr
          </div>
        </div>
        
        {totalCurrentCost > totalRecommendedCost && (
          <div style={{ 
            padding: '1rem', 
            background: '#fef3c7',
            borderRadius: '8px',
            border: '1px solid #fde047'
          }}>
            <div style={{ fontSize: '0.75rem', color: '#92400e', marginBottom: '0.5rem' }}>Potential Savings</div>
            <div style={{ fontSize: '1.5rem', fontWeight: 600, color: '#92400e' }}>
              {((totalCurrentCost - totalRecommendedCost) / totalCurrentCost * 100).toFixed(1)}%
            </div>
            <div style={{ fontSize: '0.75rem', color: '#92400e', marginTop: '0.25rem' }}>
              ${(totalCurrentCost - totalRecommendedCost).toFixed(2)}/hr
            </div>
          </div>
        )}

        <div style={{ 
          padding: '1rem', 
          background: '#eff6ff',
          borderRadius: '8px',
          border: '1px solid #bfdbfe'
        }}>
          <div style={{ fontSize: '0.75rem', color: '#1e40af', marginBottom: '0.5rem' }}>NodePools with Changes</div>
          <div style={{ fontSize: '1.5rem', fontWeight: 600, color: '#1e40af' }}>
            {nodePoolsWithChanges} / {recommendations.length}
          </div>
        </div>
      </div>
    </div>
  );
}

export default ClusterSummary;
