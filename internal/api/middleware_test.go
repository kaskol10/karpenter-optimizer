package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/karpenter-optimizer/internal/config"
)

func newAuthTestServer(token string) *Server {
	gin.SetMode(gin.TestMode)
	cfg := &config.Config{APIPort: "8080", APIAuthToken: token}
	return NewServer(cfg)
}

func doReq(server *Server, path string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest("GET", path, nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	server.router.ServeHTTP(w, req)
	return w
}

func TestAuthDisabledAllowsAll(t *testing.T) {
	server := newAuthTestServer("")

	// #when — no token set: legacy open behavior.
	w := doReq(server, "/api/v1/config", nil)

	// #then
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 when auth is disabled", w.Code)
	}
}

func TestAuthEnabledRequiresBearer(t *testing.T) {
	server := newAuthTestServer("s3cret-token")

	// #when / #then — missing token → 401
	if w := doReq(server, "/api/v1/config", nil); w.Code != http.StatusUnauthorized {
		t.Fatalf("missing token: status = %d, want 401", w.Code)
	}
	// wrong token → 401
	if w := doReq(server, "/api/v1/config", map[string]string{"Authorization": "Bearer wrong"}); w.Code != http.StatusUnauthorized {
		t.Fatalf("wrong token: status = %d, want 401", w.Code)
	}
	// correct token → 200
	if w := doReq(server, "/api/v1/config", map[string]string{"Authorization": "Bearer s3cret-token"}); w.Code != http.StatusOK {
		t.Fatalf("correct token: status = %d, want 200", w.Code)
	}
	// bare token (no scheme) → 200
	if w := doReq(server, "/api/v1/config", map[string]string{"Authorization": "s3cret-token"}); w.Code != http.StatusOK {
		t.Fatalf("bare token: status = %d, want 200", w.Code)
	}
}

func TestAuthEnabledKeepsHealthOpen(t *testing.T) {
	// Liveness/readiness probes cannot carry an Authorization header, so
	// /health must stay reachable even when auth is enabled.
	server := newAuthTestServer("s3cret-token")

	w := doReq(server, "/api/v1/health", nil)

	if w.Code != http.StatusOK {
		t.Fatalf("health with auth enabled: status = %d, want 200", w.Code)
	}
}
