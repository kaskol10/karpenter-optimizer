package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/karpenter-optimizer/internal/gatewaydash"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// stubProm answers every instant query with one value and counts calls.
type stubProm struct {
	calls atomic.Int32
	err   error
}

func (p *stubProm) Query(_ context.Context, q string, _ time.Time) ([]gatewaydash.Sample, error) {
	p.calls.Add(1)
	if p.err != nil {
		return nil, p.err
	}
	if strings.Contains(q, "litellm_spend_metric") && !strings.Contains(q, "by (") {
		return []gatewaydash.Sample{{Metric: map[string]string{}, Value: 42}}, nil
	}
	return nil, nil
}

func (p *stubProm) QueryRange(context.Context, string, time.Time, time.Time, time.Duration) ([]gatewaydash.Series, error) {
	p.calls.Add(1)
	return nil, p.err
}

func TestGatewayDashboardEndpoint(t *testing.T) {
	server := setupTestServer()
	get := func(url string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		server.router.ServeHTTP(w, httptest.NewRequest("GET", url, nil))
		return w
	}

	server.gatewayProm = nil
	w := get("/api/v1/serving/gateway/dashboard")
	assert.Equal(t, http.StatusServiceUnavailable, w.Code)
	assert.Contains(t, w.Body.String(), "prometheus_not_configured")

	stub := &stubProm{}
	server.gatewayProm = stub
	w = get("/api/v1/serving/gateway/dashboard?team=search&range=7d")
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	var d gatewaydash.Dashboard
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &d))
	assert.Equal(t, "search", d.Team)
	assert.Equal(t, "7d", d.Range)
	require.NotNil(t, d.Summary.Spend)
	assert.Equal(t, 42.0, *d.Summary.Spend)

	// The same filter is served from the cache.
	calls := stub.calls.Load()
	require.Equal(t, http.StatusOK, get("/api/v1/serving/gateway/dashboard?team=search&range=7d").Code)
	assert.Equal(t, calls, stub.calls.Load())

	assert.Equal(t, http.StatusBadRequest, get("/api/v1/serving/gateway/dashboard?range=1y").Code)
	assert.Equal(t, http.StatusBadRequest, get("/api/v1/serving/gateway/dashboard?team="+strings.Repeat("x", 300)).Code)

	// Prometheus failing still answers, with the failed panels named, and
	// is not cached.
	server.gatewayProm = &stubProm{err: errors.New("down")}
	w = get("/api/v1/serving/gateway/dashboard?team=other")
	require.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), `"summary":"down"`)
	_, cached := server.gatewayDash.get(gatewaydash.Filter{Team: "other"}.CacheKey(), time.Now())
	assert.False(t, cached)
}

func TestGatewayDashCacheExpires(t *testing.T) {
	var c gatewayDashCache
	now := time.Now()
	c.put("a", &gatewaydash.Dashboard{Team: "a"}, now)
	_, ok := c.get("a", now.Add(gatewayDashTTL/2))
	assert.True(t, ok)
	_, ok = c.get("a", now.Add(2*gatewayDashTTL))
	assert.False(t, ok)
	c.put("b", &gatewaydash.Dashboard{}, now.Add(2*gatewayDashTTL))
	assert.NotContains(t, c.entries, "a", "stale entries are dropped")
	assert.Nil(t, newGatewayProm("", "tenant"))
	assert.NotNil(t, newGatewayProm("http://prometheus:9090", ""))
	p, ok := newGatewayProm("http://mimir/prometheus", "prod").(*gatewaydash.Prom)
	assert.True(t, ok)
	assert.Equal(t, "prod", p.Tenant)
}
