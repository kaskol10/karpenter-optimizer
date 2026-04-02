package prometheus

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Client is a client for querying Prometheus/Mimir metrics
type Client struct {
	baseURL    string
	httpClient *http.Client
	enabled    bool
}

// QueryResult represents a Prometheus query result
type QueryResult struct {
	Status string `json:"status"`
	Data   struct {
		ResultType string `json:"resultType"`
		Result     []struct {
			Metric map[string]string `json:"metric"`
			Value  []interface{}     `json:"value"`
		} `json:"result"`
	} `json:"data"`
}

// PodMetrics represents CPU, memory, and storage usage for a pod
type PodMetrics struct {
	Namespace    string
	PodName      string
	CPUUsage     float64 // CPU cores
	MemoryUsage  float64 // Memory in GiB
	StorageUsage float64 // Storage in GiB (from PVC metrics)
}

// NewClient creates a new Prometheus client
func NewClient(baseURL string) *Client {
	if baseURL == "" {
		return &Client{
			enabled: false,
		}
	}

	return &Client{
		baseURL: baseURL,
		httpClient: &http.Client{
			Timeout: 60 * time.Second, // Increased timeout for storage queries which can be large
		},
		enabled: true,
	}
}

// IsEnabled returns whether the Prometheus client is enabled
func (c *Client) IsEnabled() bool {
	if c == nil {
		return false
	}
	return c.enabled
}

// Query executes a Prometheus query
func (c *Client) Query(ctx context.Context, query string) (*QueryResult, error) {
	if !c.enabled {
		return nil, fmt.Errorf("prometheus client not enabled")
	}

	// Build query URL
	queryURL := fmt.Sprintf("%s/api/v1/query", c.baseURL)
	req, err := http.NewRequestWithContext(ctx, "GET", queryURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	// Add query parameters
	q := req.URL.Query()
	q.Set("query", query)
	req.URL.RawQuery = q.Encode()

	// Execute request
	resp, err := c.httpClient.Do(req)
	if err != nil {
		// Check if it's a context timeout
		if ctx.Err() == context.DeadlineExceeded {
			return nil, fmt.Errorf("query timeout after 60s: %w", err)
		}
		// Check if it's an EOF error (connection closed)
		if err.Error() == "EOF" || strings.Contains(err.Error(), "EOF") {
			return nil, fmt.Errorf("connection closed by server (query may be too large or server overloaded): %w", err)
		}
		return nil, fmt.Errorf("failed to execute query: %w", err)
	}
	defer func() {
		_ = resp.Body.Close()
	}()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("prometheus query failed with status %d: %s", resp.StatusCode, string(body))
	}

	// Parse response
	var result QueryResult
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	if result.Status != "success" {
		return nil, fmt.Errorf("prometheus query returned status: %s", result.Status)
	}

	return &result, nil
}

// GetPodCPUUsage queries CPU usage for all pods
// Query: sum(rate(container_cpu_usage_seconds_total{container!="POD",container!=""}[5m])) by (pod, namespace)
func (c *Client) GetPodCPUUsage(ctx context.Context) (map[string]float64, error) {
	query := `sum(rate(container_cpu_usage_seconds_total{container!="POD",container!=""}[5m])) by (pod, namespace)`

	result, err := c.Query(ctx, query)
	if err != nil {
		return nil, err
	}

	metrics := make(map[string]float64)
	for _, r := range result.Data.Result {
		namespace := r.Metric["namespace"]
		podName := r.Metric["pod"]
		if namespace == "" || podName == "" {
			continue
		}

		// Extract value (Prometheus returns [timestamp, value])
		if len(r.Value) < 2 {
			continue
		}

		valueStr, ok := r.Value[1].(string)
		if !ok {
			continue
		}

		value, err := strconv.ParseFloat(valueStr, 64)
		if err != nil {
			continue
		}

		key := fmt.Sprintf("%s/%s", namespace, podName)
		metrics[key] = value
	}

	return metrics, nil
}

// GetPodMemoryUsage queries memory usage for all pods
// Query: sum(container_memory_working_set_bytes{container!="POD",container!=""}) by (pod, namespace)
func (c *Client) GetPodMemoryUsage(ctx context.Context) (map[string]float64, error) {
	query := `sum(container_memory_working_set_bytes{container!="POD",container!=""}) by (pod, namespace)`

	result, err := c.Query(ctx, query)
	if err != nil {
		return nil, err
	}

	metrics := make(map[string]float64)
	for _, r := range result.Data.Result {
		namespace := r.Metric["namespace"]
		podName := r.Metric["pod"]
		if namespace == "" || podName == "" {
			continue
		}

		// Extract value (Prometheus returns [timestamp, value])
		if len(r.Value) < 2 {
			continue
		}

		valueStr, ok := r.Value[1].(string)
		if !ok {
			continue
		}

		value, err := strconv.ParseFloat(valueStr, 64)
		if err != nil {
			continue
		}

		// Convert bytes to GiB
		valueGiB := value / (1024.0 * 1024.0 * 1024.0)

		key := fmt.Sprintf("%s/%s", namespace, podName)
		metrics[key] = valueGiB
	}

	return metrics, nil
}

// GetPVCStorageUsage queries storage usage for all PVCs
// Query: kubelet_volume_stats_used_bytes by (persistentvolumeclaim, namespace)
func (c *Client) GetPVCStorageUsage(ctx context.Context) (map[string]float64, error) {
	// Try multiple query variations as different Prometheus setups may have different label names
	queries := []string{
		`kubelet_volume_stats_used_bytes by (persistentvolumeclaim, namespace)`,
	}

	var result *QueryResult
	var err error
	var lastErr error

	// Retry logic: try up to 3 times with exponential backoff
	maxRetries := 3
	for attempt := 0; attempt < maxRetries; attempt++ {
		if attempt > 0 {
			// Exponential backoff: 1s, 2s, 4s
			backoff := time.Duration(1<<uint(attempt-1)) * time.Second
			fmt.Printf("Debug: Retrying storage query (attempt %d/%d) after %v...\n", attempt+1, maxRetries, backoff)
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(backoff):
			}
		}

		for i, query := range queries {
			// Create a context with timeout for this specific query (90s for large queries)
			queryCtx, cancel := context.WithTimeout(ctx, 90*time.Second)

			result, err = c.Query(queryCtx, query)
			cancel()

			if err == nil {
				if len(result.Data.Result) > 0 {
					// Success!
					return c.parsePVCStorageMetrics(result), nil
				}
				// Query succeeded but no results - try next variation
				lastErr = fmt.Errorf("query returned no results")
			} else {
				lastErr = err
				// Check if it's a retryable error (EOF, connection closed, timeout)
				if strings.Contains(err.Error(), "EOF") ||
					strings.Contains(err.Error(), "connection closed") ||
					strings.Contains(err.Error(), "timeout") {
					// Retryable error - break out of query loop and retry
					fmt.Printf("Debug: Query variation %d failed with retryable error: %v\n", i+1, err)
					break
				} else {
					// Non-retryable error - return immediately
					return nil, fmt.Errorf("failed to query storage metrics: %w", err)
				}
			}
		}

		// If we got here and err is nil, we succeeded
		if err == nil && result != nil && len(result.Data.Result) > 0 {
			return c.parsePVCStorageMetrics(result), nil
		}
	}

	// All retries failed
	if lastErr != nil {
		return nil, fmt.Errorf("failed to query storage metrics after %d attempts (last error: %v): %w", maxRetries, lastErr, err)
	}

	return make(map[string]float64), nil // Return empty map if no results
}

// parsePVCStorageMetrics parses the Prometheus query result into a map of PVC metrics
func (c *Client) parsePVCStorageMetrics(result *QueryResult) map[string]float64 {
	metrics := make(map[string]float64)
	for _, r := range result.Data.Result {
		// Try different label name variations
		// Common label names: namespace, pod_namespace, kubernetes_namespace
		namespace := r.Metric["namespace"]
		if namespace == "" {
			namespace = r.Metric["pod_namespace"]
		}
		if namespace == "" {
			namespace = r.Metric["kubernetes_namespace"]
		}

		// Common label names: persistentvolumeclaim, pvc, volume_name
		pvcName := r.Metric["persistentvolumeclaim"]
		if pvcName == "" {
			pvcName = r.Metric["pvc"]
		}
		if pvcName == "" {
			pvcName = r.Metric["volume_name"]
		}

		if namespace == "" || pvcName == "" {
			// Log available labels for debugging (first few only)
			if len(metrics) < 3 {
				fmt.Printf("Debug: Skipping metric with missing labels. Available labels: %v\n", r.Metric)
			}
			continue
		}

		// Extract value (Prometheus returns [timestamp, value])
		if len(r.Value) < 2 {
			continue
		}

		valueStr, ok := r.Value[1].(string)
		if !ok {
			continue
		}

		value, err := strconv.ParseFloat(valueStr, 64)
		if err != nil {
			continue
		}

		// Convert bytes to GiB
		valueGiB := value / (1024.0 * 1024.0 * 1024.0)

		key := fmt.Sprintf("%s/%s", namespace, pvcName)
		metrics[key] = valueGiB
	}

	return metrics
}

// GetPodMetrics fetches CPU, memory, and storage usage for all pods
func (c *Client) GetPodMetrics(ctx context.Context) (map[string]*PodMetrics, error) {
	cpuMetrics, err := c.GetPodCPUUsage(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get CPU metrics: %w", err)
	}

	memoryMetrics, err := c.GetPodMemoryUsage(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get memory metrics: %w", err)
	}

	// Combine metrics
	allMetrics := make(map[string]*PodMetrics)

	// Process CPU metrics
	for key, cpu := range cpuMetrics {
		parts := splitPodKey(key)
		if parts == nil {
			continue
		}

		metrics := &PodMetrics{
			Namespace: parts[0],
			PodName:   parts[1],
			CPUUsage:  cpu,
		}
		allMetrics[key] = metrics
	}

	// Add memory metrics
	for key, memory := range memoryMetrics {
		if metrics, exists := allMetrics[key]; exists {
			metrics.MemoryUsage = memory
		} else {
			parts := splitPodKey(key)
			if parts != nil {
				allMetrics[key] = &PodMetrics{
					Namespace:   parts[0],
					PodName:     parts[1],
					MemoryUsage: memory,
				}
			}
		}
	}

	return allMetrics, nil
}

// GetWorkloadStorageMetrics returns storage usage metrics keyed by "namespace/type/workloadname"
// This is separate from pod metrics because storage is tied to PVCs, not pods
func (c *Client) GetWorkloadStorageMetrics(ctx context.Context) (map[string]float64, error) {
	pvcMetrics, err := c.GetPVCStorageUsage(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get PVC storage metrics: %w", err)
	}

	// Return PVC metrics keyed by "namespace/pvcname"
	// The kubernetes client will match these to workloads
	return pvcMetrics, nil
}

// splitPodKey splits "namespace/podname" into [namespace, podname]
func splitPodKey(key string) []string {
	// Namespace can't contain '/', so we can just split on the first '/'
	parts := strings.SplitN(key, "/", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return nil
	}
	return parts
}

// ValidateURL validates that the Prometheus URL is accessible
func (c *Client) ValidateURL(ctx context.Context) error {
	if !c.enabled {
		return fmt.Errorf("prometheus client not enabled")
	}

	// Try a simple query to validate the URL
	_, err := c.Query(ctx, "up")
	if err != nil {
		return fmt.Errorf("failed to validate prometheus URL: %w", err)
	}

	return nil
}

// SetBaseURL updates the base URL (useful for testing or dynamic configuration)
func (c *Client) SetBaseURL(baseURL string) error {
	if baseURL == "" {
		c.enabled = false
		return nil
	}

	// Validate URL format
	_, err := url.Parse(baseURL)
	if err != nil {
		return fmt.Errorf("invalid prometheus URL: %w", err)
	}

	c.baseURL = baseURL
	c.enabled = true
	return nil
}
