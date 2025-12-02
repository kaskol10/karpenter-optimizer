import React from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

function ComparisonView({ recommendations }) {
  if (!recommendations || recommendations.length === 0) {
    return null;
  }

  // Calculate totals
  const totalCurrentCost = recommendations.reduce((sum, rec) => 
    sum + (rec.currentState?.estimatedCost || 0), 0
  );
  const totalRecommendedCost = recommendations.reduce((sum, rec) => 
    sum + (rec.estimatedCost || 0), 0
  );

  const costSavings = totalCurrentCost - totalRecommendedCost;
  const costSavingsPercent = totalCurrentCost > 0 
    ? ((costSavings / totalCurrentCost) * 100).toFixed(1) 
    : 0;

  const chartData = recommendations.map(rec => ({
    name: rec.name,
    current: rec.currentState?.estimatedCost || 0,
    recommended: rec.estimatedCost || 0,
    currentNodes: rec.currentState?.totalNodes || 0,
    recommendedNodes: rec.maxSize > 0 ? Math.ceil(rec.maxSize / 2) : 0,
  }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      {/* Summary Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '1rem' }}>
        <div style={{ padding: '1.5rem', background: '#f8f9fa', borderRadius: '8px', border: '1px solid #e9ecef' }}>
          <div style={{ fontSize: '0.875rem', color: '#666', marginBottom: '0.5rem' }}>Current Cost</div>
          <div style={{ fontSize: '1.75rem', fontWeight: 600, color: '#333' }}>
            ${totalCurrentCost.toFixed(2)}<span style={{ fontSize: '1rem', fontWeight: 400, color: '#666' }}>/hr</span>
          </div>
        </div>
        
        <div style={{ padding: '1.5rem', background: '#f8f9fa', borderRadius: '8px', border: '1px solid #e9ecef' }}>
          <div style={{ fontSize: '0.875rem', color: '#666', marginBottom: '0.5rem' }}>Recommended Cost</div>
          <div style={{ fontSize: '1.75rem', fontWeight: 600, color: '#10b981' }}>
            ${totalRecommendedCost.toFixed(2)}<span style={{ fontSize: '1rem', fontWeight: 400, color: '#666' }}>/hr</span>
          </div>
        </div>
        
        <div style={{ padding: '1.5rem', background: '#f8f9fa', borderRadius: '8px', border: '1px solid #e9ecef' }}>
          <div style={{ fontSize: '0.875rem', color: '#666', marginBottom: '0.5rem' }}>Potential Savings</div>
          <div style={{ fontSize: '1.75rem', fontWeight: 600, color: costSavings > 0 ? '#10b981' : '#ef4444' }}>
            ${Math.abs(costSavings).toFixed(2)}<span style={{ fontSize: '1rem', fontWeight: 400, color: '#666' }}>/hr</span>
          </div>
          {costSavingsPercent !== '0' && (
            <div style={{ fontSize: '0.875rem', color: '#666', marginTop: '0.25rem' }}>
              {costSavingsPercent}% reduction
            </div>
          )}
        </div>
      </div>

      {/* Cost Comparison Chart */}
      <div style={{ background: 'white', padding: '1.5rem', borderRadius: '8px', border: '1px solid #e9ecef' }}>
        <h3 style={{ marginBottom: '1rem', fontSize: '1.125rem', fontWeight: 600 }}>Cost by NodePool</h3>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={chartData}>
            <XAxis dataKey="name" angle={-45} textAnchor="end" height={80} />
            <YAxis />
            <Tooltip formatter={(value) => `$${value.toFixed(2)}/hr`} />
            <Bar dataKey="current" fill="#ef4444" name="Current" />
            <Bar dataKey="recommended" fill="#10b981" name="Recommended" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export default ComparisonView;
