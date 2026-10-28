package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/karpenter-optimizer/internal/config"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func setupTestServer() *Server {
	gin.SetMode(gin.TestMode)
	cfg := &config.Config{
		APIPort: "8080",
		// A nonexistent kubeconfig keeps the server hermetic: no real cluster
		// connection, and no background samplers started by NewServer.
		// Tests that need a k8s client assign server.k8sClient directly.
		KubeconfigPath: "/nonexistent/kubeconfig-test",
	}
	return NewServer(cfg)
}

func TestHealthCheck(t *testing.T) {
	server := setupTestServer()

	req := httptest.NewRequest("GET", "/api/v1/health", nil)
	w := httptest.NewRecorder()

	server.router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), "healthy")
	assert.Contains(t, w.Body.String(), "karpenter-optimizer")
}

func TestGetConfigIncludesAWSRegionAndCurrency(t *testing.T) {
	server := setupTestServer()
	server.config.AWSRegion = "cn-north-1"

	req := httptest.NewRequest("GET", "/api/v1/config", nil)
	w := httptest.NewRecorder()
	server.router.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), `"region":"cn-north-1"`)
	assert.Contains(t, w.Body.String(), `"currency":"CNY"`)
}

func TestSwaggerEndpoint(t *testing.T) {
	server := setupTestServer()

	req := httptest.NewRequest("GET", "/api/swagger/index.html", nil)
	w := httptest.NewRecorder()

	server.router.ServeHTTP(w, req)

	// Swagger UI should be accessible
	assert.Equal(t, http.StatusOK, w.Code)
}

func TestSwaggerDocJSON(t *testing.T) {
	server := setupTestServer()

	req := httptest.NewRequest("GET", "/api/swagger/doc.json", nil)
	w := httptest.NewRecorder()

	server.router.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Header().Get("Content-Type"), "application/json")
	assert.Contains(t, w.Body.String(), "swagger")
}
