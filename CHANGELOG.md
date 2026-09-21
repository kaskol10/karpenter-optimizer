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
- **Agent history location** is now configurable via the `AGENT_HISTORY_FILE` environment variable (defaults to `/tmp/karpenter-optimizer-history.json`)

### Changed
- **LLM naming**: The recommendation-explanation and agent LLM integration is now named by provider-agnostic "LLM" rather than "Ollama" (`EnhanceRecommendationsWithLLM`, `GetLLMClient`). The `ollama` package name is retained for backward compatibility.
- **Spot pricing**: The spot discount is now a single shared constant (`awspricing.SpotDiscountFactor`, 25% of on-demand) used consistently across the recommender, Kubernetes client, and agent, instead of per-file literals.
- **r8i pricing**: Corrected the hardcoded r8i on-demand prices (r8i.xlarge is $0.2778/hr, not the previous r6i copy).
- **Strategy suggestions**: The cost-optimization agent's `SuggestStrategy` now uses the LLM when available, with the previous rule-based logic as fallback.

### Fixed
- **Overview recommendations**: The Overview tab's "Generate Recommendations" now actually renders the cluster cost summary and NodePool cards (previously the callback was a no-op).
- **Removed production debug logging** from the frontend and backend.

### Removed
- **LLM price fallback**: The recommender no longer asks the LLM to guess EC2 prices when the AWS Pricing API is unavailable; it now falls back to the family-based estimate.
- **Deprecated Prometheus metrics endpoints** (`GET/POST /api/v1/metrics/workload(s)`) and the CLI `metrics` command (Prometheus support was already removed).
- **Dead code**: the duplicate `backend/` directory, unused frontend components (`WorkloadForm`, `WorkloadSelector`, `RecommendationCard`, `ComparisonView`, `ClusterSummary`), the unused `usePricing` hook, and unused deprecated pricing/sort functions.

### Documentation
- Reconciled README, `AGENTS.md`, and `docs/architecture.md` with the actual code (architecture description, Swagger URLs, project tree, default LLM model, and instance-type fallback rules).


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

