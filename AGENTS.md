# AGENTS.md - AI Assistant Guidelines

This document provides context and guidelines for AI coding assistants working on the Karpenter Optimizer project.

## Project Overview

**Karpenter Optimizer** is a tool for optimizing Karpenter NodePool configurations based on actual cluster usage data. It analyzes Kubernetes workloads and node capacity to provide cost-optimized instance type recommendations.

### Key Purpose
- Analyze actual node capacity and usage (CPU/Memory) from Kubernetes cluster
- Generate cost-optimized NodePool recommendations using AWS instance types
- Provide AI-enhanced explanations of recommendations and their benefits
- Support both spot and on-demand instance type optimization

## Architecture

### Backend (Go)
- **Location**: `cmd/api/` (main entry), `internal/` (core logic)
- **Framework**: Gin (HTTP router)
- **Key Components**:
  - `internal/api/server.go` - REST API endpoints
  - `internal/recommender/recommender.go` - Legacy recommendation logic (cluster-summary based)
  - `internal/recommender/node_pool_recommender.go` - **PRIMARY** recommendation engine (NodePool-based)
  - `internal/kubernetes/client.go` - Kubernetes API client (nodes, pods, NodePools)
  - `internal/awspricing/client.go` - AWS Pricing API client for instance pricing
  - `internal/ollama/client.go` - Ollama LLM client for AI explanations

### Frontend (React)
- **Location**: `frontend/src/`
- **Key Components**:
  - `App.js` - Main application component
  - `components/GlobalClusterSummary.js` - Cluster overview and recommendation trigger
  - `components/NodePoolCard.js` - Displays individual NodePool recommendations
  - `components/NodeUsageView.js` - Real-time node resource usage visualization
  - `components/DisruptionTracker.js` - Node disruption tracking (on-demand)

## Key Data Structures

### NodePoolCapacityRecommendation (Primary Format)
```go
type NodePoolCapacityRecommendation struct {
    NodePoolName             string   `json:"nodePoolName"`
    CurrentNodes             int      `json:"currentNodes"`
    CurrentInstanceTypes     []string `json:"currentInstanceTypes"` // Format: "m6g.2xlarge (27)"
    CurrentCPUUsed           float64  `json:"currentCPUUsed"`
    CurrentCPUCapacity       float64  `json:"currentCPUCapacity"`
    CurrentMemoryUsed        float64  `json:"currentMemoryUsed"`
    CurrentMemoryCapacity    float64  `json:"currentMemoryCapacity"`
    CurrentCost              float64  `json:"currentCost"`
    RecommendedNodes         int      `json:"recommendedNodes"`
    RecommendedInstanceTypes []string `json:"recommendedInstanceTypes"`
    RecommendedTotalCPU      float64  `json:"recommendedTotalCPU"`
    RecommendedTotalMemory   float64  `json:"recommendedTotalMemory"`
    RecommendedCost          float64  `json:"recommendedCost"`
    CostSavings              float64  `json:"costSavings"`
    CostSavingsPercent       float64  `json:"costSavingsPercent"`
    Reasoning                string   `json:"reasoning"` // AI-generated explanation
    Architecture             string   `json:"architecture"` // arm64 or amd64
    CapacityType             string   `json:"capacityType"` // spot or on-demand
}
```

### NodeInfo (from Kubernetes client)
```go
type NodeInfo struct {
    Name          string
    InstanceType  string
    Architecture  string
    CapacityType  string // "spot" or "on-demand"
    NodePool      string
    CPUUsage      *ResourceUsage
    MemoryUsage   *ResourceUsage
    PodCount      int
    // ...
}
```

## API Endpoints

### Primary Recommendation Endpoints
- `GET /api/v1/recommendations` - NodePool-based recommendations (uses `GenerateRecommendationsFromNodePools`)
- `GET /api/v1/nodepools/recommendations` - Same as above, returns recommendations array
- `GET /api/v1/recommendations/cluster-summary` - **Enhanced with Ollama explanations** (uses nodepools endpoint + Ollama)
- `GET /api/v1/recommendations/cluster-summary/stream` - SSE version with progress updates

### Data Endpoints
- `GET /api/v1/nodepools` - List all NodePools with actual node data
- `GET /api/v1/nodes` - Get all nodes with usage data
- `GET /api/v1/cluster/summary` - Cluster-wide statistics

## Important Patterns and Conventions

### 1. Recommendation Generation Flow
```
1. Fetch NodePools with actual nodes (ListNodePools)
2. For each NodePool:
   a. Calculate current capacity (CPU/Memory allocatable from nodes)
   b. Calculate current cost (based on actual instance types and capacity types)
   c. Find optimal instance types (findOptimalInstanceTypesWithCapacityType)
   d. Try both spot and on-demand to find best cost
   e. Only recommend if cost savings > 0
3. Enhance with Ollama explanations (if Ollama available)
```

### 2. Capacity Type Handling
- **Always analyze actual node capacity types** (spot vs on-demand)
- **Try both spot and on-demand** when finding optimal instance types
- **Prefer spot** if nodes are already spot, or if converting on-demand to spot saves money
- **Default to on-demand** if capacity type is unknown

### 3. Cost Calculation
- **Current Cost**: Sum of individual node costs based on:
  - Instance type
  - Actual capacity type (spot = 25% of on-demand, on-demand = full price)
- **Recommended Cost**: Based on recommended instance types and capacity type
- **Use AWS Pricing API** first, then cache, then family-based estimation, then Ollama fallback

### 4. Instance Type Selection
- **Query AWS Pricing API** for available instance types (future-proof)
- **Filter by architecture** (arm64 vs amd64)
- **Filter by CPU/Memory ratio** (memory-optimized, CPU-optimized, general-purpose)
- **Try combinations** of 1-3 instance types
- **Sort by cost efficiency** (cost per unit of capacity)

### 5. Node Usage Calculation
- **Use resource requests only** (not limits)
- **Exclude init containers** from usage calculation
- **Only count scheduled pods** (with `spec.nodeName` set)
- **Exclude terminating/terminal pods** (Succeeded, Failed phases)

### 6. Frontend Format Support
- **Support both formats**: Old (`NodePoolRecommendation`) and new (`NodePoolCapacityRecommendation`)
- **Detect format** using `recommendation.nodePoolName !== undefined`
- **Map fields appropriately** for backward compatibility

## Key Files and Their Purposes

### Backend Core Files
- `internal/recommender/node_pool_recommender.go` - **PRIMARY recommendation engine**
  - `GenerateRecommendationsFromNodePools()` - Main recommendation function
  - `findOptimalInstanceTypesWithCapacityType()` - Finds best instance types and capacity type
  - `getCandidateInstanceTypes()` - Gets candidate instance types (AWS API or fallback)
  - `EnhanceRecommendationsWithOllama()` - Adds AI explanations

- `internal/recommender/recommender.go` - Legacy recommendation logic
  - `GenerateRecommendationsFromClusterSummary()` - Cluster-wide recommendations (deprecated)
  - `estimateCost()` - Cost calculation with AWS Pricing API integration
  - `estimateInstanceCapacity()` - Estimates CPU/Memory for instance types

- `internal/kubernetes/client.go` - Kubernetes integration
  - `ListNodePools()` - Lists NodePools with actual node data
  - `GetAllNodesWithUsage()` - Gets all nodes with CPU/Memory usage
  - `GetNodeDisruptions()` - Tracks node disruptions (FailedDraining events)

- `internal/awspricing/client.go` - AWS Pricing API
  - `GetProductPrice()` - Gets instance pricing (on-demand or spot)
  - `GetAvailableEC2InstanceTypes()` - Lists available instance types from AWS

- `internal/api/server.go` - API endpoints
  - `getRecommendations()` - Main recommendation endpoint
  - `getRecommendationsFromClusterSummary()` - Enhanced with Ollama
  - `getNodePoolRecommendations()` - NodePool-specific recommendations

### Frontend Core Files
- `frontend/src/App.js` - Main app, manages recommendations state
- `frontend/src/components/NodePoolCard.js` - Displays recommendation cards (supports both formats)
- `frontend/src/components/GlobalClusterSummary.js` - Cluster overview and recommendation trigger

## Important Notes

### Dependencies
- **NO Prometheus dependency** for recommendations (removed)
- **AWS Pricing API** - Primary source for instance pricing
- **Ollama** - Optional, used for AI explanations only
- **Kubernetes API** - Required for node and NodePool data

### Cost Calculation Rules
1. **Spot instances**: 25% of on-demand price (75% discount)
2. **On-demand instances**: Full AWS Pricing API price
3. **Unknown capacity type**: Default to on-demand
4. **Cost validation**: Skip recommendations that increase cost by >10%

### Instance Type Rules
1. **Query AWS API first** for available types (future-proof)
2. **Filter GPU instances** unless workloads require GPU
3. **Respect architecture** (arm64 vs amd64)
4. **Limit combinations** to 1-3 instance types
5. **Sort by cost efficiency** before selecting

### Node Usage Rules
1. **Use requests only** (not limits)
2. **Exclude init containers**
3. **Only scheduled pods** (with nodeName)
4. **Exclude terminating pods**

### Frontend Display Rules
1. **Support both formats** (old and new)
2. **Show NodePool name** prominently
3. **Show current vs recommended** nodes, costs, CPU/Memory
4. **Display AI explanation** when available
5. **Show cost savings** prominently

## Common Tasks

### Adding a New Instance Type Family
1. Add to `estimateInstanceCapacity()` in `recommender.go`
2. Add pricing to `onDemandPrices` map (if hardcoded)
3. Add to `estimateCostFromFamily()` if needed
4. AWS API will automatically discover new types

### Modifying Recommendation Logic
1. **Primary location**: `internal/recommender/node_pool_recommender.go`
2. **Cost calculation**: `internal/recommender/recommender.go` → `estimateCost()`
3. **Instance selection**: `findOptimalInstanceTypesWithCapacityType()`

### Adding a New API Endpoint
1. Add route in `internal/api/server.go` → `setupRoutes()`
2. Add handler function
3. Use `GenerateRecommendationsFromNodePools()` for recommendations
4. Pass `progressCallback` for SSE endpoints

### Updating Frontend Display
1. Check `NodePoolCard.js` for format detection
2. Support both old and new formats
3. Test with both recommendation endpoints

## Testing Considerations

- **Test with 0 nodes**: NodePools with no nodes should be skipped
- **Test capacity types**: Both spot and on-demand scenarios
- **Test cost validation**: Recommendations that increase cost should be skipped
- **Test AWS API fallback**: When AWS API fails, should use hardcoded list
- **Test Ollama integration**: Should gracefully handle Ollama unavailability

## Environment Variables

- `OLLAMA_URL` - Ollama server URL (optional, for AI explanations)
- `OLLAMA_MODEL` - Ollama model name (default: "granite4:latest")
- `KUBECONFIG` - Kubernetes config path
- `KUBE_CONTEXT` - Kubernetes context
- `PORT` - API server port (default: 8080)

## Code Style

- **Go**: Follow standard Go conventions, use `gofmt`
- **React**: Use functional components with hooks
- **Error handling**: Always handle errors, log appropriately
- **Context**: Use `context.Context` for all API calls with timeouts
- **Progress callbacks**: Use for long-running operations (SSE)

## Important Warnings

⚠️ **DO NOT**:
- Use Prometheus for recommendations (removed)
- Hardcode instance types (use AWS API)
- Assume capacity type (always check actual nodes)
- Skip cost validation (prevent cost increases)
- Recommend for NodePools with 0 nodes

✅ **DO**:
- Use actual node data for recommendations
- Try both spot and on-demand for cost optimization
- Query AWS API for instance types
- Provide clear explanations with Ollama
- Support both old and new data formats

## Recent Changes

- **NodePool-based recommendations**: Primary recommendation engine
- **AWS Pricing API integration**: Dynamic instance type discovery
- **Capacity type optimization**: Analyzes spot vs on-demand
- **Ollama explanations**: AI-enhanced recommendation explanations
- **Usage-based calculations**: Uses resource requests only

