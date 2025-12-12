.PHONY: build backend frontend cli run clean test

# Build everything
build: backend cli frontend

# Build backend
backend:
	@echo "Building backend..."
	@go build -o bin/karpenter-optimizer-api ./cmd/api

# Build CLI
cli:
	@echo "Building CLI..."
	@go build -o bin/karpenter-optimizer ./cmd/cli

# Generate Swagger documentation
swagger:
	@echo "Generating Swagger documentation..."
	@export PATH=$$PATH:$$HOME/go/bin && swag init -g cmd/api/main.go -o ./internal/docs/swagger
	@echo "Swagger docs generated in ./internal/docs/swagger"
	@echo "Access Swagger UI at: http://localhost:8080/api/swagger/index.html"

# Build frontend
frontend:
	@echo "Building frontend..."
	@cd frontend && npm install && npm run build

# Run backend
run-backend:
	@echo "Running backend..."
	@go run ./cmd/api

# Run frontend
run-frontend:
	@echo "Running frontend..."
	@cd frontend && npm start

# Run tests
test:
	@echo "Running tests..."
	@go test -v ./...

# Run tests with coverage
test-coverage:
	@echo "Running tests with coverage..."
	@go test -cover ./...
	@go test -coverprofile=coverage.out ./...
	@go tool cover -html=coverage.out -o coverage.html
	@echo "Coverage report generated: coverage.html"

# Clean build artifacts
clean:
	@echo "Cleaning..."
	@rm -rf bin/
	@rm -rf frontend/build/
	@rm -rf frontend/node_modules/

# Install dependencies
deps:
	@echo "Installing Go dependencies..."
	@go mod download
	@go mod tidy
	@echo "Installing frontend dependencies..."
	@cd frontend && npm install

# Format code
fmt:
	@echo "Formatting Go code..."
	@go fmt ./...
	@echo "Formatting frontend code..."
	@cd frontend && npm run format || true

# Lint code
lint:
	@echo "Linting Go code..."
	@golangci-lint run || echo "Install golangci-lint for linting"
	@echo "Linting frontend code..."
	@cd frontend && npm run lint || true

