package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/karpenter-optimizer/internal/alerts"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAlertsStatus(t *testing.T) {
	server := setupTestServer()

	get := func() map[string]any {
		w := httptest.NewRecorder()
		server.router.ServeHTTP(w, httptest.NewRequest("GET", "/api/v1/alerts/status", nil))
		require.Equal(t, http.StatusOK, w.Code)
		var body map[string]any
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
		return body
	}

	server.alertsManager = nil
	body := get()
	assert.Equal(t, false, body["enabled"])
	assert.Equal(t, []any{}, body["firing"])

	server.alertsManager = alerts.NewManager(filepath.Join(t.TempDir(), "alerts.json"))
	body = get()
	assert.Equal(t, false, body["enabled"], "default config is off")
	assert.Equal(t, []any{}, body["firing"])
}
