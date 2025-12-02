# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

[Unreleased]: https://github.com/kaskol10/karpenter-optimizer/compare/v0.0.1...HEAD

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

