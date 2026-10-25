package api

import (
	"os"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/karpenter-optimizer/internal/kubernetes"
	"github.com/karpenter-optimizer/internal/litellm"
	"github.com/karpenter-optimizer/internal/llmhealth"
	"github.com/karpenter-optimizer/internal/power"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// metricsEnabled reports whether the Prometheus /metrics exporter is on
// (METRICS_ENABLED=true|1). Off by default — when off the route is not
// registered and /metrics 404s, mirroring sparkDash.
func metricsEnabled() bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv("METRICS_ENABLED")))
	return v == "true" || v == "1"
}

// nodePoolSnap is the per-NodePool aggregate refreshed by the cluster sampler.
type nodePoolSnap struct {
	nodes       int
	costPerHour float64
}

// servingPodSnap is the latest sample for one serving pod.
type servingPodSnap struct {
	namespace, name, model string
	online                 float64
	kvCachePct             float64
	ttftP95, e2eP95        float64
	tokensPerSec           float64
	requestsPerSec         float64
}

// gatewaySnap is the latest LiteLLM gateway probe (nil when no gateway).
type gatewaySnap struct {
	pods            int
	online          float64
	inFlight        int
	queued          int
	rejected        int64
	errorRatePct    float64
	requestsPerSec  float64
	spendTotal      float64
	appSpend        map[string]float64 // app alias -> cumulative spend
	appSpendPresent bool
}

// disruptionItemSnap is one disrupted node's cost contribution.
type disruptionItemSnap struct {
	nodePool    string
	costPerHour float64
}

// metricsSnapState is the immutable snapshot the collector reads. Each
// sampler publishes a fresh copy (section-updated from the previous one) so
// Collect never races a writer.
type metricsSnapState struct {
	nodes, pods int

	cpuUsed, cpuAllocatable float64
	memUsed, memAllocatable float64
	costPerHour             float64
	watts                   float64

	nodePools map[string]*nodePoolSnap

	serving map[string]*servingPodSnap

	gateway *gatewaySnap

	disruptionActive, disruptionBlocked int
	disruptionCostPerHour               float64
	disruptionItems                     map[string]*disruptionItemSnap

	updatedAt time.Time
}

func newMetricsSnapState() *metricsSnapState {
	return &metricsSnapState{
		nodePools:       map[string]*nodePoolSnap{},
		serving:         map[string]*servingPodSnap{},
		disruptionItems: map[string]*disruptionItemSnap{},
	}
}

func cloneMetricsSnapState(s *metricsSnapState) *metricsSnapState {
	out := newMetricsSnapState()
	*out = *s
	out.nodePools = make(map[string]*nodePoolSnap, len(s.nodePools))
	for k, v := range s.nodePools {
		c := *v
		out.nodePools[k] = &c
	}
	out.serving = make(map[string]*servingPodSnap, len(s.serving))
	for k, v := range s.serving {
		c := *v
		out.serving[k] = &c
	}
	out.disruptionItems = make(map[string]*disruptionItemSnap, len(s.disruptionItems))
	for k, v := range s.disruptionItems {
		c := *v
		out.disruptionItems[k] = &c
	}
	if s.gateway != nil {
		g := *s.gateway
		if s.gateway.appSpendPresent {
			g.appSpend = make(map[string]float64, len(s.gateway.appSpend))
			for k, v := range s.gateway.appSpend {
				g.appSpend[k] = v
			}
		}
		out.gateway = &g
	}
	return out
}

// promMetrics is a prometheus.Collector that serves the snapshot. One
// collector (instead of many metricvecs) keeps the snapshot immutable and
// avoids the collect-time cardinality juggling of vector registries.
type promMetrics struct {
	server *Server

	descUp          *prometheus.Desc
	descK8s         *prometheus.Desc
	descKarpenter   *prometheus.Desc
	descNodes       *prometheus.Desc
	descPods        *prometheus.Desc
	descCPUUsed     *prometheus.Desc
	descCPUAlloc    *prometheus.Desc
	descMemUsed     *prometheus.Desc
	descMemAlloc    *prometheus.Desc
	descCostPerHour *prometheus.Desc
	descWatts       *prometheus.Desc
	descPoolNodes   *prometheus.Desc
	descPoolCost    *prometheus.Desc
	descSrvOnline   *prometheus.Desc
	descSrvKV       *prometheus.Desc
	descSrvTTFT     *prometheus.Desc
	descSrvE2E      *prometheus.Desc
	descSrvTok      *prometheus.Desc
	descSrvReq      *prometheus.Desc
	descGwPods      *prometheus.Desc
	descGwOnline    *prometheus.Desc
	descGwInFlight  *prometheus.Desc
	descGwQueued    *prometheus.Desc
	descGwRejected  *prometheus.Desc
	descGwErrRate   *prometheus.Desc
	descGwReq       *prometheus.Desc
	descGwSpend     *prometheus.Desc
	descGwAppSpend  *prometheus.Desc
	descDActive     *prometheus.Desc
	descDBlocked    *prometheus.Desc
	descDCost       *prometheus.Desc
	descDItemCost   *prometheus.Desc
}

const metricPrefix = "karpenter_optimizer_"

func newPromMetrics(server *Server) *promMetrics {
	m := &promMetrics{server: server}
	m.descUp = prometheus.NewDesc(metricPrefix+"up", "Always 1 while the process serves /metrics.", nil, nil)
	m.descK8s = prometheus.NewDesc(metricPrefix+"kubernetes_connected", "1 when connected to a Kubernetes API server.", nil, nil)
	m.descKarpenter = prometheus.NewDesc(metricPrefix+"karpenter_detected", "1 when the karpenter.sh API group is present.", nil, nil)
	m.descNodes = prometheus.NewDesc(metricPrefix+"cluster_nodes", "Total nodes in the cluster.", nil, nil)
	m.descPods = prometheus.NewDesc(metricPrefix+"cluster_pods", "Scheduled pods across the cluster.", nil, nil)
	m.descCPUUsed = prometheus.NewDesc(metricPrefix+"cluster_cpu_used", "CPU used, in cores (pod requests).", nil, nil)
	m.descCPUAlloc = prometheus.NewDesc(metricPrefix+"cluster_cpu_allocatable", "CPU allocatable, in cores.", nil, nil)
	m.descMemUsed = prometheus.NewDesc(metricPrefix+"cluster_memory_used", "Memory used, in GiB (pod requests).", nil, nil)
	m.descMemAlloc = prometheus.NewDesc(metricPrefix+"cluster_memory_allocatable", "Memory allocatable, in GiB.", nil, nil)
	m.descCostPerHour = prometheus.NewDesc(metricPrefix+"cluster_cost_per_hour", "Estimated cluster cost per hour in the configured region's currency.", nil, nil)
	m.descWatts = prometheus.NewDesc(metricPrefix+"cluster_power_watts", "Estimated fleet power draw in watts (static per-family estimates).", nil, nil)
	m.descPoolNodes = prometheus.NewDesc(metricPrefix+"nodepool_nodes", "Nodes currently running in a NodePool.", []string{"nodepool"}, nil)
	m.descPoolCost = prometheus.NewDesc(metricPrefix+"nodepool_cost_per_hour", "Estimated cost per hour of a NodePool's current nodes, in the configured region's currency.", []string{"nodepool"}, nil)
	m.descSrvOnline = prometheus.NewDesc(metricPrefix+"serving_pod_online", "1 when the LLM serving pod answered its last probe.", []string{"namespace", "pod", "model"}, nil)
	m.descSrvKV = prometheus.NewDesc(metricPrefix+"serving_kv_cache_pct", "KV cache utilization, 0-100.", []string{"namespace", "pod", "model"}, nil)
	m.descSrvTTFT = prometheus.NewDesc(metricPrefix+"serving_ttft_p95_seconds", "Time-to-first-token p95, seconds.", []string{"namespace", "pod", "model"}, nil)
	m.descSrvE2E = prometheus.NewDesc(metricPrefix+"serving_e2e_p95_seconds", "End-to-end request latency p95, seconds.", []string{"namespace", "pod", "model"}, nil)
	m.descSrvTok = prometheus.NewDesc(metricPrefix+"serving_tokens_per_second", "Token throughput (input+output), tokens/sec.", []string{"namespace", "pod", "model"}, nil)
	m.descSrvReq = prometheus.NewDesc(metricPrefix+"serving_requests_per_second", "Request rate, requests/sec.", []string{"namespace", "pod", "model"}, nil)
	m.descGwPods = prometheus.NewDesc(metricPrefix+"gateway_pods", "LiteLLM gateway replicas discovered.", nil, nil)
	m.descGwOnline = prometheus.NewDesc(metricPrefix+"gateway_online", "1 when the gateway /metrics endpoint answered.", nil, nil)
	m.descGwInFlight = prometheus.NewDesc(metricPrefix+"gateway_in_flight_requests", "Requests currently in flight at the gateway.", nil, nil)
	m.descGwQueued = prometheus.NewDesc(metricPrefix+"gateway_admission_queued", "Requests waiting in the admission queue.", nil, nil)
	m.descGwRejected = prometheus.NewDesc(metricPrefix+"gateway_admission_rejected_total", "Cumulative requests rejected by admission control (503s).", nil, nil)
	m.descGwErrRate = prometheus.NewDesc(metricPrefix+"gateway_error_rate_pct", "Gateway request error rate, 0-100.", nil, nil)
	m.descGwReq = prometheus.NewDesc(metricPrefix+"gateway_requests_per_second", "Gateway request rate, requests/sec.", nil, nil)
	m.descGwSpend = prometheus.NewDesc(metricPrefix+"gateway_spend_total", "Cumulative spend reported by the gateway, USD.", nil, nil)
	m.descGwAppSpend = prometheus.NewDesc(metricPrefix+"gateway_app_spend_total", "Cumulative spend per calling app (metadata_trace_name), USD.", []string{"app"}, nil)
	m.descDActive = prometheus.NewDesc(metricPrefix+"disruptions_active", "Disrupted nodes actively being handled (not blocked).", nil, nil)
	m.descDBlocked = prometheus.NewDesc(metricPrefix+"disruptions_blocked", "Disrupted nodes blocked from completing (e.g. by a PDB).", nil, nil)
	m.descDCost = prometheus.NewDesc(metricPrefix+"disruptions_cost_per_hour", "Combined hourly cost of disrupted nodes still running, in the configured region's currency.", nil, nil)
	m.descDItemCost = prometheus.NewDesc(metricPrefix+"disruption_cost_per_hour", "Hourly cost of one disrupted node still running, in the configured region's currency.", []string{"node", "nodepool"}, nil)
	return m
}

func (m *promMetrics) Describe(ch chan<- *prometheus.Desc) {
	for _, d := range []*prometheus.Desc{
		m.descUp, m.descK8s, m.descKarpenter, m.descNodes, m.descPods,
		m.descCPUUsed, m.descCPUAlloc, m.descMemUsed, m.descMemAlloc,
		m.descCostPerHour, m.descWatts, m.descPoolNodes, m.descPoolCost,
		m.descSrvOnline, m.descSrvKV, m.descSrvTTFT, m.descSrvE2E, m.descSrvTok, m.descSrvReq,
		m.descGwPods, m.descGwOnline, m.descGwInFlight, m.descGwQueued, m.descGwRejected,
		m.descGwErrRate, m.descGwReq, m.descGwSpend, m.descGwAppSpend,
		m.descDActive, m.descDBlocked, m.descDCost, m.descDItemCost,
	} {
		ch <- d
	}
}

func (m *promMetrics) Collect(ch chan<- prometheus.Metric) {
	s := m.server.snapshotMetrics()

	const g = prometheus.GaugeValue
	ch <- prometheus.MustNewConstMetric(m.descUp, g, 1)
	ch <- prometheus.MustNewConstMetric(m.descK8s, g, boolFloat(m.server.k8sClient != nil))
	ch <- prometheus.MustNewConstMetric(m.descKarpenter, g, boolFloat(m.server.karpenterDetected))
	ch <- prometheus.MustNewConstMetric(m.descNodes, g, float64(s.nodes))
	ch <- prometheus.MustNewConstMetric(m.descPods, g, float64(s.pods))
	ch <- prometheus.MustNewConstMetric(m.descCPUUsed, g, s.cpuUsed)
	ch <- prometheus.MustNewConstMetric(m.descCPUAlloc, g, s.cpuAllocatable)
	ch <- prometheus.MustNewConstMetric(m.descMemUsed, g, s.memUsed)
	ch <- prometheus.MustNewConstMetric(m.descMemAlloc, g, s.memAllocatable)
	ch <- prometheus.MustNewConstMetric(m.descCostPerHour, g, s.costPerHour)
	ch <- prometheus.MustNewConstMetric(m.descWatts, g, s.watts)

	for name, np := range s.nodePools {
		ch <- prometheus.MustNewConstMetric(m.descPoolNodes, g, float64(np.nodes), name)
		ch <- prometheus.MustNewConstMetric(m.descPoolCost, g, np.costPerHour, name)
	}

	for _, p := range s.serving {
		labels := []string{p.namespace, p.name, p.model}
		ch <- prometheus.MustNewConstMetric(m.descSrvOnline, g, p.online, labels...)
		ch <- prometheus.MustNewConstMetric(m.descSrvKV, g, p.kvCachePct, labels...)
		ch <- prometheus.MustNewConstMetric(m.descSrvTTFT, g, p.ttftP95, labels...)
		ch <- prometheus.MustNewConstMetric(m.descSrvE2E, g, p.e2eP95, labels...)
		ch <- prometheus.MustNewConstMetric(m.descSrvTok, g, p.tokensPerSec, labels...)
		ch <- prometheus.MustNewConstMetric(m.descSrvReq, g, p.requestsPerSec, labels...)
	}

	if gw := s.gateway; gw != nil {
		ch <- prometheus.MustNewConstMetric(m.descGwPods, g, float64(gw.pods))
		ch <- prometheus.MustNewConstMetric(m.descGwOnline, g, gw.online)
		ch <- prometheus.MustNewConstMetric(m.descGwInFlight, g, float64(gw.inFlight))
		ch <- prometheus.MustNewConstMetric(m.descGwQueued, g, float64(gw.queued))
		ch <- prometheus.MustNewConstMetric(m.descGwRejected, g, float64(gw.rejected))
		ch <- prometheus.MustNewConstMetric(m.descGwErrRate, g, gw.errorRatePct)
		ch <- prometheus.MustNewConstMetric(m.descGwReq, g, gw.requestsPerSec)
		ch <- prometheus.MustNewConstMetric(m.descGwSpend, g, gw.spendTotal)
		if gw.appSpendPresent {
			for app, spend := range gw.appSpend {
				ch <- prometheus.MustNewConstMetric(m.descGwAppSpend, g, spend, app)
			}
		}
	}

	ch <- prometheus.MustNewConstMetric(m.descDActive, g, float64(s.disruptionActive))
	ch <- prometheus.MustNewConstMetric(m.descDBlocked, g, float64(s.disruptionBlocked))
	ch <- prometheus.MustNewConstMetric(m.descDCost, g, s.disruptionCostPerHour)
	for node, d := range s.disruptionItems {
		ch <- prometheus.MustNewConstMetric(m.descDItemCost, g, d.costPerHour, node, d.nodePool)
	}
}

func boolFloat(b bool) float64 {
	if b {
		return 1
	}
	return 0
}

// initMetrics sets up the Prometheus registry and /metrics route when
// METRICS_ENABLED. The registry holds only the app collector — the snapshot
// is refreshed by the existing samplers, so a scrape makes zero extra
// Kubernetes or pricing API calls.
func (s *Server) initMetrics() {
	if !metricsEnabled() {
		return
	}
	reg := prometheus.NewRegistry()
	collector := newPromMetrics(s)
	if err := reg.Register(collector); err != nil {
		debugLog(s.config.Debug, "metrics: register: %v\n", err)
		return
	}
	s.metricsHandler = promhttp.HandlerFor(reg, promhttp.HandlerOpts{})
	// Gate /metrics behind the same bearer token as the API when auth is
	// enabled; otherwise it is registered directly on the router.
	if s.config.APIAuthToken != "" {
		s.router.GET("/metrics", bearerAuthMiddleware(s.config.APIAuthToken), func(c *gin.Context) {
			s.metricsHandler.ServeHTTP(c.Writer, c.Request)
		})
	} else {
		s.router.GET("/metrics", func(c *gin.Context) {
			s.metricsHandler.ServeHTTP(c.Writer, c.Request)
		})
	}
	debugLog(s.config.Debug, "metrics: /metrics enabled\n")
}

// snapshotMetrics returns the current immutable snapshot for the collector.
func (s *Server) snapshotMetrics() *metricsSnapState {
	s.metricsMu.RLock()
	defer s.metricsMu.RUnlock()
	if s.metricsSnap == nil {
		return newMetricsSnapState()
	}
	return s.metricsSnap
}

// publishMetrics replaces the snapshot with a section-updated clone.
func (s *Server) publishMetrics(update func(st *metricsSnapState)) {
	s.metricsMu.Lock()
	defer s.metricsMu.Unlock()
	if s.metricsSnap == nil {
		s.metricsSnap = newMetricsSnapState()
	}
	next := cloneMetricsSnapState(s.metricsSnap)
	update(next)
	next.updatedAt = time.Now()
	s.metricsSnap = next
}

// recordClusterMetrics folds one sampleCluster pass into the snapshot:
// cluster totals, per-NodePool node counts + cost, and fleet power.
// poolCost carries the per-NodePool cost already computed by sampleCluster
// (no extra pricing calls here).
func (s *Server) recordClusterMetrics(nodes []kubernetes.NodeInfo, costPerHour float64, poolCost map[string]float64) {
	if !metricsEnabled() {
		return
	}
	instanceTypes := make([]string, 0, len(nodes))
	for _, n := range nodes {
		if n.InstanceType != "" {
			instanceTypes = append(instanceTypes, n.InstanceType)
		}
	}
	pwr := power.Estimate(instanceTypes)

	var pods int
	var cpuUsed, cpuAlloc, memUsed, memAlloc float64
	poolNodes := map[string]int{}
	for _, n := range nodes {
		pods += n.PodCount
		if n.CPUUsage != nil {
			cpuUsed += n.CPUUsage.Used
			cpuAlloc += n.CPUUsage.Allocatable
		}
		if n.MemoryUsage != nil {
			memUsed += n.MemoryUsage.Used
			memAlloc += n.MemoryUsage.Allocatable
		}
		name := n.NodePool
		if name == "" {
			name = "unmanaged"
		}
		poolNodes[name]++
	}

	s.publishMetrics(func(st *metricsSnapState) {
		st.nodes = len(nodes)
		st.pods = pods
		st.cpuUsed, st.cpuAllocatable = cpuUsed, cpuAlloc
		st.memUsed, st.memAllocatable = memUsed, memAlloc
		st.costPerHour = costPerHour
		st.watts = pwr.Watts
		// Rebuild per-NodePool maps so drained pools drop out of the snapshot.
		st.nodePools = map[string]*nodePoolSnap{}
		for name, count := range poolNodes {
			st.nodePools[name] = &nodePoolSnap{nodes: count, costPerHour: poolCost[name]}
		}
	})
}

// recordServingMetrics folds one serving probe pass into the snapshot.
func (s *Server) recordServingMetrics(health []llmhealth.PodHealth) {
	if !metricsEnabled() {
		return
	}
	s.publishMetrics(func(st *metricsSnapState) {
		st.serving = map[string]*servingPodSnap{}
		for _, h := range health {
			model := h.Model
			if model == "" {
				model = "unknown"
			}
			online := 0.0
			if h.Online {
				online = 1
			}
			st.serving[h.Namespace+"/"+h.Name] = &servingPodSnap{
				namespace:      h.Namespace,
				name:           h.Name,
				model:          model,
				online:         online,
				kvCachePct:     derefFloat(h.KVCachePercent),
				ttftP95:        derefFloat(h.TTFTP95Seconds),
				e2eP95:         derefFloat(h.E2EP95Seconds),
				tokensPerSec:   derefFloat(h.TokensPerSec),
				requestsPerSec: derefFloat(h.RequestsPerSec),
			}
		}
	})
}

// recordGatewayMetrics folds one gateway probe into the snapshot. A nil/empty
// probe (no LiteLLM pods) clears the gateway section.
func (s *Server) recordGatewayMetrics(h *litellm.GatewayHealth) {
	if !metricsEnabled() {
		return
	}
	s.publishMetrics(func(st *metricsSnapState) {
		if h == nil || (h.Pods == 0 && !h.Online) {
			st.gateway = nil
			return
		}
		gw := &gatewaySnap{
			pods:           h.Pods,
			online:         boolFloat(h.Online),
			inFlight:       h.InFlightRequests,
			queued:         h.AdmissionQueued,
			rejected:       h.AdmissionRejected,
			errorRatePct:   derefFloat(h.ErrorRatePct),
			requestsPerSec: derefFloat(h.RequestsPerSec),
			spendTotal:     derefFloat(h.Spend),
		}
		if len(h.Apps) > 0 {
			gw.appSpend = make(map[string]float64, len(h.Apps))
			gw.appSpendPresent = true
			for _, a := range h.Apps {
				name := a.Name
				if name == "" {
					name = "(unattributed)"
				}
				gw.appSpend[name] = derefFloat(a.Spend)
			}
		}
		st.gateway = gw
	})
}

// recordDisruptionMetrics folds the disruption list (already fetched by the
// alerts tick) into the snapshot.
func (s *Server) recordDisruptionMetrics(disruptions []kubernetes.NodeDisruptionInfo) {
	if !metricsEnabled() {
		return
	}
	s.publishMetrics(func(st *metricsSnapState) {
		st.disruptionActive, st.disruptionBlocked = 0, 0
		st.disruptionCostPerHour = 0
		st.disruptionItems = map[string]*disruptionItemSnap{}
		for _, d := range disruptions {
			if d.IsBlocked {
				st.disruptionBlocked++
			} else {
				st.disruptionActive++
			}
			if d.CostPerHour != nil {
				st.disruptionCostPerHour += *d.CostPerHour
				pool := d.NodePool
				if pool == "" {
					pool = "unmanaged"
				}
				st.disruptionItems[d.NodeName] = &disruptionItemSnap{
					nodePool:    pool,
					costPerHour: *d.CostPerHour,
				}
			}
		}
	})
}

func derefFloat(p *float64) float64 {
	if p == nil {
		return 0
	}
	return *p
}
