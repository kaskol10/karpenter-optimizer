# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Karpenter Log Analyzer**: New feature to analyze Karpenter error logs with AI-powered explanations
  - Paste Karpenter error logs (JSON format) to get detailed analysis
  - Automatic error categorization (Label Errors, Taint Tolerance, NodePool Limits, Resource Constraints)
  - AI-powered explanations using Ollama/LiteLLM (when available)
  - Actionable recommendations for resolving scheduling issues
  - Visual display of error causes with severity indicators
  - Parsed log details showing pod, NodePool, and taint information
  - New API endpoint: `POST /api/v1/karpenter/logs/analyze`
  - New UI tab: "Log Analyzer" in the main navigation
- **On-Prem / No-Karpenter Mode**: The app now gracefully degrades when Karpenter is not installed
  - `HasKarpenter()` discovery check (cached for the process lifetime) on the Kubernetes client
  - `/api/v1/config` now reports `karpenter.detected`
  - NodePool-CRD endpoints return **503** with code `karpenter_not_found` (JSON + SSE) instead of 500
  - Dismissible UI banner, non-error notices in Overview/Agent tabs, and a Disruptions-tab note
  - Cluster cost shows "n/a" (not `$0.00`) when no node has instance-type metadata
- **GPU Allocation Visualization** (allocation-based, core v1 only — no DCGM/Prometheus)
  - `NodeInfo` gains `gpuCapacity`, `gpuAllocated`, `gpuModel`; `PodInfo` gains `gpuRequested`
  - `/api/v1/topology` nodes/pods and `/api/v1/cluster/summary` now expose GPU capacity/allocated/model
  - UI: cluster GPU stat tiles (Total/In use/Free/by model), per-node GPU bars, and GPU badges in the topology & node views (hidden when no GPUs)
  - **GPU memory tracking** (MiB): node total from `nvidia.com/gpu.memory` (per-GPU) x count or `nvidia.com/gpumem` capacity; cluster summary `gpu.memoryTotalMiB`/`memoryAllocatedMiB` (+ per model); memory tiles in the UI
  - **HAMi/KAI scheduler support**: pod `nvidia.com/gpumem` requests are summed; the `hami.io/vgpu-devices-allocated` annotation (e.g. `;GPU-<uuid>,NVIDIA,45000,0:;`) is parsed into `PodInfo.gpuDevices` and its memory is used as the actual allocation (vLLM-ready)
  - **HAMi detection + memory-percent GPU reporting**: a node is flagged `hamiDetected` when `nvidia.com/gpumem` appears (node capacity/allocatable, pod request/limit) or the hami annotation is present. When HAMi is detected, GPU reporting leads with **memory percent in use** and a **GPU pods** count (fractional-GPU pods make count metrics misleading); `NodeInfo` gains `gpuPods` + `hamiDetected`, cluster summary gains `gpu.hamiDetected`/`gpu.podsWithGPU`, and by-model entries gain `pods`

### Fixed
- **Inflated per-node GPU counts**: GPU count now prefers the `nvidia.com/gpu.count` node label over `Status.Capacity["nvidia.com/gpu"]` (which can be inflated by MIG/time-slicing, e.g. reporting 20 for a 2-GPU node). A debug log is emitted when the two disagree.

### Changed
- `kubernetes.Client.clientset` is now typed as `kubernetes.Interface` (was `*kubernetes.Clientset`) to allow fake-client injection in tests.
- **GPU overview under HAMi**: when HAMi is detected, the cluster overview, topology node badges, and node GPU gauges now lead with **GPU memory % in use** plus a **GPU pods** count (e.g. `NVIDIA-H100-NVL: 95% · 532.2/561.5 GiB (11 pods)`) instead of whole-GPU counts, which are meaningless for fractional GPU sharing. Non-HAMi clusters keep the count-based display.

## [0.0.29] - 2025-01-26

### Added
- **Workload Overview**: New comprehensive view for Deployments, StatefulSets, DaemonSets, and Jobs
- **Workload Resource Usage**: CPU and memory usage tracking for workloads based on running pods
- **Jobs Support**: Added Kubernetes Jobs to workload discovery and analysis
- **Minimalist Tab Navigation**: Clean tab-based UI to reduce scrolling and improve navigation
- **Column Visibility Controls**: Customizable table columns in Workload Overview with essential/all presets
- **Workload Summary Statistics**: Aggregated CPU, memory, pods, and replicas totals
- **Performance Optimizations**: Batch pod fetching for workload usage calculation (significant performance improvement)
- **Sticky Table Headers**: Table headers remain visible while scrolling
- **API Endpoint**: New `/api/v1/workloads/all` endpoint to list all workloads across namespaces

### Changed
- **UI Performance**: Optimized rendering by only showing active tab content
- **Workload Calculation**: Changed from per-workload pod fetching to batch processing (10x+ faster)
- **Table Design**: More compact table layout with better information density
- **Navigation**: Replaced section dropdown with minimalist horizontal tabs
- **Pagination**: Increased default items per page from 20 to 50

### Fixed
- Fixed workload usage calculation performance for large clusters
- Improved pod-to-workload matching accuracy for all workload types

[Unreleased]: https://github.com/kaskol10/karpenter-optimizer/compare/v0.0.29...HEAD
[0.0.29]: https://github.com/kaskol10/karpenter-optimizer/compare/v0.0.28...v0.0.29

## [0.0.1] - 2024-12-02

### Added
- Initial open source release 🎉
- NodePool-based recommendation engine analyzing actual cluster usage
- Real-time node usage visualization with interactive charts
- AWS Pricing API integration for accurate cost calculations
- Ollama AI-powered explanations for recommendations
- Helm chart for Kubernetes deployment
- Docker images for easy deployment (backend and frontend)
- Comprehensive REST API with Swagger/OpenAPI documentation
- Modern React web UI with real-time updates
- CLI tool for command-line usage and CI/CD integration
- Node disruption tracking
- Cluster cost summary with before/after comparisons
- Support for spot and on-demand instance optimization
- Sidecar deployment pattern for frontend and backend
- Dynamic Swagger host detection for ingress compatibility

### Changed
- Improved cost calculation accuracy using AWS Pricing API
- Enhanced recommendation algorithm based on actual node capacity
- Better error handling and logging throughout

### Security
- Added RBAC configurations for Kubernetes access
- Implemented security best practices in Helm chart
- Added security policy documentation
- Security context configurations for containers

[0.0.1]: https://github.com/kaskol10/karpenter-optimizer/releases/tag/v0.0.1

