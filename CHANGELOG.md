# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Fleet Power Estimation**: The cluster summary now includes an estimated power draw (`power: {watts, coveragePct, nodeCount, coveredNodes}`) computed from a static wattage table keyed by EC2 instance family (GPU, general, compute, memory, storage families). The Cluster Overview shows an "Est. Power" tile (e.g. `~1.24 kW`, `4/4 nodes covered`) — clearly labeled as an estimate; nodes with unknown families are excluded from the total and from the coverage percentage.
- **LLM Serving Health**: A new "Serving" tab and `GET /api/v1/serving` endpoint detect in-cluster LLM serving pods (vLLM/sglang, matched by image or command) and probe each pod's `/v1/models` and `/metrics` (with a `/server_info` fallback for sglang) to surface inference health: model, KV cache % (`kv_cache_usage_perc`, with the deprecated `gpu_cache_usage_perc` as fallback), running/waiting requests, TTFT mean + p95, preemptions, and token throughput (derived from counter diffs between samples). Unreachable pods render as graceful offline cards (never an error). Results are cached 15s server-side to bound probe load. Note: requires the app to be able to reach pod IPs (in-cluster or pod-network reachability).
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
- **Topology GPU requests section**: each GPU node in the Topology view now shows a dedicated "GPU requests" proportional bar below the CPU/Memory bar — memory-based (GiB vs node GPU memory) when node GPU memory is known (HAMi), count-based otherwise — with the top GPU pods listed under it (hidden on non-GPU nodes)
- **Topology per-GPU device placement (HAMi)**: when HAMi is detected on a multi-GPU node and pods carry the `hami.io/vgpu-devices-allocated` annotation, the topology GPU section renders **one lane per physical GPU** (`GPU 0`, `GPU 1`, ... plus an `Unassigned` lane for GPU pods without placement), each segment sized by the pod's memory on that device (MiB, with the device UUID in the tooltip). `/api/v1/topology` pods now expose `gpuDevices` (index/uuid/memory per device), and the pod list gets per-device badges (`GPU 0 · 44.9 GiB`)
- **Cluster trends (sparkDash-style)**: a background sampler (default every 60s) records cluster CPU/memory/GPU-memory/cost into an in-memory history store (default 6h retention, `HISTORY_INTERVAL_SECS` / `HISTORY_WINDOW_HOURS` env vars). New endpoint `GET /api/v1/history?window=1h|6h|24h`; the Cluster Overview shows a Trends row with CPU %, Memory %, GPU memory %, and estimated-cost sparklines (1h/6h/24h toggle). The Topology node header gains an "age" badge from the node's creation timestamp.
- **Serving model-usage ranking**: the Serving view now shows which models are the most used. A "Model usage (throughput)" ranked bar chart above the pod grid orders servers by `tok/s` with an active-load (running+waiting) indicator, and a sort control reorders the pod cards by Throughput / Active load / Name (online servers always first).
- **Serving E2E latency & request rate**: the vLLM/sglang probe now also parses `e2e_request_latency_seconds` (mean + p95 — whole-request latency, not just first token) and `num_requests_total` (→ `requestsPerSec`, a rate across samples, the truest "most used" measure). Both are gated on presence (hidden on older vLLM versions that don't emit them) and show on the pod cards; the sort control gains a "Requests/s" option.
- **Serving metric explanations**: the Serving view now explains its own numbers for users unfamiliar with LLM serving. Every card metric label (KV cache, Running, Waiting, Preempt, TTFT, E2E, Throughput, Load) has a hover tooltip with a one-line plain-English definition, and a default-collapsed "What do these metrics mean?" accordion at the top of the view covers each metric with what it measures and what to do when it looks wrong (e.g. sustained Waiting > 0 → overloaded, rising preemptions → memory pressure).
- **Serving per-server status verdict**: each online serving card now carries a one-glance status badge — **OK / Busy / Slow / Under pressure** — computed from all the card's metrics, with the specific reasons in a hover tooltip. Objective signals use absolute thresholds (preemptions or KV cache ≥ 85% → Under pressure; waiting requests → Busy); "Slow" is peer-relative (p95 E2E > 2x the fastest server running the *same* model, plus a 1s floor) since absolute latency thresholds are workload-dependent, with a loose TTFT fallback when no same-model peer exists.
- **Serving status: what it means and how to fix it**: the status badge tooltip now explains, in plain English, what each state means and lists concrete remediation steps (Under pressure → add GPU capacity / more KV cache via `--gpu-memory-utilization` or lower `--max-num-seqs`; Busy → add replicas / raise concurrency; Slow → check node placement & GPU contention, reschedule the pod). The "What do these metrics mean?" accordion documents the same guidance per state.
- **Serving placement**: each serving card now shows where the model runs — node name (click-to-copy), the node's EC2 instance type, and GPU model/count badge (e.g. `NVIDIA-H100 x8`). `GET /api/v1/serving` pods gain `node`, `nodeInstanceType`, `gpuModel`, `gpuCapacity` (enriched server-side from node labels, so the "check placement" fix hint is now actionable).
- **Serving historical traceability**: each serving card now shows per-metric trends (TTFT p95, E2E p95, KV cache %, throughput, requests/s) as sparklines over a selectable window (1h/6h/24h) plus a "last issue seen" marker — so you can see how a model behaved at a specific time, not just now. A background sampler (same 60s interval as the cluster trends) probes serving pods into a new in-memory per-pod ring buffer (`internal/servinghistory`, same retention as `HISTORY_WINDOW_HOURS`). New endpoint `GET /api/v1/serving/history?window=6h` returns per-pod `points` + `lastIssue` (last time the pod was offline / had queued requests / preemptions / KV cache ≥ 85%). History is in-memory only — it resets on app restart and fills from the first sample after launch.

### Fixed
- **Disruptions backend N+1**: `GetNodeDisruptions` no longer lists PDBs or `GET`s a pod per disrupted node. Pods for all target nodes are fetched in a single paginated list (grouped by node in memory) and PDBs are listed once cluster-wide; PDB selectors are parsed once. `EventCount` now reflects the real number of FailedDraining events per node (was hardcoded to 1), deleted-node entries group all of a node's events into one entry, and `NodeDisruptionInfo` gains `capacityType` (from the `karpenter.sh/capacity-type` label).
- **Inflated per-node GPU counts**: GPU count now prefers the `nvidia.com/gpu.count` node label over `Status.Capacity["nvidia.com/gpu"]` (which can be inflated by MIG/time-slicing, e.g. reporting 20 for a 2-GPU node). A debug log is emitted when the two disagree.
- **Topology per-GPU lanes merged distinct cards**: the per-device GPU lanes and pod device badges are now keyed by the HAMi device **UUID** (short UUID labels, full UUID in tooltips) because the allocated **index** in `hami.io/vgpu-devices-allocated` can be wrong (two pods on different physical cards both reported index 0).

### Changed
- `kubernetes.Client.clientset` is now typed as `kubernetes.Interface` (was `*kubernetes.Clientset`) to allow fake-client injection in tests.
- **GPU overview under HAMi**: when HAMi is detected, the cluster overview, topology node badges, and node GPU gauges now lead with **GPU memory % in use** plus a **GPU pods** count (e.g. `NVIDIA-H100-NVL: 95% · 532.2/561.5 GiB (11 pods)`) instead of whole-GPU counts, which are meaningless for fractional GPU sharing. Non-HAMi clusters keep the count-based display.
- **Topology GPU free segments show the amount**: the "free" segment in the per-GPU lanes and the aggregate GPU bar now reads `free · {GiB}` (total minus used) instead of just `free`.
- **Topology pod names are click-to-copy**: clicking a pod name (in the CPU/Memory bar labels, the per-GPU lane segments, and the pod lists) copies its full `namespace/name` to the clipboard, for pasting into the CLI.

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

