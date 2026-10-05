package llmhealth

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// splitHostPort parses a URL like "http://127.0.0.1:51234" into host and port.
func splitHostPort(t *testing.T, rawURL string) (string, int32, bool) {
	t.Helper()
	u := strings.TrimPrefix(rawURL, "http://")
	host, portStr, err := net.SplitHostPort(u)
	if err != nil {
		return "", 0, false
	}
	port, err := strconv.ParseInt(portStr, 10, 32)
	if err != nil {
		return "", 0, false
	}
	return host, int32(port), true
}

const vllmMetricsFixture = `# HELP vllm:num_requests_running Number of running requests.
# TYPE vllm:num_requests_running gauge
vllm:num_requests_running{model_name="qwen3-30b"} 3
# HELP vllm:num_requests_waiting Number of waiting requests.
# TYPE vllm:num_requests_waiting gauge
vllm:num_requests_waiting{model_name="qwen3-30b"} 1
# HELP vllm:kv_cache_usage_perc KV cache usage.
# TYPE vllm:kv_cache_usage_perc gauge
vllm:kv_cache_usage_perc{model_name="qwen3-30b"} 0.42
# HELP vllm:num_preemptions_total Total number of preemption events.
# TYPE vllm:num_preemptions_total counter
vllm:num_preemptions_total{model_name="qwen3-30b"} 7
# HELP vllm:prompt_tokens_total Total number of prompt tokens.
# TYPE vllm:prompt_tokens_total counter
vllm:prompt_tokens_total{model_name="qwen3-30b"} 1000
# HELP vllm:generation_tokens_total Total number of generated tokens.
# TYPE vllm:generation_tokens_total counter
vllm:generation_tokens_total{model_name="qwen3-30b"} 500
# HELP vllm:num_requests_total Total number of requests.
# TYPE vllm:num_requests_total counter
vllm:num_requests_total{model_name="qwen3-30b"} 120
# HELP vllm:time_to_first_token_seconds Time to first token.
# TYPE vllm:time_to_first_token_seconds histogram
vllm:time_to_first_token_seconds_bucket{le="0.1"} 40
vllm:time_to_first_token_seconds_bucket{le="0.5"} 55
vllm:time_to_first_token_seconds_bucket{le="1.0"} 58
vllm:time_to_first_token_seconds_bucket{le="5.0"} 60
vllm:time_to_first_token_seconds_bucket{le="+Inf"} 60
vllm:time_to_first_token_seconds_sum 18.0
vllm:time_to_first_token_seconds_count 60
# HELP vllm:e2e_request_latency_seconds End-to-end request latency.
# TYPE vllm:e2e_request_latency_seconds histogram
vllm:e2e_request_latency_seconds_bucket{le="1.0"} 50
vllm:e2e_request_latency_seconds_bucket{le="5.0"} 58
vllm:e2e_request_latency_seconds_bucket{le="10.0"} 60
vllm:e2e_request_latency_seconds_bucket{le="+Inf"} 60
vllm:e2e_request_latency_seconds_sum 150.0
vllm:e2e_request_latency_seconds_count 60
`

func TestParsePrometheusFixture(t *testing.T) {
	t.Parallel()

	gauges, counters, histograms := splitSamples(parsePrometheus(vllmMetricsFixture))

	if got, ok := gaugeValue(gauges, "num_requests_running"); !ok || got != 3 {
		t.Errorf("num_requests_running = %v (ok=%v), want 3", got, ok)
	}
	if got, ok := gaugeValue(gauges, "num_requests_waiting"); !ok || got != 1 {
		t.Errorf("num_requests_waiting = %v (ok=%v), want 1", got, ok)
	}
	if got, ok := gaugeValue(gauges, "kv_cache_usage_perc"); !ok || got != 0.42 {
		t.Errorf("kv_cache_usage_perc = %v (ok=%v), want 0.42", got, ok)
	}
	if got, ok := counterValue(counters, "num_preemptions_total"); !ok || got != 7 {
		t.Errorf("num_preemptions_total = %v (ok=%v), want 7", got, ok)
	}
	if got, ok := counterValue(counters, "prompt_tokens_total"); !ok || got != 1000 {
		t.Errorf("prompt_tokens_total = %v (ok=%v), want 1000", got, ok)
	}
	if got, ok := counterValue(counters, "num_requests_total"); !ok || got != 120 {
		t.Errorf("num_requests_total = %v (ok=%v), want 120", got, ok)
	}
	// TTFT mean = sum/count = 18/60 = 0.3
	if mean, ok := histogramMean(histograms, "time_to_first_token_seconds"); !ok {
		t.Error("time_to_first_token_seconds: expected histogram, got none")
	} else if mean < 0.29 || mean > 0.31 {
		t.Errorf("TTFT mean = %v, want ~0.3", mean)
	}
	// TTFT p95: target = 0.95*60 = 57 -> falls in the le=0.5 bucket (55) ...
	// 57 > 55 so it lands in le=1.0 (58): interpolate between 0.5 and 1.0.
	if p95, ok := histogramQuantile(histograms, "time_to_first_token_seconds", 0.95); !ok {
		t.Error("TTFT p95: expected quantile, got none")
	} else if p95 <= 0.5 || p95 >= 1.0 {
		t.Errorf("TTFT p95 = %v, want within (0.5, 1.0)", p95)
	}
	// E2E latency mean = 150/60 = 2.5
	if mean, ok := histogramMean(histograms, "e2e_request_latency_seconds"); !ok {
		t.Error("e2e_request_latency_seconds: expected histogram, got none")
	} else if mean < 2.49 || mean > 2.51 {
		t.Errorf("E2E mean = %v, want ~2.5", mean)
	}
	// E2E p95: target = 57 -> lands in le=5.0 (58), interpolate 1.0..5.0
	if p95, ok := histogramQuantile(histograms, "e2e_request_latency_seconds", 0.95); !ok {
		t.Error("E2E p95: expected quantile, got none")
	} else if p95 <= 1.0 || p95 >= 5.0 {
		t.Errorf("E2E p95 = %v, want within (1.0, 5.0)", p95)
	}
}

// TestProbeAgainstFakeServer exercises Probe end-to-end against an
// httptest server that speaks /v1/models and /metrics.
func TestProbeAgainstFakeServer(t *testing.T) {
	t.Parallel()

	mux := http.NewServeMux()
	mux.HandleFunc("/v1/models", func(w http.ResponseWriter, r *http.Request) {
		_, _ = fmt.Fprint(w, `{"data":[{"id":"qwen3-30b-a3b","owned_by":"vllm"}]}`)
	})
	mux.HandleFunc("/metrics", func(w http.ResponseWriter, r *http.Request) {
		_, _ = fmt.Fprint(w, vllmMetricsFixture)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	// httptest server listens on 127.0.0.1:PORT.
	host, port, ok := splitHostPort(t, srv.URL)
	if !ok {
		t.Fatal("could not parse test server URL")
	}

	p := NewProber()
	h := p.Probe(context.Background(), "gen-ai", "vllm-0", host, port)

	if !h.Online {
		t.Fatalf("expected online probe, got online=false error=%q", h.Error)
	}
	if h.Model != "qwen3-30b-a3b" {
		t.Errorf("model = %q, want qwen3-30b-a3b", h.Model)
	}
	if h.Backend != "vllm" {
		t.Errorf("backend = %q, want vllm", h.Backend)
	}
	if h.Running != 3 || h.Waiting != 1 {
		t.Errorf("running/waiting = %d/%d, want 3/1", h.Running, h.Waiting)
	}
	if h.Preemptions != 7 {
		t.Errorf("preemptions = %d, want 7", h.Preemptions)
	}
	if h.KVCachePercent == nil || *h.KVCachePercent < 41 || *h.KVCachePercent > 43 {
		t.Errorf("kvCachePercent = %v, want ~42", h.KVCachePercent)
	}
	if h.TTFTSeconds == nil || *h.TTFTSeconds < 0.29 || *h.TTFTSeconds > 0.31 {
		t.Errorf("ttftSeconds = %v, want ~0.3", h.TTFTSeconds)
	}
	if h.E2ESeconds == nil || *h.E2ESeconds < 2.49 || *h.E2ESeconds > 2.51 {
		t.Errorf("e2eSeconds = %v, want ~2.5", h.E2ESeconds)
	}
	if h.E2EP95Seconds == nil {
		t.Error("e2eP95Seconds = nil, want a value")
	}
	// First probe has no prior sample: rates must be nil, not fake.
	if h.TokensPerSec != nil || h.RequestsPerSec != nil {
		t.Errorf("first probe rates = %v/%v, want nil", h.TokensPerSec, h.RequestsPerSec)
	}
}

// TestProbeRatesAcrossProbes verifies tokens/sec and requests/sec are derived
// from counter diffs between two probes of the same pod.
func TestProbeRatesAcrossProbes(t *testing.T) {
	t.Parallel()

	var requests, tokens float64
	var mu sync.Mutex
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/models", func(w http.ResponseWriter, r *http.Request) {
		_, _ = fmt.Fprint(w, `{"data":[{"id":"m","owned_by":"vllm"}]}`)
	})
	mux.HandleFunc("/metrics", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		_, _ = fmt.Fprintf(w, "vllm:prompt_tokens_total 1000\nvllm:generation_tokens_total %v\nvllm:num_requests_total %v\n", tokens, requests)
		mu.Unlock()
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	host, port, ok := splitHostPort(t, srv.URL)
	if !ok {
		t.Fatal("could not parse test server URL")
	}

	p := NewProber()
	_ = p.Probe(context.Background(), "ns", "pod", host, port)

	// Advance the counters by a known delta.
	mu.Lock()
	tokens += 500
	requests += 10
	mu.Unlock()

	time.Sleep(100 * time.Millisecond)
	h := p.Probe(context.Background(), "ns", "pod", host, port)

	if !h.Online {
		t.Fatalf("expected online probe, got online=false error=%q", h.Error)
	}
	if h.TokensPerSec == nil {
		t.Fatal("tokensPerSec = nil after second probe")
	}
	// ~500 tokens over ~0.1s => ~5000 tok/s (loose bounds: timing jitter).
	if *h.TokensPerSec < 1000 || *h.TokensPerSec > 20000 {
		t.Errorf("tokensPerSec = %v, want ~5000", *h.TokensPerSec)
	}
	if h.RequestsPerSec == nil {
		t.Fatal("requestsPerSec = nil after second probe")
	}
	// ~10 requests over ~0.1s => ~100 req/s.
	if *h.RequestsPerSec < 20 || *h.RequestsPerSec > 500 {
		t.Errorf("requestsPerSec = %v, want ~100", *h.RequestsPerSec)
	}
}

// TestProbeOffline verifies graceful degradation when nothing answers.
func TestProbeOffline(t *testing.T) {
	t.Parallel()

	p := NewProber()
	// 127.0.0.1:1 is virtually guaranteed to refuse connections.
	h := p.Probe(context.Background(), "ns", "pod", "127.0.0.1", 1)
	if h.Online {
		t.Error("expected offline probe for a closed port")
	}
	if h.Error == "" {
		t.Error("expected an error message for an offline pod")
	}
}
