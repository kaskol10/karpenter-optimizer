package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	k8serrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"

	"github.com/karpenter-optimizer/internal/gatewaydash"
	"github.com/karpenter-optimizer/internal/kubernetes"
)

const routingConfigYAML = `
model_list:
- model_name: acme/small
  litellm_params: {model: hosted_vllm/Qwen/Small, api_base: "https://vllm.acme.example/v1", api_key: sk-SECRET}
- model_name: together/small
  litellm_params: {model: openai/Qwen/Small, api_base: "https://api.together.xyz/v1/"}
router_settings:
  num_retries: 0
  fallbacks:
  - acme/small: [together/small]
`

// fallbackProm answers the two fallback queries.
type fallbackProm struct {
	calls int
	err   error
}

func (p *fallbackProm) Query(_ context.Context, q string, _ time.Time) ([]gatewaydash.Sample, error) {
	p.calls++
	if p.err != nil {
		return nil, p.err
	}
	if strings.Contains(q, "successful_fallbacks") {
		return []gatewaydash.Sample{{Metric: map[string]string{"requested_model": "acme/small", "fallback_model": "together/small",
			"exception_class": "Hosted_vllm.InternalServerError", "exception_status": "500"}, Value: 12}}, nil
	}
	if strings.Contains(q, "litellm_proxy_total_requests_metric") {
		return []gatewaydash.Sample{{Metric: map[string]string{"requested_model": "acme/small"}, Value: 240}}, nil
	}
	return nil, nil
}

func (p *fallbackProm) QueryRange(context.Context, string, time.Time, time.Time, time.Duration) ([]gatewaydash.Series, error) {
	return nil, nil
}

func TestGatewayRoutingEndpoint(t *testing.T) {
	server := setupTestServer()
	get := func(url string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		server.router.ServeHTTP(w, httptest.NewRequest("GET", url, nil))
		return w
	}
	const path = "/api/v1/serving/gateway/routing"

	w := get(path)
	assert.Equal(t, http.StatusServiceUnavailable, w.Code)
	assert.Contains(t, w.Body.String(), "litellm_config_not_configured")

	cm := &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Namespace: "llm", Name: "litellm-config"},
		Data: map[string]string{"config.yaml": routingConfigYAML, "broken.yaml": "model_list: {nope"}}
	cs := fake.NewClientset(cm)
	server.k8sClient = kubernetes.NewClientWithClientset(cs)
	server.config.LiteLLMConfigMapNamespace, server.config.LiteLLMConfigMapName, server.config.LiteLLMConfigMapKey = "llm", "litellm-config", "config.yaml"

	// Without Prometheus: the config alone.
	w = get(path)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	assert.NotContains(t, w.Body.String(), "SECRET")
	var out GatewayRouting
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &out))
	assert.Equal(t, GatewayRoutingSource{Namespace: "llm", ConfigMap: "litellm-config", Key: "config.yaml"}, out.Source)
	require.Len(t, out.Config.Groups, 2)
	require.Len(t, out.Config.Fallbacks, 1)
	assert.Equal(t, []string{"together/small"}, out.Config.Fallbacks[0].To)
	assert.Nil(t, out.Observed)

	// With Prometheus: the fallbacks taken, cached per range.
	prom := &fallbackProm{}
	server.gatewayProm = prom
	w = get(path + "?range=24h")
	require.Equal(t, http.StatusOK, w.Code)
	out = GatewayRouting{}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &out))
	require.NotNil(t, out.Observed)
	assert.Equal(t, "24h", out.Observed.Range)
	require.Len(t, out.Observed.Fallbacks, 1)
	assert.Equal(t, 12.0, out.Observed.Fallbacks[0].Succeeded)
	assert.Equal(t, "Hosted_vllm.InternalServerError", out.Observed.Fallbacks[0].Reasons[0].Reason)
	get(path + "?range=24h")
	assert.Equal(t, 240.0, out.Observed.Requests["acme/small"])
	assert.Equal(t, 3, prom.calls, "the second answer comes from the cache")
	get(path)
	assert.Equal(t, 6, prom.calls, "another range is queried")

	assert.Equal(t, http.StatusBadRequest, get(path+"?range=1y").Code)

	// Prometheus down: the config still answers.
	server.gatewayRouting = gatewayRoutingCache{}
	prom.err = errors.New("prometheus is down")
	w = get(path)
	require.Equal(t, http.StatusOK, w.Code)
	out = GatewayRouting{}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &out))
	assert.Nil(t, out.Observed)
	assert.Equal(t, "prometheus is down", out.ObservedError)
	assert.NotNil(t, out.Config)

	// What the operator has to fix, by status.
	fresh := func() { server.gatewayRouting = gatewayRoutingCache{} }
	fresh()
	server.config.LiteLLMConfigMapKey = "missing.yaml"
	w = get(path)
	assert.Equal(t, http.StatusNotFound, w.Code)
	assert.Contains(t, w.Body.String(), "has no key missing.yaml")

	fresh()
	server.config.LiteLLMConfigMapKey = "broken.yaml"
	w = get(path)
	assert.Equal(t, http.StatusUnprocessableEntity, w.Code)
	assert.Contains(t, w.Body.String(), "litellm_config_invalid")

	fresh()
	server.config.LiteLLMConfigMapKey, server.config.LiteLLMConfigMapName = "config.yaml", "other"
	w = get(path)
	assert.Equal(t, http.StatusNotFound, w.Code)
	assert.Contains(t, w.Body.String(), "ConfigMap llm/other does not exist")

	fail := func(err error) {
		cs.PrependReactor("get", "configmaps", func(k8stesting.Action) (bool, runtime.Object, error) { return true, nil, err })
	}
	fail(k8serrors.NewForbidden(schema.GroupResource{Resource: "configmaps"}, "other", errors.New("rbac")))
	w = get(path)
	assert.Equal(t, http.StatusForbidden, w.Code)
	assert.Contains(t, w.Body.String(), "litellm_config_forbidden")

	fail(errors.New("api server away"))
	w = get(path)
	assert.Equal(t, http.StatusInternalServerError, w.Code)
	assert.Contains(t, w.Body.String(), "api server away")
}
