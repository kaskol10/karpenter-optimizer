// Package llmhealth probes in-cluster LLM serving pods (vLLM/sglang) for
// inference health: KV cache usage, running/waiting requests, TTFT,
// end-to-end latency, preemptions, and token/request throughput. It is
// read-only and graceful — an unreachable pod yields an offline card,
// never an error.
package llmhealth

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// PodHealth is the probed state of a single LLM serving pod.
type PodHealth struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	Backend   string `json:"backend"`
	Image     string `json:"image,omitempty"`
	Online    bool   `json:"online"`
	Model     string `json:"model,omitempty"`
	Error     string `json:"error,omitempty"`

	KVCachePercent *float64 `json:"kvCachePercent,omitempty"` // 0-100, nil when unknown
	Running        int      `json:"running"`
	Waiting        int      `json:"waiting"`
	TTFTSeconds    *float64 `json:"ttftSeconds,omitempty"`    // mean time-to-first-token
	TTFTP95Seconds *float64 `json:"ttftP95Seconds,omitempty"` // p95 from histogram
	E2ESeconds     *float64 `json:"e2eSeconds,omitempty"`     // mean end-to-end request latency
	E2EP95Seconds  *float64 `json:"e2eP95Seconds,omitempty"`  // p95 end-to-end request latency
	Preemptions    int64    `json:"preemptions"`
	TokensPerSec   *float64 `json:"tokensPerSec,omitempty"`   // input+output, from counter diffs
	RequestsPerSec *float64 `json:"requestsPerSec,omitempty"` // from num_requests_total diffs

	// Placement (filled server-side after probing, not from the pod's own metrics).
	Node             string `json:"node,omitempty"`
	NodeInstanceType string `json:"nodeInstanceType,omitempty"`
	GPUModel         string `json:"gpuModel,omitempty"`
	GPUCapacity      int    `json:"gpuCapacity,omitempty"`
}

// Prober holds the last counter samples per pod so rates (tokens/sec) can be
// derived from diffs between successive probes.
type Prober struct {
	mu   sync.Mutex
	last map[string]*rateState
	http *http.Client
}

type rateState struct {
	tokens      float64
	hasTokens   bool
	requests    float64
	hasRequests bool
	ts          time.Time
}

// NewProber returns a Prober with a 5s HTTP timeout.
func NewProber() *Prober {
	return &Prober{
		last: make(map[string]*rateState),
		http: &http.Client{Timeout: 5 * time.Second},
	}
}

func podKey(namespace, name string) string { return namespace + "/" + name }

// Probe fetches a single pod's health by querying its HTTP endpoints.
func (p *Prober) Probe(ctx context.Context, namespace, name, ip string, port int32) PodHealth {
	base := fmt.Sprintf("http://%s:%d", ip, port)
	h := PodHealth{Namespace: namespace, Name: name, Backend: "unknown"}

	models, modelOK := p.getModels(ctx, base)
	metrics, metricsOK := p.getMetrics(ctx, base)

	if !modelOK && !metricsOK {
		// Neither endpoint answered — try sglang's /server_info as a fallback.
		if info, ok := p.getSGLangInfo(ctx, base); ok {
			h.Online = true
			h.Backend = "sglang"
			h.Model = info.Model
			if info.Load != nil {
				h.Running = *info.Load
			}
			return h
		}
		h.Error = "unreachable (no /v1/models, /metrics, or /server_info)"
		return h
	}

	h.Online = true
	if modelOK {
		h.Model = models
	}
	h.Backend = p.detectBackend(base, modelOK, metricsOK)

	if metricsOK {
		p.applyVLLMMetrics(&h, metrics)
	}
	return h
}

func (p *Prober) detectBackend(base string, modelOK, metricsOK bool) string {
	if metricsOK {
		return "vllm"
	}
	if modelOK {
		return "openai-compatible"
	}
	return "sglang"
}

// getModels returns the first model name from GET /v1/models.
func (p *Prober) getModels(ctx context.Context, base string) (string, bool) {
	var body struct {
		Data []struct {
			ID      string `json:"id"`
			OwnedBy string `json:"owned_by"`
		} `json:"data"`
	}
	if err := p.getJSON(ctx, base+"/v1/models", &body); err != nil {
		return "", false
	}
	for _, d := range body.Data {
		if d.ID != "" {
			return d.ID, true
		}
	}
	return "", false
}

// sglangInfo is a subset of GET /server_info.
type sglangInfo struct {
	Model string
	Load  *int
}

func (p *Prober) getSGLangInfo(ctx context.Context, base string) (sglangInfo, bool) {
	var raw struct {
		ModelName      string `json:"model_name"`
		MaxTotalTokens *int   `json:"max_total_num_tokens"`
		NumRunning     *int   `json:"num_running_requests"`
	}
	if err := p.getJSON(ctx, base+"/server_info", &raw); err != nil {
		return sglangInfo{}, false
	}
	info := sglangInfo{Model: raw.ModelName}
	if raw.NumRunning != nil {
		info.Load = raw.NumRunning
	}
	return info, true
}

// getMetrics fetches and parses GET /metrics into samples.
func (p *Prober) getMetrics(ctx context.Context, base string) ([]promSample, bool) {
	var sb strings.Builder
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/metrics", nil)
	if err != nil {
		return nil, false
	}
	resp, err := p.http.Do(req)
	if err != nil {
		return nil, false
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, false
	}
	_, _ = io.Copy(&sb, io.LimitReader(resp.Body, 4<<20))
	return parsePrometheus(sb.String()), true
}

func (p *Prober) getJSON(ctx context.Context, url string, out interface{}) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := p.http.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("status %d", resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// applyVLLMMetrics extracts the known vLLM metrics and updates rates.
func (p *Prober) applyVLLMMetrics(h *PodHealth, samples []promSample) {
	gauges, counters, histograms := splitSamples(samples)

	// KV cache usage: vllm:kv_cache_usage_perc (current) or the deprecated
	// vllm:gpu_cache_usage_perc (pre-0.9.2). Both are 0-1 fractions.
	if v, ok := gaugeValue(gauges, "kv_cache_usage_perc"); ok {
		pct := v * 100
		h.KVCachePercent = &pct
	} else if v, ok := gaugeValue(gauges, "gpu_cache_usage_perc"); ok {
		pct := v * 100
		h.KVCachePercent = &pct
	}
	if v, ok := gaugeValue(gauges, "num_requests_running"); ok {
		h.Running = int(v)
	}
	if v, ok := gaugeValue(gauges, "num_requests_waiting"); ok {
		h.Waiting = int(v)
	}
	if v, ok := counterValue(counters, "num_preemptions_total"); ok {
		h.Preemptions = int64(v)
	}
	if mean, ok := histogramMean(histograms, "time_to_first_token_seconds"); ok {
		h.TTFTSeconds = &mean
		if p95, ok := histogramQuantile(histograms, "time_to_first_token_seconds", 0.95); ok {
			h.TTFTP95Seconds = &p95
		}
	}
	// End-to-end request latency (whole request, not just first token).
	if mean, ok := histogramMean(histograms, "e2e_request_latency_seconds"); ok {
		h.E2ESeconds = &mean
		if p95, ok := histogramQuantile(histograms, "e2e_request_latency_seconds", 0.95); ok {
			h.E2EP95Seconds = &p95
		}
	}
	p.updateRates(h, samples)
}

// updateRates derives tokens/sec and requests/sec from counter diffs between
// successive probes.
func (p *Prober) updateRates(h *PodHealth, samples []promSample) {
	_, counters, _ := splitSamples(samples)
	prompt, hasPrompt := counterValue(counters, "prompt_tokens_total")
	gen, hasGen := counterValue(counters, "generation_tokens_total")
	requests, hasRequests := counterValue(counters, "num_requests_total")
	if !hasPrompt && !hasGen && !hasRequests {
		return
	}
	now := time.Now()
	key := podKey(h.Namespace, h.Name)
	tokens := prompt + gen

	p.mu.Lock()
	defer p.mu.Unlock()
	prev, ok := p.last[key]
	if ok && now.After(prev.ts) {
		dt := now.Sub(prev.ts).Seconds()
		if dt > 0 {
			if (hasPrompt || hasGen) && prev.hasTokens {
				rate := (tokens - prev.tokens) / dt
				if rate < 0 {
					rate = 0 // counter reset
				}
				h.TokensPerSec = &rate
			}
			if hasRequests && prev.hasRequests {
				rate := (requests - prev.requests) / dt
				if rate < 0 {
					rate = 0 // counter reset
				}
				h.RequestsPerSec = &rate
			}
		}
	}
	p.last[key] = &rateState{tokens: tokens, hasTokens: hasPrompt || hasGen, requests: requests, hasRequests: hasRequests, ts: now}
}

// --- Prometheus text parsing ---

type promSample struct {
	name   string
	labels map[string]string
	value  float64
}

// label re extracts the metric name up to the first { or whitespace.
var nameRe = regexp.MustCompile(`^([a-zA-Z_:][a-zA-Z0-9_:]*)`)

func parsePrometheus(text string) []promSample {
	var out []promSample
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		var name, rest string
		if i := strings.IndexAny(line, "{ "); i >= 0 {
			name = strings.TrimSpace(line[:i])
			rest = line[i:]
		} else {
			m := nameRe.FindString(line)
			if m == "" {
				continue
			}
			name = m
			rest = line[len(m):]
		}
		labels, value := parseLineBody(rest)
		out = append(out, promSample{name: normalizeName(name), labels: labels, value: value})
	}
	return out
}

// parseLineBody splits "{labels} value" or " value".
func parseLineBody(s string) (map[string]string, float64) {
	labels := map[string]string{}
	if strings.HasPrefix(s, "{") {
		end := strings.Index(s, "}")
		if end < 0 {
			return labels, 0
		}
		for _, kv := range strings.Split(s[1:end], ",") {
			if eq := strings.Index(kv, "="); eq >= 0 {
				k := strings.TrimSpace(kv[:eq])
				v := strings.Trim(strings.TrimSpace(kv[eq+1:]), `"`)
				labels[k] = v
			}
		}
		s = strings.TrimSpace(s[end+1:])
	}
	fields := strings.Fields(s)
	if len(fields) == 0 {
		return labels, 0
	}
	v, _ := strconv.ParseFloat(fields[0], 64)
	return labels, v
}

// normalizeName strips a leading "vllm:" prefix so vLLM versions that do and
// do not add the namespace are matched identically.
func normalizeName(name string) string {
	return strings.TrimPrefix(name, "vllm:")
}

type namedValue struct {
	name  string
	value float64
}

type bucket struct {
	le    float64
	count float64
}

type histogram struct {
	buckets []bucket
	sum     float64
	count   float64
}

// splitSamples groups raw samples into plain gauges/counters and histograms.
// Histogram series are split: `_bucket` lines become cumulative buckets, and
// `_sum`/`_count` lines feed the mean.
func splitSamples(samples []promSample) (
	gauges map[string][]namedValue,
	counters map[string][]namedValue,
	histograms map[string]*histogram,
) {
	gauges = map[string][]namedValue{}
	counters = map[string][]namedValue{}
	histograms = map[string]*histogram{}
	for _, s := range samples {
		if base, isBucket := strings.CutSuffix(s.name, "_bucket"); isBucket {
			le, ok := leFromLabels(s.labels)
			if !ok {
				continue
			}
			h := histograms[base]
			if h == nil {
				h = &histogram{}
				histograms[base] = h
			}
			h.buckets = append(h.buckets, bucket{le: le, count: s.value})
			continue
		}
		if base, isAgg := strings.CutSuffix(s.name, "_sum"); isAgg {
			if h := histograms[base]; h != nil {
				h.sum = s.value
			} else {
				histograms[base] = &histogram{sum: s.value}
			}
			continue
		}
		if base, isCount := strings.CutSuffix(s.name, "_count"); isCount {
			if h := histograms[base]; h != nil {
				h.count = s.value
			} else {
				histograms[base] = &histogram{count: s.value}
			}
			continue
		}
		if strings.HasSuffix(s.name, "_total") {
			counters[s.name] = append(counters[s.name], namedValue{s.name, s.value})
		} else {
			gauges[s.name] = append(gauges[s.name], namedValue{s.name, s.value})
		}
	}
	return
}

func gaugeValue(m map[string][]namedValue, name string) (float64, bool) {
	vs, ok := m[name]
	if !ok || len(vs) == 0 {
		return 0, false
	}
	// Sum across label variants (e.g. per engine) for a cluster-wide figure.
	var total float64
	for _, v := range vs {
		total += v.value
	}
	return total, true
}

func counterValue(m map[string][]namedValue, name string) (float64, bool) {
	vs, ok := m[name]
	if !ok || len(vs) == 0 {
		return 0, false
	}
	var total float64
	for _, v := range vs {
		total += v.value
	}
	return total, true
}

func leFromLabels(labels map[string]string) (float64, bool) {
	raw, ok := labels["le"]
	if !ok {
		return 0, false
	}
	if raw == "+Inf" {
		return 1e308, true
	}
	v, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

func histogramMean(histograms map[string]*histogram, name string) (float64, bool) {
	h, ok := histograms[name]
	if !ok || h == nil || h.count <= 0 {
		return 0, false
	}
	return h.sum / h.count, true
}

// histogramQuantile estimates a quantile from cumulative histogram buckets via
// linear interpolation between the bracketing boundaries.
func histogramQuantile(histograms map[string]*histogram, name string, q float64) (float64, bool) {
	h, ok := histograms[name]
	if !ok || h == nil || len(h.buckets) == 0 {
		return 0, false
	}
	bs := append([]bucket(nil), h.buckets...)
	sort.Slice(bs, func(i, j int) bool { return bs[i].le < bs[j].le })
	total := bs[len(bs)-1].count
	if total <= 0 {
		return 0, false
	}
	target := q * total
	for i, b := range bs {
		if b.count >= target {
			prevLe := 0.0
			prevCount := 0.0
			if i > 0 {
				prevLe = bs[i-1].le
				prevCount = bs[i-1].count
			}
			if b.count <= prevCount {
				return b.le, true
			}
			frac := (target - prevCount) / (b.count - prevCount)
			if frac < 0 {
				frac = 0
			}
			if frac > 1 {
				frac = 1
			}
			return prevLe + frac*(b.le-prevLe), true
		}
	}
	return bs[len(bs)-1].le, true
}
