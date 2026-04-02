package metrics

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	HTTPRequestsTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "http_requests_total",
			Help: "Total number of HTTP requests",
		},
		[]string{"method", "path", "status"},
	)

	HTTPRequestDuration = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "http_request_duration_seconds",
			Help:    "HTTP request duration in seconds",
			Buckets: []float64{.005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5},
		},
		[]string{"method", "path"},
	)

	RecommendationGenerationDuration = promauto.NewHistogram(
		prometheus.HistogramOpts{
			Name:    "recommendation_generation_duration_seconds",
			Help:    "Time taken to generate recommendations",
			Buckets: []float64{.1, .5, 1, 2.5, 5, 10, 30, 60},
		},
	)

	RecommendationsGenerated = promauto.NewCounter(
		prometheus.CounterOpts{
			Name: "recommendations_generated_total",
			Help: "Total number of recommendations generated",
		},
	)

	CostSavingsEstimated = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "cost_savings_estimated_dollars",
			Help: "Estimated cost savings in dollars per hour",
		},
	)

	K8sAPICalls = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "k8s_api_calls_total",
			Help: "Total Kubernetes API calls",
		},
		[]string{"operation", "status"},
	)

	K8sAPIDuration = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "k8s_api_call_duration_seconds",
			Help:    "Kubernetes API call duration in seconds",
			Buckets: []float64{.01, .05, .1, .25, .5, 1, 2.5, 5},
		},
		[]string{"operation"},
	)

	AWSPricingAPICalls = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "aws_pricing_api_calls_total",
			Help: "Total AWS Pricing API calls",
		},
		[]string{"status"},
	)

	AWSPricingAPIDuration = promauto.NewHistogram(
		prometheus.HistogramOpts{
			Name:    "aws_pricing_api_call_duration_seconds",
			Help:    "AWS Pricing API call duration in seconds",
			Buckets: []float64{.1, .5, 1, 2.5, 5, 10, 30},
		},
	)

	OllamaAPICalls = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "ollama_api_calls_total",
			Help: "Total Ollama API calls",
		},
		[]string{"status"},
	)

	OllamaAPIDuration = promauto.NewHistogram(
		prometheus.HistogramOpts{
			Name:    "ollama_api_call_duration_seconds",
			Help:    "Ollama API call duration in seconds",
			Buckets: []float64{.5, 1, 2.5, 5, 10, 30, 60},
		},
	)

	ActiveConnections = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "active_connections",
			Help: "Number of active SSE connections",
		},
	)

	CacheHits = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "cache_hits_total",
			Help: "Total cache hits",
		},
		[]string{"cache"},
	)

	CacheMisses = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "cache_misses_total",
			Help: "Total cache misses",
		},
		[]string{"cache"},
	)
)

func RecordHTTPRequest(method, path string, status int) {
	HTTPRequestsTotal.WithLabelValues(method, path, string(rune(status))).Inc()
}

func RecordHTTPRequestDuration(method, path string, duration float64) {
	HTTPRequestDuration.WithLabelValues(method, path).Observe(duration)
}
