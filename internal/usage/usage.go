// Package usage reads what pods and GPUs actually use, for display next to
// what they request (the Topology tab's hatched "requested but unused"
// capacity and its Usage lens).
//
// Two optional, read-only sources, used for display only (recommendations
// keep their no-Prometheus rule):
//   - Prometheus (PROMETHEUS_URL): p95 over the last 24h per pod from cAdvisor
//     (container_cpu_usage_seconds_total, container_memory_working_set_bytes),
//     plus current GPU framebuffer use per card from the DCGM exporter
//     (DCGM_FI_DEV_FB_USED). A p95 over a day is what rightsizing needs.
//   - metrics-server (metrics.k8s.io): live CPU and memory per pod.
//
// The Collector tries them in order and caches the first that answers.
package usage

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// PodUsage is one pod's CPU and memory use.
type PodUsage struct {
	CPUCores  float64 `json:"cpuCores"`
	MemoryGiB float64 `json:"memoryGiB"`
}

// Snapshot is the usage of every pod (keyed "namespace/name") and GPU card
// (keyed by UUID, MiB in use) at one moment.
type Snapshot struct {
	Source    string              `json:"source"` // "prometheus" or "metrics-server"
	Window    string              `json:"window"` // "p95 over 24h" or "live"
	Pods      map[string]PodUsage `json:"-"`
	GPUs      map[string]float64  `json:"-"`
	FetchedAt time.Time           `json:"fetchedAt"`
}

// Provider fetches a Snapshot.
type Provider interface {
	Name() string
	Fetch(ctx context.Context) (*Snapshot, error)
}

// --- Prometheus ---------------------------------------------------------

// Queries the Prometheus provider runs. CPU and memory are the p95 of a 5m
// sampled series over 24h, summed over a pod's containers (container="" and
// "POD" are the pod-level and pause-container series, which double count).
const (
	promCPUQuery = `quantile_over_time(0.95, (sum by (namespace, pod) (rate(container_cpu_usage_seconds_total{container!="",container!="POD"}[5m])))[24h:5m])`
	promMemQuery = `quantile_over_time(0.95, (sum by (namespace, pod) (container_memory_working_set_bytes{container!="",container!="POD"}))[24h:5m])`
	promGPUQuery = `max by (UUID) (DCGM_FI_DEV_FB_USED)`
)

// Prometheus reads usage from a Prometheus HTTP API.
type Prometheus struct {
	URL    string
	Client *http.Client
}

// NewPrometheus returns a provider for the Prometheus at baseURL.
func NewPrometheus(baseURL string) *Prometheus {
	return &Prometheus{URL: strings.TrimRight(baseURL, "/"), Client: &http.Client{Timeout: 20 * time.Second}}
}

func (p *Prometheus) Name() string { return "prometheus" }

// Fetch runs the CPU and memory queries (both required) and the DCGM query
// (optional: clusters without the exporter simply have no GPU usage).
func (p *Prometheus) Fetch(ctx context.Context) (*Snapshot, error) {
	cpu, err := p.query(ctx, promCPUQuery)
	if err != nil {
		return nil, err
	}
	mem, err := p.query(ctx, promMemQuery)
	if err != nil {
		return nil, err
	}
	snap := &Snapshot{Source: "prometheus", Window: "p95 over 24h", Pods: map[string]PodUsage{}, GPUs: map[string]float64{}, FetchedAt: time.Now()}
	for _, s := range cpu {
		if key := podKeyFromLabels(s.Metric); key != "" {
			u := snap.Pods[key]
			u.CPUCores = s.Value
			snap.Pods[key] = u
		}
	}
	for _, s := range mem {
		if key := podKeyFromLabels(s.Metric); key != "" {
			u := snap.Pods[key]
			u.MemoryGiB = s.Value / (1 << 30)
			snap.Pods[key] = u
		}
	}
	if gpu, err := p.query(ctx, promGPUQuery); err == nil {
		for _, s := range gpu {
			if uuid := s.Metric["UUID"]; uuid != "" {
				snap.GPUs[uuid] = s.Value
			}
		}
	}
	return snap, nil
}

func podKeyFromLabels(m map[string]string) string {
	if m["namespace"] == "" || m["pod"] == "" {
		return ""
	}
	return m["namespace"] + "/" + m["pod"]
}

type promSample struct {
	Metric map[string]string
	Value  float64
}

// query runs an instant query and returns its vector result.
func (p *Prometheus) query(ctx context.Context, q string) ([]promSample, error) {
	u := p.URL + "/api/v1/query?" + url.Values{"query": {q}}.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	resp, err := p.Client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("prometheus query: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("prometheus query: HTTP %d", resp.StatusCode)
	}
	var body struct {
		Status string `json:"status"`
		Error  string `json:"error"`
		Data   struct {
			ResultType string `json:"resultType"`
			Result     []struct {
				Metric map[string]string `json:"metric"`
				Value  [2]any            `json:"value"`
			} `json:"result"`
		} `json:"data"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<20)).Decode(&body); err != nil {
		return nil, fmt.Errorf("prometheus query: decode: %w", err)
	}
	if body.Status != "success" {
		return nil, fmt.Errorf("prometheus query: %s", body.Error)
	}
	if body.Data.ResultType != "vector" {
		return nil, fmt.Errorf("prometheus query: unexpected result type %q", body.Data.ResultType)
	}
	out := make([]promSample, 0, len(body.Data.Result))
	for _, r := range body.Data.Result {
		s, ok := r.Value[1].(string)
		if !ok {
			continue
		}
		v, err := strconv.ParseFloat(s, 64)
		if err != nil || math.IsNaN(v) {
			continue
		}
		out = append(out, promSample{Metric: r.Metric, Value: v})
	}
	return out, nil
}

// --- metrics-server -----------------------------------------------------

// MetricsServerPath is the metrics.k8s.io pod metrics list for all namespaces.
const MetricsServerPath = "/apis/metrics.k8s.io/v1beta1/pods"

// MetricsServer reads live pod usage from metrics.k8s.io through a raw GET
// (the Kubernetes client's REST client), so no metrics client dependency is
// needed.
type MetricsServer struct {
	Get func(ctx context.Context, absPath string) ([]byte, error)
}

func (m *MetricsServer) Name() string { return "metrics-server" }

// Fetch lists pod metrics and sums each pod's containers.
func (m *MetricsServer) Fetch(ctx context.Context) (*Snapshot, error) {
	raw, err := m.Get(ctx, MetricsServerPath)
	if err != nil {
		return nil, fmt.Errorf("metrics-server: %w", err)
	}
	var list struct {
		Items []struct {
			Metadata struct {
				Name      string `json:"name"`
				Namespace string `json:"namespace"`
			} `json:"metadata"`
			Containers []struct {
				Usage map[string]string `json:"usage"`
			} `json:"containers"`
		} `json:"items"`
	}
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil, fmt.Errorf("metrics-server: decode: %w", err)
	}
	snap := &Snapshot{Source: "metrics-server", Window: "live", Pods: map[string]PodUsage{}, GPUs: map[string]float64{}, FetchedAt: time.Now()}
	for _, item := range list.Items {
		var u PodUsage
		for _, c := range item.Containers {
			if cpu, err := ParseQuantity(c.Usage["cpu"]); err == nil {
				u.CPUCores += cpu
			}
			if mem, err := ParseQuantity(c.Usage["memory"]); err == nil {
				u.MemoryGiB += mem / (1 << 30)
			}
		}
		snap.Pods[item.Metadata.Namespace+"/"+item.Metadata.Name] = u
	}
	return snap, nil
}

// ParseQuantity reads the Kubernetes quantity forms metrics-server returns:
// a plain number, a decimal suffix (n, u, m, k, M, G, T) or a binary suffix
// (Ki, Mi, Gi, Ti). CPU comes back in cores, memory in bytes.
func ParseQuantity(s string) (float64, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, fmt.Errorf("empty quantity")
	}
	suffixes := []struct {
		suffix string
		factor float64
	}{
		{"Ki", 1 << 10}, {"Mi", 1 << 20}, {"Gi", 1 << 30}, {"Ti", 1 << 40},
		{"n", 1e-9}, {"u", 1e-6}, {"m", 1e-3}, {"k", 1e3}, {"M", 1e6}, {"G", 1e9}, {"T", 1e12},
	}
	for _, sf := range suffixes {
		if strings.HasSuffix(s, sf.suffix) {
			v, err := strconv.ParseFloat(strings.TrimSuffix(s, sf.suffix), 64)
			if err != nil {
				return 0, fmt.Errorf("bad quantity %q", s)
			}
			return v * sf.factor, nil
		}
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, fmt.Errorf("bad quantity %q", s)
	}
	return v, nil
}

// --- Collector ----------------------------------------------------------

// Collector asks its providers in order and caches the first answer for TTL,
// so a busy Topology tab does not hammer Prometheus or the API server. With
// no provider answering it caches the miss too, and logs each provider's
// first failure once.
type Collector struct {
	providers []Provider
	ttl       time.Duration

	mu      sync.Mutex
	last    *Snapshot
	at      time.Time
	logged  map[string]bool
	nowFunc func() time.Time
}

// NewCollector returns a Collector over providers (in preference order).
func NewCollector(ttl time.Duration, providers ...Provider) *Collector {
	return &Collector{providers: providers, ttl: ttl, logged: map[string]bool{}, nowFunc: time.Now}
}

// Get returns the cached snapshot, refreshing it when older than the TTL. nil
// means no source is available.
func (c *Collector) Get(ctx context.Context) *Snapshot {
	if c == nil {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.nowFunc()
	if !c.at.IsZero() && now.Sub(c.at) < c.ttl {
		return c.last
	}
	c.at = now
	c.last = nil
	for _, p := range c.providers {
		snap, err := p.Fetch(ctx)
		if err == nil {
			c.last = snap
			return snap
		}
		if !c.logged[p.Name()] {
			log.Printf("usage: %s unavailable: %v (the Usage lens hides without a source)", p.Name(), err)
			c.logged[p.Name()] = true
		}
	}
	return nil
}
