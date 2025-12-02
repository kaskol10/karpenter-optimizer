# Testing Strategy

## Overview

This document outlines the testing strategy for Karpenter Optimizer. Currently, the project has testing infrastructure configured but no test files yet. This document serves as a guide for implementing tests.

## Testing Philosophy

- **Unit Tests**: Test individual functions and methods in isolation
- **Integration Tests**: Test component interactions (API + Kubernetes client, etc.)
- **E2E Tests**: Test complete workflows (optional, for critical paths)
- **Coverage Goal**: Aim for 70%+ code coverage on critical paths

## Current Status

### Backend (Go)
- ✅ CI workflow configured for tests
- ✅ Test command in Makefile
- ✅ Coverage reporting configured (Codecov)
- ❌ No test files exist yet

### Frontend (React)
- ✅ Testing libraries installed (`@testing-library/react`, `jest`)
- ✅ Test script configured
- ✅ CI workflow configured
- ❌ No test files exist yet

## Testing Structure

### Backend Testing

#### Unit Tests
Location: `internal/<package>/<package>_test.go`

**Packages to Test:**
1. **`internal/config`** - Configuration loading
2. **`internal/awspricing`** - AWS Pricing API client (with mocks)
3. **`internal/kubernetes`** - Kubernetes client (with fake client)
4. **`internal/recommender`** - Recommendation logic (core business logic)
5. **`internal/ollama`** - Ollama client (with mocks)
6. **`internal/api`** - HTTP handlers (with gin test context)

#### Integration Tests
Location: `internal/<package>/<package>_integration_test.go`
- Use build tags: `//go:build integration`
- Require Kubernetes cluster access
- Test real API interactions

#### Test Utilities
Location: `internal/testutil/` (to be created)
- Mock Kubernetes clients
- Mock AWS Pricing clients
- Mock Ollama clients
- Test fixtures and helpers

### Frontend Testing

#### Component Tests
Location: `frontend/src/components/__tests__/`

**Components to Test:**
1. **`NodePoolCard`** - Display logic, format detection
2. **`GlobalClusterSummary`** - State management, API calls
3. **`NodeUsageView`** - Chart rendering, data formatting
4. **`WorkloadSelector`** - Form handling, validation

#### API Mocking
- Use `axios-mock-adapter` or `msw` (Mock Service Worker)
- Mock API responses for different scenarios

## Testing Tools

### Backend
- **Testing Framework**: `testing` (standard library)
- **Assertions**: `testify/assert` (recommended)
- **Mocks**: `testify/mock` or `gomock`
- **HTTP Testing**: `gin` test utilities
- **Kubernetes Testing**: `client-go/testing` (fake clients)

### Frontend
- **Testing Framework**: Jest (via react-scripts)
- **Component Testing**: `@testing-library/react`
- **User Interaction**: `@testing-library/user-event`
- **API Mocking**: `axios-mock-adapter` or `msw`

## Example Test Structure

### Backend Example

```go
// internal/recommender/recommender_test.go
package recommender

import (
    "testing"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/mock"
)

func TestEstimateCost(t *testing.T) {
    tests := []struct {
        name          string
        instanceTypes []string
        capacityType  string
        nodeCount     int
        expectedCost  float64
    }{
        {
            name:          "on-demand single node",
            instanceTypes:  []string{"m5.large"},
            capacityType:   "on-demand",
            nodeCount:      1,
            expectedCost:   0.096, // Example
        },
        {
            name:          "spot single node",
            instanceTypes:  []string{"m5.large"},
            capacityType:   "spot",
            nodeCount:      1,
            expectedCost:   0.024, // 25% of on-demand
        },
    }

    for _, tt := range tests {
        t.Run(tt.name, func(t *testing.T) {
            // Test implementation
        })
    }
}
```

### Frontend Example

```javascript
// frontend/src/components/__tests__/NodePoolCard.test.js
import { render, screen } from '@testing-library/react';
import NodePoolCard from '../NodePoolCard';

describe('NodePoolCard', () => {
  it('renders recommendation card with cost savings', () => {
    const recommendation = {
      nodePoolName: 'test-pool',
      currentCost: 100,
      recommendedCost: 75,
      costSavings: 25,
      costSavingsPercent: 25,
    };

    render(<NodePoolCard recommendation={recommendation} />);
    
    expect(screen.getByText('test-pool')).toBeInTheDocument();
    expect(screen.getByText('$25.00')).toBeInTheDocument();
    expect(screen.getByText('25%')).toBeInTheDocument();
  });
});
```

## Test Coverage Goals

### Critical Paths (100% coverage)
- Cost calculation logic
- Instance type selection algorithm
- NodePool recommendation generation
- Error handling in API endpoints

### Important Paths (80%+ coverage)
- Kubernetes client operations
- AWS Pricing API integration
- Configuration loading
- Frontend state management

### Nice to Have (60%+ coverage)
- UI components
- Utility functions
- CLI commands

## Running Tests

### Backend
```bash
# Run all tests
make test

# Run with coverage
go test -cover ./...

# Run specific package
go test ./internal/recommender/...

# Run with race detector
go test -race ./...

# Run integration tests
go test -tags=integration ./...
```

### Frontend
```bash
cd frontend

# Run tests
npm test

# Run with coverage
npm test -- --coverage

# Run in watch mode
npm test -- --watch
```

## CI/CD Integration

Tests run automatically on:
- Every push to `main` or `develop`
- Every pull request
- Coverage is uploaded to Codecov

## Mocking Strategy

### Kubernetes Client
- Use `client-go/testing` fake clients
- Create test fixtures for common scenarios
- Mock API responses for different cluster states

### AWS Pricing API
- Use interface-based design for easy mocking
- Create mock implementations for testing
- Test fallback behavior when API is unavailable

### Ollama Client
- Mock HTTP responses
- Test error handling and retries
- Test with/without Ollama available

## Test Data

### Fixtures
Location: `testdata/` or `internal/testutil/fixtures/`
- Sample NodePool configurations
- Sample node data
- Sample workload data
- Expected recommendation outputs

## Best Practices

1. **Test Naming**: Use descriptive test names that explain what is being tested
2. **Table-Driven Tests**: Use table-driven tests for multiple scenarios
3. **Test Isolation**: Each test should be independent
4. **Mock External Dependencies**: Don't make real API calls in unit tests
5. **Test Error Cases**: Test both success and error paths
6. **Keep Tests Fast**: Unit tests should run quickly
7. **Test Documentation**: Add comments for complex test scenarios

## Next Steps

1. ✅ Create testing strategy document (this file)
2. ⬜ Add `testify` dependency for assertions
3. ⬜ Create test utilities package (`internal/testutil`)
4. ⬜ Write unit tests for `internal/config`
5. ⬜ Write unit tests for `internal/recommender` (core logic)
6. ⬜ Write unit tests for `internal/api` handlers
7. ⬜ Write frontend component tests
8. ⬜ Set up integration test environment
9. ⬜ Add test coverage badges to README

## Resources

- [Go Testing Best Practices](https://golang.org/doc/effective_go#testing)
- [Testify Documentation](https://github.com/stretchr/testify)
- [React Testing Library](https://testing-library.com/react)
- [Kubernetes Fake Client](https://pkg.go.dev/k8s.io/client-go/kubernetes/fake)

