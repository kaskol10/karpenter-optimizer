package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/karpenter-optimizer/internal/config"
)

func setupTestServer() *Server {
	gin.SetMode(gin.TestMode)
	cfg := &config.Config{
		APIPort: "8080",
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

