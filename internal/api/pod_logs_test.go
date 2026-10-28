package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/karpenter-optimizer/internal/config"
	"github.com/karpenter-optimizer/internal/kubernetes"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

func TestListPodsMissingK8sClient(t *testing.T) {
	gin.SetMode(gin.TestMode)
	// A nonexistent kubeconfig path forces NewServer to come up without a
	// k8s client (and without the background samplers).
	cfg := &config.Config{APIPort: "8080", KubeconfigPath: "/nonexistent/kubeconfig-test"}
	server := NewServer(cfg)
	if server.k8sClient != nil {
		t.Fatal("expected no k8s client with a bad kubeconfig path")
	}

	req := httptest.NewRequest("GET", "/api/v1/pods", nil)
	w := httptest.NewRecorder()
	server.router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusServiceUnavailable, w.Code)
}

func TestGetPodLogsRequiresParams(t *testing.T) {
	server := setupTestServer()
	server.k8sClient = testPodClientForAPI(t)

	req := httptest.NewRequest("GET", "/api/v1/pods/logs?pod=web-1", nil)
	w := httptest.NewRecorder()
	server.router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Contains(t, w.Body.String(), "namespace and pod")
}

func TestGetPodLogsValidation400(t *testing.T) {
	server := setupTestServer()
	server.k8sClient = testPodClientForAPI(t)

	req := httptest.NewRequest("GET", "/api/v1/pods/logs?namespace=default&pod=web-1&tailLines=-5", nil)
	w := httptest.NewRecorder()
	server.router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
	assert.Contains(t, w.Body.String(), "tailLines")
}

func TestGetPodLogsUnknownPod404(t *testing.T) {
	server := setupTestServer()
	server.k8sClient = testPodClientForAPI(t)

	req := httptest.NewRequest("GET", "/api/v1/pods/logs?namespace=default&pod=ghost", nil)
	w := httptest.NewRecorder()
	server.router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusNotFound, w.Code)
	assert.Contains(t, w.Body.String(), "not found")
}

func TestListPodsWithClient(t *testing.T) {
	server := setupTestServer()
	server.k8sClient = testPodClientForAPI(t)

	req := httptest.NewRequest("GET", "/api/v1/pods", nil)
	w := httptest.NewRecorder()
	server.router.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), "web-1")
	assert.Contains(t, w.Body.String(), `"count":1`)
}

func TestAnalyzeLogRejectsEmptyBody(t *testing.T) {
	server := setupTestServer()

	req := httptest.NewRequest("POST", "/api/v1/logs/analyze", strings.NewReader(`{"log":"  "}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	server.router.ServeHTTP(w, req)

	assert.Equal(t, http.StatusBadRequest, w.Code)
}

func TestAnalyzeLogGenericHeuristic(t *testing.T) {
	server := setupTestServer()

	logBody := "2026-10-28T12:00:00Z INFO starting\n" +
		"2026-10-28T12:00:01Z ERROR connection refused: dial tcp 10.0.0.5:5432\n" +
		"2026-10-28T12:00:02Z Back-off restarting failed container app"

	body, _ := json.Marshal(LogAnalysisRequest{Log: logBody})
	req := httptest.NewRequest("POST", "/api/v1/logs/analyze", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	server.router.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code)
	var resp LogAnalysisResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	assert.NotEmpty(t, resp.Summary)
	assert.NotEmpty(t, resp.Explanation)
	assert.NotEmpty(t, resp.Recommendations)
	// No LLM in the test server → no parsedError, but heuristic categories present.
	assert.Nil(t, resp.ParsedError)
	foundNet := false
	for _, c := range resp.ErrorCauses {
		if c.Category == "Network / dependency" {
			foundNet = true
		}
	}
	assert.True(t, foundNet, "expected a network/dependency pattern match, got %+v", resp.ErrorCauses)
}

func TestAnalyzeLogKarpenterJSONRouting(t *testing.T) {
	server := setupTestServer()

	// A Karpenter-style JSON log line must be routed to the Karpenter path
	// (which parses it and returns a parsedError when possible).
	karpLog := `{"level":"ERROR","time":"2026-10-28T12:00:00Z","logger":"provisioner","message":"failed to schedule pod","Pod":{"name":"web-1","namespace":"default"},"NodePool":{"name":"default"},"error":"insufficient cpu"}`
	body, _ := json.Marshal(LogAnalysisRequest{Log: karpLog})
	req := httptest.NewRequest("POST", "/api/v1/logs/analyze", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	server.router.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code)
	var resp LogAnalysisResponse
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	// Karpenter path populates parsedError for a valid Karpenter JSON line.
	assert.NotNil(t, resp.ParsedError)
	assert.Equal(t, "web-1", resp.ParsedError.Pod.Name)
}

func TestIsKarpenterJSONLog(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want bool
	}{
		{"karpenter json", `{"level":"ERROR","message":"boom"}`, true},
		{"json without level", `{"message":"boom"}`, false},
		{"json without message", `{"level":"ERROR"}`, false},
		{"plain text", `level=error msg="boom"`, false},
		{"empty", ``, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, isKarpenterJSONLog(tt.in), "input: %s", tt.in)
		})
	}
}

func TestClassifyGenericLogsDedupesCategories(t *testing.T) {
	logText := "ERROR connection refused: dial tcp\n" +
		"ERROR connection reset by peer\n" +
		"2026-10-28T12:00:01Z Back-off restarting failed container app\n"
	out := classifyGenericLogs(logText)
	seen := map[string]int{}
	for _, m := range out {
		seen[m.Category]++
	}
	// Both connection lines are the same category → deduped to one.
	assert.Equal(t, 1, seen["Network / dependency"])
	assert.Equal(t, 1, seen["Crash loop"])
}

// testPodClientForAPI returns a *kubernetes.Client wired to a fake
// clientset so handler-level validation (400/404) can be exercised without a
// real cluster.
func testPodClientForAPI(t *testing.T) *kubernetes.Client {
	t.Helper()
	cs := fake.NewClientset()
	if _, err := cs.CoreV1().Pods("default").Create(context.Background(), &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Namespace: "default", Name: "web-1"},
		Spec:       corev1.PodSpec{Containers: []corev1.Container{{Name: "app"}}},
	}, metav1.CreateOptions{}); err != nil {
		t.Fatalf("seed pod: %v", err)
	}
	return kubernetes.NewClientWithClientset(cs)
}
