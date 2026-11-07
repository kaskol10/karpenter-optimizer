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
	if mean, ok := histogramMean(histogramVariants(histograms, "time_to_first_token_seconds")); !ok {
		t.Error("time_to_first_token_seconds: expected histogram, got none")
	} else if mean < 0.29 || mean > 0.31 {
		t.Errorf("TTFT mean = %v, want ~0.3", mean)
	}
	// TTFT p95: target = 0.95*60 = 57 -> falls in the le=0.5 bucket (55) ...
	// 57 > 55 so it lands in le=1.0 (58): interpolate between 0.5 and 1.0.
	if p95, ok := histogramQuantile(histogramVariants(histograms, "time_to_first_token_seconds"), 0.95); !ok {
		t.Error("TTFT p95: expected quantile, got none")
	} else if p95 <= 0.5 || p95 >= 1.0 {
		t.Errorf("TTFT p95 = %v, want within (0.5, 1.0)", p95)
	}
	// E2E latency mean = 150/60 = 2.5
	if mean, ok := histogramMean(histogramVariants(histograms, "e2e_request_latency_seconds")); !ok {
		t.Error("e2e_request_latency_seconds: expected histogram, got none")
	} else if mean < 2.49 || mean > 2.51 {
		t.Errorf("E2E mean = %v, want ~2.5", mean)
	}
	// E2E p95: target = 57 -> lands in le=5.0 (58), interpolate 1.0..5.0
	if p95, ok := histogramQuantile(histogramVariants(histograms, "e2e_request_latency_seconds"), 0.95); !ok {
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
	// Input and output are split: the prompt counter did not move, all the
	// new tokens were generated.
	if h.PromptTokensPerSec == nil || *h.PromptTokensPerSec != 0 {
		t.Errorf("promptTokensPerSec = %v, want 0", h.PromptTokensPerSec)
	}
	if h.GenerationTokensPerSec == nil || *h.GenerationTokensPerSec != *h.TokensPerSec {
		t.Errorf("generationTokensPerSec = %v, want the whole token rate %v", h.GenerationTokensPerSec, *h.TokensPerSec)
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

const multiModelMetricsFixture = `# TYPE litellm_proxy_total_requests_metric counter
litellm_proxy_total_requests_metric{model="gpt-4o",api_key="A"} 100
litellm_proxy_total_requests_metric{model="qwen3-30b",api_key="A"} 40
# TYPE litellm_proxy_failed_requests_metric counter
litellm_proxy_failed_requests_metric{model="qwen3-30b",api_key="A"} 4
# TYPE litellm_request_total_latency_metric histogram
litellm_request_total_latency_metric_bucket{model="gpt-4o",le="1.0"} 60
litellm_request_total_latency_metric_bucket{model="gpt-4o",le="10.0"} 100
litellm_request_total_latency_metric_bucket{model="gpt-4o",le="+Inf"} 100
litellm_request_total_latency_metric_sum{model="gpt-4o"} 900
litellm_request_total_latency_metric_count{model="gpt-4o"} 100
litellm_request_total_latency_metric_bucket{model="qwen3-30b",le="1.0"} 10
litellm_request_total_latency_metric_bucket{model="qwen3-30b",le="10.0"} 40
litellm_request_total_latency_metric_bucket{model="qwen3-30b",le="+Inf"} 40
litellm_request_total_latency_metric_sum{model="qwen3-30b"} 120
litellm_request_total_latency_metric_count{model="qwen3-30b"} 40
`

func TestMetricsFacadeByLabel(t *testing.T) {
	t.Parallel()

	m := ParsePrometheus(multiModelMetricsFixture)

	if models := m.LabelValues("litellm_proxy_total_requests_metric", "model"); len(models) != 2 || models[0] != "gpt-4o" || models[1] != "qwen3-30b" {
		t.Errorf("LabelValues(model) = %v, want [gpt-4o qwen3-30b]", models)
	}
	if got, ok := m.TotalByLabel("litellm_proxy_total_requests_metric", "model", "qwen3-30b"); !ok || got != 40 {
		t.Errorf("total requests qwen3-30b = %v (ok=%v), want 40", got, ok)
	}
	if got, ok := m.TotalByLabel("litellm_proxy_failed_requests_metric", "model", "qwen3-30b"); !ok || got != 4 {
		t.Errorf("failed requests qwen3-30b = %v (ok=%v), want 4", got, ok)
	}
	if got, ok := m.Total("litellm_proxy_total_requests_metric"); !ok || got != 140 {
		t.Errorf("total requests (all) = %v (ok=%v), want 140", got, ok)
	}
	// qwen3-30b p95: target = 0.95*40 = 38 -> le=1.0 has 10, le=10.0 has 40:
	// interpolate 1.0..10.0 at (38-10)/(40-10) => ~9.3
	if p95, ok := m.HistogramQuantileByLabel("litellm_request_total_latency_metric", "model", "qwen3-30b", 0.95); !ok {
		t.Fatal("qwen3-30b latency p95: expected quantile, got none")
	} else if p95 <= 1.0 || p95 >= 10.0 {
		t.Errorf("qwen3-30b latency p95 = %v, want within (1.0, 10.0)", p95)
	}
	if p95, ok := m.HistogramQuantileByLabel("litellm_request_total_latency_metric", "model", "nope", 0.95); ok {
		t.Errorf("unknown model p95: expected none, got %v", p95)
	}
}

func TestLabelPairValues(t *testing.T) {
	t.Parallel()

	const fixture = `# TYPE litellm_total_tokens_metric counter
litellm_total_tokens_metric_total{model="m1",metadata_trace_name="app-a"} 100
litellm_total_tokens_metric_total{model="m1",metadata_trace_name="app-b"} 50
litellm_total_tokens_metric_total{model="m1",metadata_trace_name="app-a"} 25
litellm_total_tokens_metric_total{model="m2",metadata_trace_name="None"} 10
litellm_total_tokens_metric_total{model="m2"} 999
`
	m := ParsePrometheus(fixture)
	pairs := m.LabelPairValues("litellm_total_tokens_metric", "model", "metadata_trace_name")
	if len(pairs) != 3 {
		t.Fatalf("LabelPairValues = %d pairs, want 3: %+v", len(pairs), pairs)
	}
	got := map[[2]string]float64{}
	for _, p := range pairs {
		got[[2]string{p.ValueA, p.ValueB}] = p.Value
	}
	if got[[2]string{"m1", "app-a"}] != 125 {
		t.Errorf("m1/app-a = %v, want 125 (100+25 summed)", got[[2]string{"m1", "app-a"}])
	}
	if got[[2]string{"m1", "app-b"}] != 50 {
		t.Errorf("m1/app-b = %v, want 50", got[[2]string{"m1", "app-b"}])
	}
	// "None" is a real (non-empty) label value, so it is a valid pair.
	if got[[2]string{"m2", "None"}] != 10 {
		t.Errorf("m2/None = %v, want 10", got[[2]string{"m2", "None"}])
	}
	// Series missing metadata_trace_name must not contribute to any pair.
	if _, ok := got[[2]string{"m2", ""}]; ok {
		t.Errorf("series without app label leaked into a pair")
	}
}

func TestRecentIncrease(t *testing.T) {
	t.Parallel()
	now := time.Unix(10_000, 0)
	at := func(minAgo int, v float64) counterSample {
		return counterSample{ts: now.Add(-time.Duration(minAgo) * time.Minute), value: v}
	}

	tests := []struct {
		name    string
		hist    []counterSample
		current float64
		want    float64
		wantOK  bool
	}{
		{name: "no earlier sample: unknown", hist: nil, current: 7, wantOK: false},
		{name: "lifetime count but no new preemptions", hist: []counterSample{at(1, 42)}, current: 42, want: 0, wantOK: true},
		{name: "new preemptions since a recent sample", hist: []counterSample{at(1, 40)}, current: 43, want: 3, wantOK: true},
		{
			name:    "baseline is the newest sample at or before the window start",
			hist:    []counterSample{at(9, 10), at(6, 20), at(3, 25), at(1, 28)},
			current: 30,
			want:    10, // 30 - 20 (the 6-minute-old sample)
			wantOK:  true,
		},
		{
			name:    "history shorter than the window: oldest sample is the baseline",
			hist:    []counterSample{at(2, 5), at(1, 6)},
			current: 9,
			want:    4,
			wantOK:  true,
		},
		{name: "counter reset (server restart) counts from zero", hist: []counterSample{at(1, 50)}, current: 2, want: 2, wantOK: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			got, ok := recentIncrease(tt.hist, now, tt.current, PreemptionWindow)
			if ok != tt.wantOK || (ok && got != tt.want) {
				t.Errorf("recentIncrease = %v, %v; want %v, %v", got, ok, tt.want, tt.wantOK)
			}
		})
	}
}

func TestTrimSamplesKeepsOneBaseline(t *testing.T) {
	t.Parallel()
	now := time.Unix(10_000, 0)
	hist := []counterSample{
		{ts: now.Add(-20 * time.Minute), value: 1},
		{ts: now.Add(-8 * time.Minute), value: 2},
		{ts: now.Add(-2 * time.Minute), value: 3},
	}
	got := trimSamples(hist, now, PreemptionWindow)
	if len(got) != 2 || got[0].value != 2 || got[1].value != 3 {
		t.Errorf("trimSamples kept %+v; want the -8m baseline and the -2m sample", got)
	}
}

// A pod with a large lifetime preemption count but no new preemptions must
// report preemptionsRecent = 0 (not under pressure), and new preemptions
// between probes must show up.
func TestProbePreemptionsRecent(t *testing.T) {
	t.Parallel()

	var preemptions float64 = 120
	var mu sync.Mutex
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/models", func(w http.ResponseWriter, r *http.Request) {
		_, _ = fmt.Fprint(w, `{"data":[{"id":"m","owned_by":"vllm"}]}`)
	})
	mux.HandleFunc("/metrics", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		_, _ = fmt.Fprintf(w, "vllm:num_preemptions_total %v\n", preemptions)
		mu.Unlock()
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	host, port, ok := splitHostPort(t, srv.URL)
	if !ok {
		t.Fatal("could not parse test server URL")
	}

	p := NewProber()
	first := p.Probe(context.Background(), "ns", "pod", host, port)
	if first.Preemptions != 120 || first.PreemptionsRecent != nil {
		t.Fatalf("first probe: preemptions=%d recent=%v; want 120, nil", first.Preemptions, first.PreemptionsRecent)
	}

	second := p.Probe(context.Background(), "ns", "pod", host, port)
	if second.PreemptionsRecent == nil || *second.PreemptionsRecent != 0 {
		t.Fatalf("idle pod: recent=%v; want 0 despite a lifetime count of 120", second.PreemptionsRecent)
	}

	mu.Lock()
	preemptions += 4
	mu.Unlock()
	third := p.Probe(context.Background(), "ns", "pod", host, port)
	if third.PreemptionsRecent == nil || *third.PreemptionsRecent != 4 {
		t.Fatalf("after 4 new preemptions: recent=%v; want 4", third.PreemptionsRecent)
	}
}
