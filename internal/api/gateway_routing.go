package api

import (
	"context"
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/karpenter-optimizer/internal/gatewaydash"
	"github.com/karpenter-optimizer/internal/kubernetes"
	"github.com/karpenter-optimizer/internal/litellmconfig"
)

// The routing config changes on a deploy, so it is read at most once a
// minute; the fallbacks taken are three Prometheus queries per range.
const (
	gatewayConfigTTL    = time.Minute
	gatewayFallbacksTTL = 30 * time.Second
)

// GatewayRoutingSource is where the routing config was read from.
type GatewayRoutingSource struct {
	Namespace string `json:"namespace"`
	ConfigMap string `json:"configMap"`
	Key       string `json:"key"`
}

// GatewayObservedFallbacks are the fallbacks LiteLLM took over a window.
type GatewayObservedFallbacks struct {
	Range     string                     `json:"range"`
	From      time.Time                  `json:"from"`
	To        time.Time                  `json:"to"`
	Fallbacks []gatewaydash.FallbackStat `json:"fallbacks"`
	// Requests per requested model over the same window, so a fallback
	// count can be read as a share (nil when that query failed).
	Requests map[string]float64 `json:"requests"`
}

// GatewayRouting is what LiteLLM is configured to do (Config) next to what
// it did (Observed, nil without Prometheus or when the query failed, in
// which case ObservedError says why).
type GatewayRouting struct {
	Source        GatewayRoutingSource      `json:"source"`
	FetchedAt     time.Time                 `json:"fetchedAt"`
	Config        *litellmconfig.Config     `json:"config"`
	Observed      *GatewayObservedFallbacks `json:"observed"`
	ObservedError string                    `json:"observedError,omitempty"`
}

type gatewayRoutingCache struct {
	mu        sync.Mutex
	config    *litellmconfig.Config
	configAt  time.Time
	observed  map[string]*GatewayObservedFallbacks // by range
	fallbacks map[string]time.Time
}

func (c *gatewayRoutingCache) cachedConfig(now time.Time) (*litellmconfig.Config, time.Time, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.config == nil || now.Sub(c.configAt) > gatewayConfigTTL {
		return nil, time.Time{}, false
	}
	return c.config, c.configAt, true
}

func (c *gatewayRoutingCache) putConfig(cfg *litellmconfig.Config, now time.Time) {
	c.mu.Lock()
	c.config, c.configAt = cfg, now
	c.mu.Unlock()
}

func (c *gatewayRoutingCache) cachedObserved(rng string, now time.Time) (*GatewayObservedFallbacks, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if at, ok := c.fallbacks[rng]; !ok || now.Sub(at) > gatewayFallbacksTTL {
		return nil, false
	}
	return c.observed[rng], true
}

func (c *gatewayRoutingCache) putObserved(rng string, o *GatewayObservedFallbacks, now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.observed == nil {
		c.observed, c.fallbacks = map[string]*GatewayObservedFallbacks{}, map[string]time.Time{}
	}
	c.observed[rng], c.fallbacks[rng] = o, now
}

// getGatewayRouting godoc
// @Summary      LiteLLM routing and fallbacks
// @Description  The routing part of the LiteLLM proxy config (model groups and their deployments, aliases, fallbacks, retry and cooldown settings, and the issues found in it), read from the ConfigMap named by LITELLM_CONFIGMAP_NAMESPACE / LITELLM_CONFIGMAP_NAME, next to the fallbacks LiteLLM took over the range (from Prometheus, when PROMETHEUS_URL is set). API keys and prices are never returned.
// @Tags         serving
// @Produce      json
// @Param        range  query  string  false  "24h | 7d | 30d | month (default 7d)"
// @Success      200  {object}  GatewayRouting
// @Failure      400  {object}  map[string]interface{}
// @Failure      403  {object}  map[string]interface{}  "no RBAC to read the ConfigMap"
// @Failure      404  {object}  map[string]interface{}  "ConfigMap or key not found"
// @Failure      422  {object}  map[string]interface{}  "the config is not valid YAML"
// @Failure      503  {object}  map[string]interface{}  "LITELLM_CONFIGMAP_* not set"
// @Router       /serving/gateway/routing [get]
func (s *Server) getGatewayRouting(c *gin.Context) {
	src := GatewayRoutingSource{Namespace: s.config.LiteLLMConfigMapNamespace, ConfigMap: s.config.LiteLLMConfigMapName, Key: s.config.LiteLLMConfigMapKey}
	if src.Namespace == "" || src.ConfigMap == "" || s.k8sClient == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"code":  "litellm_config_not_configured",
			"error": "the fallback map reads the LiteLLM config: set LITELLM_CONFIGMAP_NAMESPACE and LITELLM_CONFIGMAP_NAME (chart values litellmConfig.namespace / litellmConfig.configMapName)",
		})
		return
	}
	f := gatewaydash.Filter{Range: c.DefaultQuery("range", "7d")}
	if err := f.Validate(); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 20*time.Second)
	defer cancel()
	now := time.Now()

	cfg, at, ok := s.gatewayRouting.cachedConfig(now)
	if !ok {
		var status int
		var body gin.H
		if cfg, status, body = s.readGatewayConfig(ctx, src); cfg == nil {
			c.JSON(status, body)
			return
		}
		at = now
		s.gatewayRouting.putConfig(cfg, now)
	}

	out := GatewayRouting{Source: src, FetchedAt: at, Config: cfg}
	if s.gatewayProm != nil {
		if o, ok := s.gatewayRouting.cachedObserved(f.Range, now); ok {
			out.Observed = o
		} else if stats, w, err := gatewaydash.Fallbacks(ctx, s.gatewayProm, f, now); err != nil {
			out.ObservedError = err.Error()
		} else {
			// The shares are a nicety: without them the counts still show.
			requests, _ := gatewaydash.RequestsByModel(ctx, s.gatewayProm, f, now)
			out.Observed = &GatewayObservedFallbacks{Range: f.Range, From: w.From, To: w.To, Fallbacks: stats, Requests: requests}
			s.gatewayRouting.putObserved(f.Range, out.Observed, now)
		}
	}
	c.JSON(http.StatusOK, out)
}

// readGatewayConfig reads and parses the config, or returns the status and
// body that say what the operator has to fix.
func (s *Server) readGatewayConfig(ctx context.Context, src GatewayRoutingSource) (*litellmconfig.Config, int, gin.H) {
	where := "ConfigMap " + src.Namespace + "/" + src.ConfigMap
	data, err := s.k8sClient.GetConfigMapData(ctx, src.Namespace, src.ConfigMap)
	switch {
	case kubernetes.IsForbidden(err):
		return nil, http.StatusForbidden, gin.H{"code": "litellm_config_forbidden",
			"error": "not allowed to read " + where + ": the service account needs get on that ConfigMap (the chart adds the Role when litellmConfig is set)"}
	case kubernetes.IsNotFound(err):
		return nil, http.StatusNotFound, gin.H{"code": "litellm_config_not_found", "error": where + " does not exist"}
	case err != nil:
		return nil, http.StatusInternalServerError, gin.H{"error": "reading " + where + ": " + err.Error()}
	}
	body, ok := data[src.Key]
	if !ok {
		return nil, http.StatusNotFound, gin.H{"code": "litellm_config_not_found",
			"error": where + " has no key " + src.Key + " (set LITELLM_CONFIGMAP_KEY)"}
	}
	cfg, err := litellmconfig.Parse([]byte(body))
	if err != nil {
		return nil, http.StatusUnprocessableEntity, gin.H{"code": "litellm_config_invalid", "error": where + ": " + err.Error()}
	}
	return cfg, 0, nil
}
