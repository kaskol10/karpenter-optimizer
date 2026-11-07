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

// GPUDevice is a single (possibly fractional) GPU card allocated to a pod,
// sourced from the HAMi/KAI hami.io/vgpu-devices-allocated annotation. Kept
// local to this package (rather than imported from kubernetes) to avoid an
// import cycle; it mirrors kubernetes.GPUDevice.
type GPUDevice struct {
	UUID      string `json:"uuid"`
	Model     string `json:"model"`
	MemoryMiB int    `json:"memoryMiB"`
	Index     int    `json:"index"`
}

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
	Preemptions    int64    `json:"preemptions"`              // lifetime counter since the server started
	// PreemptionsRecent is how many preemptions happened in roughly the last
	// PreemptionWindow (the increase of the lifetime counter). nil until the
	// pod has been probed twice. Use this, not Preemptions, to judge whether
	// a server is under memory pressure now.
	PreemptionsRecent *int64   `json:"preemptionsRecent,omitempty"`
	TokensPerSec      *float64 `json:"tokensPerSec,omitempty"`   // input+output, from counter diffs
	RequestsPerSec    *float64 `json:"requestsPerSec,omitempty"` // from num_requests_total diffs
	// PromptTokensPerSec and GenerationTokensPerSec split TokensPerSec into
	// input and output, which hosted APIs price differently. Each is nil when
	// its counter is missing or on the first sample.
	PromptTokensPerSec     *float64 `json:"promptTokensPerSec,omitempty"`
	GenerationTokensPerSec *float64 `json:"generationTokensPerSec,omitempty"`

	// Placement (filled server-side after probing, not from the pod's own metrics).
	Node             string      `json:"node,omitempty"`         // node name (spec.nodeName)
	NodeHostname     string      `json:"nodeHostname,omitempty"` // kubernetes.io/hostname (falls back to node name)
	NodeInstanceType string      `json:"nodeInstanceType,omitempty"`
	GPUModel         string      `json:"gpuModel,omitempty"`
	GPUCapacity      int         `json:"gpuCapacity,omitempty"`
	GPUDevices       []GPUDevice `json:"gpuDevices,omitempty"`       // physical cards from HAMi annotation
	GPURequested     int         `json:"gpuRequested,omitempty"`     // nvidia.com/gpu the pod asks for (vGPUs under HAMi)
	NodeCapacityType string      `json:"nodeCapacityType,omitempty"` // spot / on-demand, empty when unknown
	NodeGPUMemMiB    float64     `json:"nodeGpuMemMiB,omitempty"`    // node's total GPU memory, 0 when unknown

	// Cost is this replica's share of its node's hourly price. nil when it
	// could not be priced (no instance type, unknown price, or no way to tell
	// how much of the node's GPUs the pod holds). Endpoint only.
	Cost *ReplicaCost `json:"cost"`
	// HostedPrice is what a hosted API charges for the same model, for
	// comparison. nil when the model is not in the hosted catalog or the
	// catalog could not be fetched. Endpoint only.
	HostedPrice *HostedPrice `json:"hostedPrice"`

	// GPUNeighbours lists the physical GPUs this pod shares with other pods,
	// and who those pods are (the usual cause of one replica being slower than
	// its peers). nil means it was not computed (the field is null in JSON);
	// an empty slice means the pod is alone on its GPU(s).
	GPUNeighbours []GPUShare `json:"gpuNeighbours"`
	// GPUNeighboursPrecise is true when neighbours were matched by HAMi device
	// UUID, false when inferred (two GPU pods on a single-GPU node must be
	// time-slicing the same card).
	GPUNeighboursPrecise bool `json:"gpuNeighboursPrecise,omitempty"`
}

// ReplicaCost is an estimate of what one serving replica costs per hour: its
// node's price times the share of the node's GPUs it holds. GPUs dominate
// the price of GPU instances, so CPU and memory are not apportioned.
type ReplicaCost struct {
	CostPerHour      float64 `json:"costPerHour"`
	NodeCostPerHour  float64 `json:"nodeCostPerHour"`
	NodeCapacityType string  `json:"nodeCapacityType"` // capacity type the price assumes (spot / on-demand)
	Share            float64 `json:"share"`            // 0-1 of the node's GPUs
	// ShareBasis says how Share was worked out: "gpu-memory" (HAMi placement
	// memory over the node's GPU memory) or "gpu-count" (GPUs over the node's
	// GPU count).
	ShareBasis  string `json:"shareBasis"`
	Currency    string `json:"currency"`
	PriceSource string `json:"priceSource"` // aws-pricing-api, hardcoded, regional-fallback, family-estimate
}

// HostedPrice is a hosted API's list price for a model, in USD per million
// tokens, split into input (prompt) and output (generation).
type HostedPrice struct {
	Source        string  `json:"source"` // "openrouter"
	Model         string  `json:"model"`  // the hosted model id that matched
	InputPerMTok  float64 `json:"inputPerMTok"`
	OutputPerMTok float64 `json:"outputPerMTok"`
	FetchedAtUnix int64   `json:"fetchedAt"`
}

// GPUShare is one physical GPU a serving pod shares, and the other pods on it.
type GPUShare struct {
	UUID  string         `json:"uuid,omitempty"`
	Index int            `json:"index"`
	Pods  []NeighbourPod `json:"pods"`
}

// NeighbourPod is another pod placed on a shared GPU.
type NeighbourPod struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	MemoryMiB int    `json:"memoryMiB,omitempty"` // its share of that GPU's memory, when known
}

// Prober holds the last counter samples per pod so rates (tokens/sec) can be
// derived from diffs between successive probes.
type Prober struct {
	mu          sync.Mutex
	last        map[string]*rateState
	preemptions map[string][]counterSample // recent preemption counter samples per pod
	http        *http.Client
}

// PreemptionWindow is how far back PodHealth.PreemptionsRecent looks.
const PreemptionWindow = 5 * time.Minute

type counterSample struct {
	ts    time.Time
	value float64
}

type rateState struct {
	tokens      float64
	hasTokens   bool
	prompt      float64
	hasPrompt   bool
	gen         float64
	hasGen      bool
	requests    float64
	hasRequests bool
	ts          time.Time
}

// NewProber returns a Prober with a 5s HTTP timeout.
func NewProber() *Prober {
	return &Prober{
		last:        make(map[string]*rateState),
		preemptions: make(map[string][]counterSample),
		http:        &http.Client{Timeout: 5 * time.Second},
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
		p.updatePreemptions(h, v, time.Now())
	}
	if mean, ok := histogramMean(histogramVariants(histograms, "time_to_first_token_seconds")); ok {
		h.TTFTSeconds = &mean
		if p95, ok := histogramQuantile(histogramVariants(histograms, "time_to_first_token_seconds"), 0.95); ok {
			h.TTFTP95Seconds = &p95
		}
	}
	// End-to-end request latency (whole request, not just first token).
	if mean, ok := histogramMean(histogramVariants(histograms, "e2e_request_latency_seconds")); ok {
		h.E2ESeconds = &mean
		if p95, ok := histogramQuantile(histogramVariants(histograms, "e2e_request_latency_seconds"), 0.95); ok {
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
			if hasPrompt && prev.hasPrompt {
				h.PromptTokensPerSec = counterRate(prompt, prev.prompt, dt)
			}
			if hasGen && prev.hasGen {
				h.GenerationTokensPerSec = counterRate(gen, prev.gen, dt)
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
	p.last[key] = &rateState{
		tokens: tokens, hasTokens: hasPrompt || hasGen,
		prompt: prompt, hasPrompt: hasPrompt,
		gen: gen, hasGen: hasGen,
		requests: requests, hasRequests: hasRequests,
		ts: now,
	}
}

// counterRate is the per-second increase of a counter, 0 after a reset.
func counterRate(now, prev, dt float64) *float64 {
	rate := (now - prev) / dt
	if rate < 0 {
		rate = 0
	}
	return &rate
}

// updatePreemptions records the pod's lifetime preemption counter and sets
// PreemptionsRecent to its increase over the last PreemptionWindow. The window
// is time-based, so it does not depend on how often the pod is probed (the
// endpoint and the history sampler share this prober).
func (p *Prober) updatePreemptions(h *PodHealth, value float64, now time.Time) {
	key := podKey(h.Namespace, h.Name)

	p.mu.Lock()
	defer p.mu.Unlock()
	hist := p.preemptions[key]
	if inc, ok := recentIncrease(hist, now, value, PreemptionWindow); ok {
		n := int64(inc)
		h.PreemptionsRecent = &n
	}
	p.preemptions[key] = trimSamples(append(hist, counterSample{ts: now, value: value}), now, PreemptionWindow)
}

// recentIncrease returns how much a cumulative counter grew over roughly the
// last window: the current value minus the newest earlier sample taken at or
// before now-window (or the oldest sample, when history is shorter than the
// window). ok is false when there is no earlier sample. A counter that went
// down was reset (server restart), so the increase counts from zero.
func recentIncrease(hist []counterSample, now time.Time, current float64, window time.Duration) (float64, bool) {
	if len(hist) == 0 {
		return 0, false
	}
	cutoff := now.Add(-window)
	base := hist[0]
	for _, s := range hist {
		if s.ts.After(cutoff) {
			break
		}
		base = s
	}
	inc := current - base.value
	if inc < 0 {
		inc = current
	}
	return inc, true
}

// trimSamples drops samples that can no longer be a baseline: everything
// older than now-window except the newest such sample.
func trimSamples(hist []counterSample, now time.Time, window time.Duration) []counterSample {
	cutoff := now.Add(-window)
	first := 0
	for i, s := range hist {
		if s.ts.After(cutoff) {
			break
		}
		first = i
	}
	return hist[first:]
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
	name   string
	labels map[string]string
	value  float64
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

// labelKey is a canonical key for a label set (sorted "k=v" pairs, minus the
// histogram-specific "le" label), so all series of one label variant map to
// the same histogram.
func labelKey(labels map[string]string) string {
	keys := make([]string, 0, len(labels))
	for k := range labels {
		if k == "le" {
			continue
		}
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var sb strings.Builder
	for i, k := range keys {
		if i > 0 {
			sb.WriteByte(',')
		}
		sb.WriteString(k)
		sb.WriteByte('=')
		sb.WriteString(labels[k])
	}
	return sb.String()
}

// splitSamples groups raw samples into plain gauges/counters and histograms.
// Histogram series are split: `_bucket` lines become cumulative buckets, and
// `_sum`/`_count` lines feed the mean. One histogram is kept per label
// variant (e.g. per model) so quantiles are computed per series, not on
// merged buckets.
func splitSamples(samples []promSample) (
	gauges map[string][]namedValue,
	counters map[string][]namedValue,
	histograms map[string]map[string]*histogram,
) {
	gauges = map[string][]namedValue{}
	counters = map[string][]namedValue{}
	histograms = map[string]map[string]*histogram{}
	for _, s := range samples {
		if base, isBucket := strings.CutSuffix(s.name, "_bucket"); isBucket {
			le, ok := leFromLabels(s.labels)
			if !ok {
				continue
			}
			byLabel := histograms[base]
			if byLabel == nil {
				byLabel = map[string]*histogram{}
				histograms[base] = byLabel
			}
			lk := labelKey(s.labels)
			h := byLabel[lk]
			if h == nil {
				h = &histogram{}
				byLabel[lk] = h
			}
			h.buckets = append(h.buckets, bucket{le: le, count: s.value})
			continue
		}
		if base, isAgg := strings.CutSuffix(s.name, "_sum"); isAgg {
			byLabel := histograms[base]
			if byLabel == nil {
				byLabel = map[string]*histogram{}
				histograms[base] = byLabel
			}
			lk := labelKey(s.labels)
			h := byLabel[lk]
			if h == nil {
				h = &histogram{}
				byLabel[lk] = h
			}
			h.sum = s.value
			continue
		}
		if base, isCount := strings.CutSuffix(s.name, "_count"); isCount {
			byLabel := histograms[base]
			if byLabel == nil {
				byLabel = map[string]*histogram{}
				histograms[base] = byLabel
			}
			lk := labelKey(s.labels)
			h := byLabel[lk]
			if h == nil {
				h = &histogram{}
				byLabel[lk] = h
			}
			h.count = s.value
			continue
		}
		if strings.HasSuffix(s.name, "_total") {
			counters[s.name] = append(counters[s.name], namedValue(s))
		} else {
			gauges[s.name] = append(gauges[s.name], namedValue(s))
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

// histogramVariants flattens one metric's per-label-variant histograms into a
// slice.
func histogramVariants(byName map[string]map[string]*histogram, name string) []*histogram {
	var out []*histogram
	for _, h := range byName[name] {
		if h != nil {
			out = append(out, h)
		}
	}
	return out
}

// histogramMean returns the weighted mean across all histogram variants
// (total sum / total count), so multi-variant metrics (e.g. per model) are
// combined correctly.
func histogramMean(hs []*histogram) (float64, bool) {
	var sum, count float64
	for _, h := range hs {
		if h == nil || h.count <= 0 {
			continue
		}
		sum += h.sum
		count += h.count
	}
	if count <= 0 {
		return 0, false
	}
	return sum / count, true
}

// histogramQuantile estimates a quantile across all histogram variants: for
// each quantile point it takes the max over variants (conservative for
// latency). Single-variant metrics behave as before.
func histogramQuantile(hs []*histogram, q float64) (float64, bool) {
	var out float64
	found := false
	for _, h := range hs {
		if h == nil || len(h.buckets) == 0 {
			continue
		}
		v, ok := histogramVariantQuantile(h, q)
		if !ok {
			continue
		}
		if !found || v > out {
			out = v
			found = true
		}
	}
	return out, found
}

// histogramVariantQuantile estimates a quantile from one variant's cumulative
// buckets via linear interpolation between the bracketing boundaries.
func histogramVariantQuantile(h *histogram, q float64) (float64, bool) {
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
				if b.le >= 1e100 {
					return prevLe, true
				}
				return b.le, true
			}
			// The +Inf bucket ("le" encoded as 1e308) has no upper boundary to
			// interpolate against: report the previous finite boundary.
			if b.le >= 1e100 {
				return prevLe, true
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
