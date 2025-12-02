import React from 'react';

function NodePoolCard({ recommendation }) {
  // Support both old format (NodePoolRecommendation) and new format (NodePoolCapacityRecommendation)
  const isNewFormat = recommendation.nodePoolName !== undefined;
  
  // Debug: Log AI reasoning availability
  if (recommendation.aiReasoning !== undefined) {
    console.log(`[NodePoolCard] ${recommendation.nodePoolName || recommendation.name}: aiReasoning=${!!recommendation.aiReasoning}, length=${recommendation.aiReasoning?.length || 0}, reasoning=${!!recommendation.reasoning}`);
  }
  
  const nodePoolName = isNewFormat ? recommendation.nodePoolName : recommendation.name;
  const currentNodes = isNewFormat 
    ? recommendation.currentNodes 
    : (recommendation.currentState?.totalNodes || 0);
  const recommendedNodes = isNewFormat
    ? recommendation.recommendedNodes
    : (recommendation.maxSize > 0 ? Math.ceil(recommendation.maxSize / 2) : 0);
  const currentInstanceTypes = isNewFormat
    ? recommendation.currentInstanceTypes || []
    : (recommendation.currentState?.instanceTypes || []);
  const recommendedInstanceTypes = isNewFormat
    ? recommendation.recommendedInstanceTypes || []
    : (recommendation.instanceTypes || []);
  const currentCapacityType = isNewFormat
    ? recommendation.capacityType || ''
    : (recommendation.currentState?.capacityType || '');
  const recommendedCapacityType = recommendation.capacityType || '';
  const currentCost = isNewFormat
    ? recommendation.currentCost || 0
    : (recommendation.currentState?.estimatedCost || 0);
  const recommendedCost = isNewFormat
    ? recommendation.recommendedCost || 0
    : (recommendation.estimatedCost || 0);
  const currentCPU = isNewFormat
    ? recommendation.currentCPUCapacity || 0
    : (recommendation.currentState?.totalCPU || 0);
  const currentMemory = isNewFormat
    ? recommendation.currentMemoryCapacity || 0
    : (recommendation.currentState?.totalMemory || 0);
  const recommendedCPU = isNewFormat
    ? recommendation.recommendedTotalCPU || 0
    : 0;
  const recommendedMemory = isNewFormat
    ? recommendation.recommendedTotalMemory || 0
    : 0;
  
  const hasChanges = 
    currentNodes !== recommendedNodes ||
    JSON.stringify(currentInstanceTypes.sort()) !== JSON.stringify(recommendedInstanceTypes.sort()) ||
    currentCapacityType !== recommendedCapacityType;
  
  const hasGPU = recommendation.requirements?.gpu > 0 || recommendedInstanceTypes.some(t => t.startsWith('g4') || t.startsWith('g5'));

  return (
    <div style={{ 
      background: 'white', 
      padding: '1.5rem', 
      borderRadius: '8px',
      border: hasChanges ? '2px solid #10b981' : '1px solid #e5e7eb',
      fontSize: '0.875rem',
      lineHeight: '1.5'
    }}>
      <div style={{ 
        display: 'flex', 
        justifyContent: 'space-between', 
        alignItems: 'start',
        marginBottom: '1.25rem'
      }}>
        <div>
          <h3 style={{ 
            margin: 0, 
            fontSize: '1.125rem', 
            fontWeight: 600,
            color: '#111827',
            marginBottom: '0.375rem'
          }}>
            {nodePoolName}
          </h3>
          {hasChanges && (
            <div style={{ fontSize: '0.875rem', color: '#10b981', fontWeight: 500 }}>
              Changes recommended
            </div>
          )}
        </div>
        <div style={{ 
          padding: '0.375rem 0.75rem', 
          background: recommendedCapacityType === 'on-demand' ? '#fef3c7' : '#d1fae5',
          color: recommendedCapacityType === 'on-demand' ? '#92400e' : '#065f46',
          borderRadius: '4px',
          fontSize: '0.875rem',
          fontWeight: 600
        }}>
          {recommendedCapacityType === 'on-demand' ? 'On-Demand' : 'Spot'}
        </div>
      </div>

      {/* Before/After Comparison */}
      <div style={{ 
        display: 'grid', 
        gridTemplateColumns: '1fr 1fr', 
        gap: '1.25rem',
        marginBottom: '1.25rem',
        padding: '1rem',
        background: '#f9fafb',
        borderRadius: '6px'
      }}>
        <div>
          <div style={{ fontSize: '0.8125rem', color: '#374151', marginBottom: '0.625rem', fontWeight: 600 }}>
            Current
          </div>
          <div style={{ fontSize: '1rem', fontWeight: 600, color: '#111827', marginBottom: '0.5rem' }}>
            {currentNodes} nodes
          </div>
          {currentInstanceTypes.length > 0 && (
            <div style={{ fontSize: '0.8125rem', color: '#4b5563', fontFamily: 'monospace', marginTop: '0.375rem', lineHeight: '1.4' }}>
              {currentInstanceTypes.slice(0, 2).map(type => typeof type === 'string' ? type : type).join(', ')}
              {currentInstanceTypes.length > 2 && ` +${currentInstanceTypes.length - 2}`}
            </div>
          )}
          {currentCPU > 0 && (
            <div style={{ fontSize: '0.8125rem', color: '#4b5563', marginTop: '0.375rem' }}>
              CPU: {currentCPU.toFixed(2)} cores
            </div>
          )}
          {currentMemory > 0 && (
            <div style={{ fontSize: '0.8125rem', color: '#4b5563', marginTop: '0.25rem' }}>
              Memory: {currentMemory.toFixed(2)} GiB
            </div>
          )}
          {currentCost > 0 && (
            <div style={{ fontSize: '0.8125rem', color: '#4b5563', marginTop: '0.375rem', fontWeight: 500 }}>
              ${currentCost.toFixed(2)}/hr
            </div>
          )}
        </div>
        <div>
          <div style={{ fontSize: '0.8125rem', color: '#374151', marginBottom: '0.625rem', fontWeight: 600 }}>
            Recommended
          </div>
          <div style={{ fontSize: '1rem', fontWeight: 600, color: '#10b981', marginBottom: '0.5rem' }}>
            {recommendedNodes} nodes
            {!isNewFormat && recommendation.minSize > 0 && recommendation.maxSize > 0 && (
              <span style={{ fontSize: '0.8125rem', fontWeight: 400, color: '#6b7280', marginLeft: '0.25rem' }}>
                ({recommendation.minSize}-{recommendation.maxSize})
              </span>
            )}
          </div>
          {recommendedInstanceTypes.length > 0 && (
            <div style={{ fontSize: '0.8125rem', color: '#4b5563', fontFamily: 'monospace', marginTop: '0.375rem', lineHeight: '1.4' }}>
              {recommendedInstanceTypes.slice(0, 2).join(', ')}
              {recommendedInstanceTypes.length > 2 && ` +${recommendedInstanceTypes.length - 2}`}
            </div>
          )}
          {recommendedCPU > 0 && (
            <div style={{ fontSize: '0.8125rem', color: '#4b5563', marginTop: '0.375rem' }}>
              CPU: {recommendedCPU.toFixed(2)} cores
            </div>
          )}
          {recommendedMemory > 0 && (
            <div style={{ fontSize: '0.8125rem', color: '#4b5563', marginTop: '0.25rem' }}>
              Memory: {recommendedMemory.toFixed(2)} GiB
            </div>
          )}
          {recommendedCost > 0 && (
            <div style={{ fontSize: '0.8125rem', color: '#10b981', marginTop: '0.375rem', fontWeight: 600 }}>
              ${recommendedCost.toFixed(2)}/hr
            </div>
          )}
          {isNewFormat && recommendation.costSavings > 0 && (
            <div style={{ fontSize: '0.8125rem', color: '#10b981', marginTop: '0.375rem', fontWeight: 500 }}>
              Savings: ${recommendation.costSavings.toFixed(2)}/hr ({recommendation.costSavingsPercent.toFixed(1)}%)
            </div>
          )}
        </div>
      </div>

      {/* Instance Types - Show All */}
      {recommendedInstanceTypes.length > 0 && (
        <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid #e5e7eb' }}>
          <div style={{ fontSize: '0.875rem', color: '#374151', marginBottom: '0.75rem', fontWeight: 600 }}>
            Recommended Instance Types ({recommendedInstanceTypes.length})
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
            {recommendedInstanceTypes.map((type, idx) => (
              <span key={idx} style={{ 
                padding: '0.5rem 0.75rem', 
                background: hasGPU && (type.startsWith('g4') || type.startsWith('g5')) ? '#fee2e2' : '#e5e7eb',
                color: hasGPU && (type.startsWith('g4') || type.startsWith('g5')) ? '#991b1b' : '#374151',
                borderRadius: '4px',
                fontSize: '0.8125rem',
                fontFamily: 'monospace',
                fontWeight: 500,
                lineHeight: '1.2'
              }}>
                {type}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Current Instance Types for Comparison */}
      {currentInstanceTypes.length > 0 && hasChanges && (
        <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid #e5e7eb' }}>
          <div style={{ fontSize: '0.875rem', color: '#374151', marginBottom: '0.75rem', fontWeight: 600 }}>
            Current Instance Types ({currentInstanceTypes.length})
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
            {currentInstanceTypes.map((type, idx) => (
              <span key={idx} style={{ 
                padding: '0.5rem 0.75rem', 
                background: '#f3f4f6',
                color: '#4b5563',
                borderRadius: '4px',
                fontSize: '0.8125rem',
                fontFamily: 'monospace',
                textDecoration: recommendedInstanceTypes.includes(type) ? 'none' : 'line-through',
                opacity: recommendedInstanceTypes.includes(type) ? 1 : 0.6,
                lineHeight: '1.2'
              }}>
                {type}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Reasoning/Explanation */}
      {(recommendation.reasoning || recommendation.aiReasoning) && (
        <div style={{ 
          marginTop: '1rem',
          padding: '1rem',
          background: '#eff6ff',
          borderRadius: '6px',
          border: '1px solid #bfdbfe'
        }}>
          {/* AI-Enhanced Reasoning (if available) */}
          {recommendation.aiReasoning && recommendation.aiReasoning.trim() !== '' && (
            <>
              <div style={{ 
                fontSize: '0.875rem', 
                color: '#1e40af', 
                marginBottom: '0.75rem',
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem'
              }}>
                <span>✨ AI-Enhanced Explanation</span>
              </div>
              <div style={{ 
                fontSize: '0.875rem', 
                color: '#1e3a8a',
                lineHeight: '1.6',
                whiteSpace: 'pre-wrap',
                wordWrap: 'break-word',
                overflowWrap: 'break-word',
                marginBottom: recommendation.reasoning ? '1rem' : '0'
              }}>
                {recommendation.aiReasoning}
              </div>
            </>
          )}
          
          {/* Original Reasoning (shown if AI reasoning is not available, or as details) */}
          {recommendation.reasoning && (
            <>
              {recommendation.aiReasoning && recommendation.aiReasoning.trim() !== '' ? (
                <details open={false} style={{ 
                  marginTop: '0.5rem',
                  display: 'block'
                }}>
                  <summary style={{ 
                    fontSize: '0.75rem', 
                    color: '#64748b',
                    cursor: 'pointer',
                    fontWeight: 500,
                    userSelect: 'none',
                    padding: '0.25rem 0',
                    listStyle: 'none',
                    display: 'list-item'
                  }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                      <span style={{ fontSize: '0.6rem' }}>▼</span>
                      <span>Show technical details</span>
                    </span>
                  </summary>
                  <div style={{ 
                    fontSize: '0.75rem', 
                    color: '#64748b',
                    lineHeight: '1.6',
                    whiteSpace: 'pre-wrap',
                    wordWrap: 'break-word',
                    overflowWrap: 'break-word',
                    marginTop: '0.5rem',
                    paddingTop: '0.5rem',
                    paddingLeft: '1rem',
                    borderTop: '1px solid #cbd5e1'
                  }}>
                    {recommendation.reasoning}
                  </div>
                </details>
              ) : (
                <>
                  <div style={{ 
                    fontSize: '0.875rem', 
                    color: '#1e40af', 
                    marginBottom: '0.75rem',
                    fontWeight: 600
                  }}>
                    {isNewFormat ? 'Explanation' : 'Why these changes?'}
                  </div>
                  <div style={{ 
                    fontSize: '0.875rem', 
                    color: '#1e3a8a',
                    lineHeight: '1.6',
                    whiteSpace: 'pre-wrap',
                    wordWrap: 'break-word',
                    overflowWrap: 'break-word'
                  }}>
                    {recommendation.reasoning}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}


      {hasGPU && (
        <div style={{ 
          marginTop: '1rem',
          padding: '0.625rem 0.875rem',
          background: '#fee2e2',
          color: '#991b1b',
          borderRadius: '4px',
          fontSize: '0.875rem',
          fontWeight: 500
        }}>
          ⚠️ GPU instances detected
        </div>
      )}
    </div>
  );
}

export default NodePoolCard;
