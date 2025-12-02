package recommender

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/karpenter-optimizer/internal/config"
)

func TestNewRecommender(t *testing.T) {
	cfg := &config.Config{}
	rec := NewRecommender(cfg)
	
	assert.NotNil(t, rec)
}

func TestEstimateCost(t *testing.T) {
	cfg := &config.Config{}
	rec := NewRecommender(cfg)
	ctx := context.Background()

	tests := []struct {
		name          string
		instanceTypes []string
		capacityType  string
		nodeCount     int
		expectError   bool
	}{
		{
			name:          "valid on-demand instance",
			instanceTypes: []string{"m5.large"},
			capacityType:  "on-demand",
			nodeCount:     1,
			expectError:   false,
		},
		{
			name:          "valid spot instance",
			instanceTypes: []string{"m5.large"},
			capacityType:  "spot",
			nodeCount:     1,
			expectError:   false,
		},
		{
			name:          "multiple nodes",
			instanceTypes: []string{"m5.large"},
			capacityType:  "on-demand",
			nodeCount:     3,
			expectError:   false,
		},
		{
			name:          "invalid instance type",
			instanceTypes: []string{"invalid.type"},
			capacityType:  "on-demand",
			nodeCount:     1,
			expectError:   false, // Should fallback gracefully
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cost := rec.EstimateCost(ctx, tt.instanceTypes, tt.capacityType, tt.nodeCount)
			
			if !tt.expectError {
				assert.GreaterOrEqual(t, cost, 0.0, "Cost should be non-negative")
			}
		})
	}
}

func TestEstimateInstanceCapacity(t *testing.T) {
	cfg := &config.Config{}
	rec := NewRecommender(cfg)

	tests := []struct {
		name         string
		instanceType string
		expectCPU    float64
		expectMemory float64
	}{
		{
			name:         "m5.large",
			instanceType: "m5.large",
			expectCPU:    2.0,
			expectMemory: 8.0,
		},
		{
			name:         "m5.xlarge",
			instanceType: "m5.xlarge",
			expectCPU:    4.0,
			expectMemory: 16.0,
		},
		{
			name:         "unknown instance type",
			instanceType: "unknown.type",
			expectCPU:    4.0, // Default fallback
			expectMemory: 8.0, // Default fallback
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cpu, memory := rec.estimateInstanceCapacity(tt.instanceType)
			
			assert.Equal(t, tt.expectCPU, cpu, "CPU should match expected value")
			assert.Equal(t, tt.expectMemory, memory, "Memory should match expected value")
		})
	}
}

