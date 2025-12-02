# Contributing to Karpenter Optimizer

Thank you for your interest in contributing to Karpenter Optimizer! This document provides guidelines and instructions for contributing.

## Code of Conduct

By participating in this project, you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check the issue list as you might find out that you don't need to create one. When you are creating a bug report, please include as many details as possible:

- **Clear title and description**
- **Steps to reproduce** the behavior
- **Expected behavior**
- **Actual behavior**
- **Screenshots** (if applicable)
- **Environment details**:
  - Kubernetes version
  - Karpenter version
  - OS and version
  - Go version (for backend issues)
  - Node.js version (for frontend issues)

### Suggesting Enhancements

Enhancement suggestions are tracked as GitHub issues. When creating an enhancement suggestion, please include:

- **Clear title and description**
- **Use case**: Why is this feature useful?
- **Proposed solution** (if you have one)
- **Alternatives considered**

### Pull Requests

1. **Fork the repository** and create your branch from `main`
2. **Make your changes** following our coding standards
3. **Add tests** for new functionality
4. **Update documentation** as needed
5. **Ensure all tests pass**
6. **Submit the pull request**

#### Pull Request Process

1. Update the README.md with details of changes if needed
2. Update the CHANGELOG.md with your changes
3. The PR will be reviewed by maintainers
4. Address any review feedback
5. Once approved, a maintainer will merge your PR

## Development Setup

### Prerequisites

- Go 1.21 or later
- Node.js 16+ and npm
- Docker and docker-compose (optional)
- Kubernetes cluster with Karpenter (for testing)
- kubectl configured

### Backend Development

```bash
# Clone the repository
git clone https://github.com/kaskol10/karpenter-optimizer.git
cd karpenter-optimizer

# Install dependencies
go mod download

# Run tests
go test ./...

# Run the API server
go run ./cmd/api
```

### Frontend Development

```bash
cd frontend

# Install dependencies
npm install

# Start development server
npm start

# Run tests
npm test

# Build for production
npm run build
```

### Docker Development

```bash
# Build and run with docker-compose
docker-compose up --build

# Or build individually
docker build -t karpenter-optimizer-api .
docker build -t karpenter-optimizer-frontend ./frontend
```

## Coding Standards

### Go Code Style

- Follow [Effective Go](https://go.dev/doc/effective_go) guidelines
- Use `gofmt` to format code
- Use `golint` or `golangci-lint` for linting
- Write meaningful comments for exported functions and types
- Keep functions small and focused
- Handle errors explicitly

### JavaScript/React Code Style

- Follow [Airbnb JavaScript Style Guide](https://github.com/airbnb/javascript)
- Use ESLint for linting
- Use Prettier for formatting
- Write functional components with hooks
- Keep components small and reusable

### Commit Messages

We follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

```
<type>(<scope>): <subject>

<body>

<footer>
```

**Types:**
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

**Examples:**
```
feat(api): add support for multi-region pricing

Add AWS Pricing API integration for fetching prices across multiple regions.

Closes #123
```

```
fix(recommender): correct cost calculation for spot instances

Spot instance pricing was incorrectly calculated. Fixed to use 25% of on-demand price.

Fixes #456
```

## Testing

### Testing Strategy

See [TESTING.md](../TESTING.md) for the complete testing strategy and guidelines.

### Backend Tests

```bash
# Run all tests
make test
# or
go test ./...

# Run tests with coverage
make test-coverage
# or
go test -cover ./...

# Run tests for specific package
go test ./internal/recommender/...

# Run tests with race detector
go test -race ./...
```

**Current Test Coverage:**
- ✅ `internal/config` - Configuration loading tests
- ✅ `internal/api` - API endpoint tests (health, Swagger)
- ✅ `internal/recommender` - Core recommendation logic tests
- ⬜ `internal/kubernetes` - Kubernetes client tests (needs mocks)
- ⬜ `internal/awspricing` - AWS Pricing API tests (needs mocks)
- ⬜ `internal/ollama` - Ollama client tests (needs mocks)

### Frontend Tests

```bash
cd frontend

# Run tests
npm test

# Run tests with coverage
npm test -- --coverage

# Run tests in watch mode
npm test -- --watch
```

**Note:** Frontend tests are configured but test files need to be created.

### Integration Tests

Integration tests require a Kubernetes cluster:

```bash
# Set up test environment
export KUBECONFIG=/path/to/kubeconfig

# Run integration tests
go test -tags=integration ./...
```

**Note:** Integration tests are planned but not yet implemented.

## Documentation

- Update README.md for user-facing changes
- Update API documentation for endpoint changes
- Add code comments for complex logic
- Update CHANGELOG.md for all changes (create it if it doesn't exist)
- Keep inline documentation up to date

## Project Structure

```
.
├── cmd/                    # Application entry points
│   ├── api/               # API server
│   └── cli/               # CLI tool
├── internal/              # Private application code
│   ├── api/               # HTTP handlers
│   ├── awspricing/        # AWS Pricing API client
│   ├── config/           # Configuration
│   ├── kubernetes/        # Kubernetes client
│   ├── ollama/            # Ollama LLM client
│   └── recommender/       # Recommendation engine
├── frontend/              # React frontend
├── charts/                # Helm charts
├── docs/                  # Documentation
├── examples/              # Example files
└── scripts/               # Utility scripts
```

## Questions?

- Open an issue for bug reports or feature requests
- Start a discussion in GitHub Discussions for questions
- Check existing documentation first

## Recognition

Contributors will be:
- Listed in the README.md (if they wish)
- Mentioned in release notes for significant contributions
- Credited in the project's ADOPTERS.md (for organizations)

Thank you for contributing to Karpenter Optimizer! 🎉

