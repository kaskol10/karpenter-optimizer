package api

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/karpenter-optimizer/internal/gatewaydash"
)

// newGatewayProm returns the Prometheus client for the team dashboard, or
// nil (an untyped nil interface, so the handler can test it) without a URL.
// tenant is the X-Scope-OrgID for Grafana Mimir ("" = none).
func newGatewayProm(url, tenant string) gatewaydash.Querier {
	if url == "" {
		return nil
	}
	p := gatewaydash.NewProm(url)
	p.Tenant = tenant
	return p
}

// gatewayDashTTL is how long a dashboard answer is reused for the same
// filter: each one is about twenty Prometheus queries.
const gatewayDashTTL = 30 * time.Second

type gatewayDashCache struct {
	mu      sync.Mutex
	entries map[string]gatewayDashEntry
}

type gatewayDashEntry struct {
	at   time.Time
	dash *gatewaydash.Dashboard
}

func (c *gatewayDashCache) get(key string, now time.Time) (*gatewaydash.Dashboard, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[key]
	if !ok || now.Sub(e.at) > gatewayDashTTL {
		return nil, false
	}
	return e.dash, true
}

func (c *gatewayDashCache) put(key string, d *gatewaydash.Dashboard, now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entries == nil {
		c.entries = map[string]gatewayDashEntry{}
	}
	// Drop stale entries so filters people stopped using do not pile up.
	for k, e := range c.entries {
		if now.Sub(e.at) > gatewayDashTTL {
			delete(c.entries, k)
		}
	}
	c.entries[key] = gatewayDashEntry{at: now, dash: d}
}

// getGatewayDashboard godoc
// @Summary      LiteLLM team dashboard
// @Description  Spend, budget, requests, errors, spend and tokens per day, one row per API key and latency per model, from the LiteLLM metrics in Prometheus (PROMETHEUS_URL). Filters are optional; the range is 24h, 7d, 30d or month (default: since the 1st, UTC). Panels that fail or whose metric is not exported are empty and named in `errors`.
// @Tags         serving
// @Produce      json
// @Param        team   query  string  false  "LiteLLM team alias"
// @Param        model  query  string  false  "Requested model alias"
// @Param        key    query  string  false  "API key alias"
// @Param        range  query  string  false  "24h | 7d | 30d | month"
// @Success      200  {object}  gatewaydash.Dashboard
// @Failure      400  {object}  map[string]interface{}
// @Failure      503  {object}  map[string]interface{}  "PROMETHEUS_URL not set"
// @Router       /serving/gateway/dashboard [get]
func (s *Server) getGatewayDashboard(c *gin.Context) {
	if s.gatewayProm == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"code":  "prometheus_not_configured",
			"error": "the team dashboard reads LiteLLM metrics from Prometheus: set PROMETHEUS_URL (chart value usage.prometheusUrl)",
		})
		return
	}
	f := gatewaydash.Filter{Team: c.Query("team"), Model: c.Query("model"), Key: c.Query("key"), Range: c.Query("range")}
	if err := f.Validate(); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	now := time.Now()
	if d, ok := s.gatewayDash.get(f.CacheKey(), now); ok {
		c.JSON(http.StatusOK, d)
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 30*time.Second)
	defer cancel()
	d, err := gatewaydash.Build(ctx, s.gatewayProm, f, now)
	if err != nil {
		code := http.StatusInternalServerError
		if errors.Is(err, gatewaydash.ErrBadRange) {
			code = http.StatusBadRequest
		}
		c.JSON(code, gin.H{"error": err.Error()})
		return
	}
	// Only cache answers where Prometheus answered at least something.
	if len(d.Errors) == 0 {
		s.gatewayDash.put(f.CacheKey(), d, now)
	}
	c.JSON(http.StatusOK, d)
}
