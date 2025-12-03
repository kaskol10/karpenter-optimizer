package kubernetes

import (
	"context"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/client-go/util/homedir"
)

type Client struct {
	clientset       *kubernetes.Clientset
	dynamicClient   dynamic.Interface
	discoveryClient discovery.DiscoveryInterface
	debug           bool
}

type WorkloadInfo struct {
	Name          string            `json:"name"`
	Namespace     string            `json:"namespace"`
	Type          string            `json:"type"` // deployment, statefulset, daemonset
	CPURequest    string            `json:"cpuRequest"`
	MemoryRequest string            `json:"memoryRequest"`
	CPULimit      string            `json:"cpuLimit"`
	MemoryLimit   string            `json:"memoryLimit"`
	Replicas      int32             `json:"replicas"`
	Labels        map[string]string `json:"labels"`
	GPU           int               `json:"gpu"`
}

func NewClient(kubeconfigPath, kubeContext string) (*Client, error) {
	return NewClientWithDebug(kubeconfigPath, kubeContext, false)
}

func NewClientWithDebug(kubeconfigPath, kubeContext string, debug bool) (*Client, error) {
	var config *rest.Config
	var err error

	// If kubeconfig path is not provided, try to find it
	if kubeconfigPath == "" {
		// First try in-cluster config (if running inside Kubernetes)
		config, err = rest.InClusterConfig()
		if err == nil {
			// Successfully got in-cluster config, use it
			// Note: kubeContext is ignored when using in-cluster config
			if kubeContext != "" {
				return nil, fmt.Errorf("kubecontext cannot be set when using in-cluster config")
			}
		} else {
			// Not in-cluster, use default kubeconfig location
			if home := homedir.HomeDir(); home != "" {
				kubeconfigPath = filepath.Join(home, ".kube", "config")
			} else {
				return nil, fmt.Errorf("kubeconfig path not provided and cannot determine home directory")
			}
		}
	}

	// If we don't have a config yet (not in-cluster), build from kubeconfig file
	if config == nil {
		// If kubeContext is specified, use it
		if kubeContext != "" {
			loadingRules := &clientcmd.ClientConfigLoadingRules{}
			if kubeconfigPath != "" {
				loadingRules.ExplicitPath = kubeconfigPath
			}

			configOverrides := &clientcmd.ConfigOverrides{
				CurrentContext: kubeContext,
			}

			config, err = clientcmd.NewNonInteractiveDeferredLoadingClientConfig(
				loadingRules,
				configOverrides,
			).ClientConfig()
			if err != nil {
				return nil, fmt.Errorf("failed to build kubeconfig with context '%s' (kubeconfig: '%s'): %w", kubeContext, kubeconfigPath, err)
			}
		} else {
			// Build config from kubeconfig file without context override
			config, err = clientcmd.BuildConfigFromFlags("", kubeconfigPath)
			if err != nil {
				return nil, fmt.Errorf("failed to build kubeconfig from '%s': %w. Check that the file exists and is valid", kubeconfigPath, err)
			}
		}
	}

	// Configure rate limiting to prevent throttling
	// QPS: queries per second (default is 5, increase to 10)
	// Burst: maximum burst of requests (default is 10, increase to 20)
	// This helps prevent "client-side throttling" errors when querying many resources
	if config.QPS == 0 {
		config.QPS = 10
	}
	if config.Burst == 0 {
		config.Burst = 20
	}

	clientset, err := kubernetes.NewForConfig(config)
	if err != nil {
		return nil, fmt.Errorf("failed to create clientset: %w", err)
	}

	// All clients created from the same config will use the same QPS/Burst settings
	dynamicClient, err := dynamic.NewForConfig(config)
	if err != nil {
		return nil, fmt.Errorf("failed to create dynamic client: %w", err)
	}

	discoveryClient, err := discovery.NewDiscoveryClientForConfig(config)
	if err != nil {
		return nil, fmt.Errorf("failed to create discovery client: %w", err)
	}

	return &Client{
		clientset:       clientset,
		dynamicClient:   dynamicClient,
		discoveryClient: discoveryClient,
		debug:           debug,
	}, nil
}

// debugLog prints debug messages only if debug logging is enabled
func (c *Client) debugLog(format string, args ...interface{}) {
	if c.debug {
		fmt.Printf(format, args...)
	}
}

func (c *Client) ListNamespaces(ctx context.Context) ([]string, error) {
	namespaces, err := c.clientset.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("failed to list namespaces: %w", err)
	}

	var nsList []string
	for _, ns := range namespaces.Items {
		nsList = append(nsList, ns.Name)
	}

	return nsList, nil
}

func (c *Client) ListWorkloads(ctx context.Context, namespace string) ([]WorkloadInfo, error) {
	var workloads []WorkloadInfo

	// List Deployments
	deployments, err := c.clientset.AppsV1().Deployments(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("failed to list deployments: %w", err)
	}

	for _, dep := range deployments.Items {
		workload := c.extractWorkloadFromDeployment(&dep)
		workloads = append(workloads, workload)
	}

	// List StatefulSets
	statefulSets, err := c.clientset.AppsV1().StatefulSets(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("failed to list statefulsets: %w", err)
	}

	for _, sts := range statefulSets.Items {
		workload := c.extractWorkloadFromStatefulSet(&sts)
		workloads = append(workloads, workload)
	}

	// List DaemonSets
	daemonSets, err := c.clientset.AppsV1().DaemonSets(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("failed to list daemonsets: %w", err)
	}

	for _, ds := range daemonSets.Items {
		workload := c.extractWorkloadFromDaemonSet(&ds)
		workloads = append(workloads, workload)
	}

	return workloads, nil
}

// ListAllWorkloads lists all workloads across all namespaces in the cluster
func (c *Client) ListAllWorkloads(ctx context.Context) ([]WorkloadInfo, error) {
	var allWorkloads []WorkloadInfo

	// List all namespaces
	namespaces, err := c.ListNamespaces(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to list namespaces: %w", err)
	}

	// List workloads from each namespace
	for _, ns := range namespaces {
		// Skip system namespaces
		if ns == "kube-system" || ns == "kube-public" || ns == "kube-node-lease" {
			continue
		}

		workloads, err := c.ListWorkloads(ctx, ns)
		if err != nil {
			// Log error but continue with other namespaces
			continue
		}
		allWorkloads = append(allWorkloads, workloads...)
	}

	return allWorkloads, nil
}

func (c *Client) GetWorkload(ctx context.Context, namespace, name, workloadType string) (*WorkloadInfo, error) {
	switch workloadType {
	case "deployment":
		dep, err := c.clientset.AppsV1().Deployments(namespace).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return nil, fmt.Errorf("failed to get deployment: %w", err)
		}
		workload := c.extractWorkloadFromDeployment(dep)
		return &workload, nil
	case "statefulset":
		sts, err := c.clientset.AppsV1().StatefulSets(namespace).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return nil, fmt.Errorf("failed to get statefulset: %w", err)
		}
		workload := c.extractWorkloadFromStatefulSet(sts)
		return &workload, nil
	case "daemonset":
		ds, err := c.clientset.AppsV1().DaemonSets(namespace).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return nil, fmt.Errorf("failed to get daemonset: %w", err)
		}
		workload := c.extractWorkloadFromDaemonSet(ds)
		return &workload, nil
	default:
		return nil, fmt.Errorf("unsupported workload type: %s", workloadType)
	}
}

func (c *Client) extractWorkloadFromDeployment(dep *appsv1.Deployment) WorkloadInfo {
	workload := WorkloadInfo{
		Name:      dep.Name,
		Namespace: dep.Namespace,
		Type:      "deployment",
		Replicas:  *dep.Spec.Replicas,
		Labels:    dep.Labels,
	}

	c.extractResourcesFromPodSpec(&dep.Spec.Template.Spec, &workload)
	return workload
}

func (c *Client) extractWorkloadFromStatefulSet(sts *appsv1.StatefulSet) WorkloadInfo {
	workload := WorkloadInfo{
		Name:      sts.Name,
		Namespace: sts.Namespace,
		Type:      "statefulset",
		Replicas:  *sts.Spec.Replicas,
		Labels:    sts.Labels,
	}

	c.extractResourcesFromPodSpec(&sts.Spec.Template.Spec, &workload)
	return workload
}

func (c *Client) extractWorkloadFromDaemonSet(ds *appsv1.DaemonSet) WorkloadInfo {
	workload := WorkloadInfo{
		Name:      ds.Name,
		Namespace: ds.Namespace,
		Type:      "daemonset",
		Replicas:  0, // DaemonSets run on all nodes
		Labels:    ds.Labels,
	}

	c.extractResourcesFromPodSpec(&ds.Spec.Template.Spec, &workload)
	return workload
}

func (c *Client) extractResourcesFromPodSpec(podSpec *corev1.PodSpec, workload *WorkloadInfo) {
	var totalCPURequest, totalMemoryRequest, totalCPULimit, totalMemoryLimit resource.Quantity
	var gpuCount int

	// Only process regular containers (exclude init containers) to match node usage calculation
	// Init containers are transient and don't contribute to steady-state resource usage
	for _, container := range podSpec.Containers {
		// Sum up requests (primary metric, matching eks-node-viewer and node usage)
		if cpuReq := container.Resources.Requests[corev1.ResourceCPU]; !cpuReq.IsZero() {
			totalCPURequest.Add(cpuReq)
		}
		if memReq := container.Resources.Requests[corev1.ResourceMemory]; !memReq.IsZero() {
			totalMemoryRequest.Add(memReq)
		}

		// Sum up limits (kept for backward compatibility, but not used for recommendations)
		if cpuLimit := container.Resources.Limits[corev1.ResourceCPU]; !cpuLimit.IsZero() {
			totalCPULimit.Add(cpuLimit)
		}
		if memLimit := container.Resources.Limits[corev1.ResourceMemory]; !memLimit.IsZero() {
			totalMemoryLimit.Add(memLimit)
		}

		// Check for GPU resources (prefer requests, fallback to limits)
		if gpuReq := container.Resources.Requests["nvidia.com/gpu"]; !gpuReq.IsZero() {
			gpuCount += int(gpuReq.Value())
		} else if gpuLimit := container.Resources.Limits["nvidia.com/gpu"]; !gpuLimit.IsZero() {
			gpuCount += int(gpuLimit.Value())
		}
	}

	// Convert to string format
	if !totalCPURequest.IsZero() {
		workload.CPURequest = totalCPURequest.String()
	}
	if !totalMemoryRequest.IsZero() {
		workload.MemoryRequest = totalMemoryRequest.String()
	}
	if !totalCPULimit.IsZero() {
		workload.CPULimit = totalCPULimit.String()
	}
	if !totalMemoryLimit.IsZero() {
		workload.MemoryLimit = totalMemoryLimit.String()
	}
	workload.GPU = gpuCount
}

// NodeInfo represents actual node information from the cluster
type NodeInfo struct {
	Name         string     `json:"name"`
	NodePool     string     `json:"nodePool"`
	InstanceType string     `json:"instanceType"`
	CapacityType string     `json:"capacityType"`           // spot, on-demand
	Architecture string     `json:"architecture"`           // amd64, arm64
	CPUUsage     *NodeUsage `json:"cpuUsage,omitempty"`     // CPU usage information
	MemoryUsage  *NodeUsage `json:"memoryUsage,omitempty"`  // Memory usage information
	PodCount     int        `json:"podCount"`               // Number of pods scheduled on this node
	CreationTime string     `json:"creationTime,omitempty"` // Node creation timestamp
}

// NodeUsage represents resource usage for a node
type NodeUsage struct {
	Used        float64 `json:"used"`        // Used resources (CPU cores or Memory GiB)
	Capacity    float64 `json:"capacity"`    // Total capacity
	Allocatable float64 `json:"allocatable"` // Allocatable resources
	Percent     float64 `json:"percent"`     // Usage percentage (0-100)
}

// NodePoolInfo represents a Karpenter NodePool configuration
type NodePoolInfo struct {
	Name          string            `json:"name"`
	InstanceTypes []string          `json:"instanceTypes"`
	CapacityType  string            `json:"capacityType"` // spot, on-demand, or both
	Architecture  string            `json:"architecture"` // amd64, arm64
	MinSize       int               `json:"minSize"`
	MaxSize       int               `json:"maxSize"`
	Labels        map[string]string `json:"labels"`
	Requirements  map[string]string `json:"requirements"`          // Node requirements
	EstimatedCost float64           `json:"estimatedCost"`         // Cost per hour per instance type
	CurrentNodes  int               `json:"currentNodes"`          // Actual number of nodes in the cluster
	PodCount      int               `json:"podCount"`              // Total number of pods across all nodes in this NodePool
	ActualNodes   []NodeInfo        `json:"actualNodes,omitempty"` // Actual node details
	// Selectors for matching workloads to this NodePool
	Selector map[string]string `json:"selector,omitempty"` // NodePool selector labels
}

// ListNodePools lists all Karpenter NodePools in the cluster
func (c *Client) ListNodePools(ctx context.Context) ([]NodePoolInfo, error) {
	// First, try to discover the actual resource name and version
	gvr, err := c.discoverNodePoolResource(ctx)
	if err != nil {
		// If discovery fails, try common versions
		gvr = schema.GroupVersionResource{
			Group:    "karpenter.sh",
			Version:  "v1",
			Resource: "nodepools",
		}
	}

	var nodePools *unstructured.UnstructuredList
	var lastErr error

	// Try discovered version first, then fallback versions
	versions := []string{gvr.Version, "v1", "v1beta1", "v1alpha1"}

	for _, version := range versions {
		gvr.Version = version
		nodePools, err = c.dynamicClient.Resource(gvr).List(ctx, metav1.ListOptions{})
		if err == nil {
			break
		}
		lastErr = err
	}

	if nodePools == nil {
		return nil, fmt.Errorf("failed to list nodepools (tried versions: %v). Last error: %w. Check RBAC permissions: kubectl auth can-i list nodepools.karpenter.sh", versions, lastErr)
	}

	var result []NodePoolInfo
	for _, item := range nodePools.Items {
		np, err := c.parseNodePool(&item)
		if err != nil {
			// Log error but continue with other nodepools
			// Create a minimal NodePoolInfo to ensure all NodePools are returned
			fmt.Printf("Warning: Failed to parse NodePool %s: %v. Creating minimal entry.\n", item.GetName(), err)
			// Create minimal NodePool with just the name so it's not lost
			minimalNP := &NodePoolInfo{
				Name:          item.GetName(),
				Labels:        item.GetLabels(),
				Requirements:  make(map[string]string),
				Selector:      make(map[string]string),
				InstanceTypes: []string{},
				CapacityType:  "spot",  // Default
				Architecture:  "amd64", // Default
			}
			result = append(result, *minimalNP)
			continue
		}
		result = append(result, *np)
	}

	// Get actual node information with usage data (including pod counts) for each NodePool
	allNodes, err := c.GetAllNodesWithUsage(ctx)
	if err == nil {
		// Group nodes by NodePool
		nodesByPool := make(map[string][]NodeInfo)
		for _, node := range allNodes {
			if node.NodePool != "" {
				nodesByPool[node.NodePool] = append(nodesByPool[node.NodePool], node)
			}
		}

		// Update NodePool info with actual nodes and calculate total pod count
		for i := range result {
			if nodes, ok := nodesByPool[result[i].Name]; ok {
				result[i].CurrentNodes = len(nodes)
				result[i].ActualNodes = nodes
				// Calculate total pod count for this NodePool
				totalPodCount := 0
				for _, node := range nodes {
					totalPodCount += node.PodCount
				}
				result[i].PodCount = totalPodCount
			}
		}
	}

	c.debugLog("Successfully parsed %d out of %d NodePools\n", len(result), len(nodePools.Items))
	return result, nil
}

// getAllNodes gets all nodes from the cluster with their NodePool and instance type information
// Deprecated: Use GetAllNodesWithUsage instead
//nolint:unused // Kept for potential future use
func (c *Client) getAllNodes(ctx context.Context) ([]NodeInfo, error) {
	nodes, err := c.clientset.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("failed to list nodes: %w", err)
	}

	var nodeInfos []NodeInfo
	for _, node := range nodes.Items {
		nodeInfo := NodeInfo{
			Name:         node.Name,
			NodePool:     node.Labels["karpenter.sh/nodepool"],
			InstanceType: node.Labels["node.kubernetes.io/instance-type"],
			Architecture: node.Labels["kubernetes.io/arch"],
		}

		// Determine capacity type from labels
		if capacityType, ok := node.Labels["karpenter.sh/capacity-type"]; ok {
			nodeInfo.CapacityType = capacityType
		} else {
			// Try to infer from other labels
			nodeInfo.CapacityType = "on-demand" // Default
		}

		nodeInfos = append(nodeInfos, nodeInfo)
	}

	return nodeInfos, nil
}

// fetchPodsForNodeWithRetry fetches pods for a node with retry logic and exponential backoff
func (c *Client) fetchPodsForNodeWithRetry(ctx context.Context, nodeName string, maxRetries int) (*corev1.PodList, error) {
	var lastErr error
	backoff := 100 * time.Millisecond // Start with 100ms

	for attempt := 0; attempt < maxRetries; attempt++ {
		if attempt > 0 {
			// Wait before retry with exponential backoff
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(backoff):
				backoff = time.Duration(float64(backoff) * 1.5) // Exponential backoff
				if backoff > 2*time.Second {
					backoff = 2 * time.Second // Cap at 2 seconds
				}
			}
		}

		pods, err := c.clientset.CoreV1().Pods("").List(ctx, metav1.ListOptions{
			FieldSelector: fmt.Sprintf("spec.nodeName=%s", nodeName),
		})

		if err == nil {
			return pods, nil
		}

		lastErr = err
		// Check if it's a rate limit error or context deadline - retry these
		if strings.Contains(err.Error(), "rate limiter") || strings.Contains(err.Error(), "deadline") {
			// Continue to retry
			continue
		}
		// For other errors, don't retry
		return nil, err
	}

	return nil, fmt.Errorf("failed after %d retries: %w", maxRetries, lastErr)
}

// GetAllNodesWithUsage gets all nodes with resource usage information
func (c *Client) GetAllNodesWithUsage(ctx context.Context) ([]NodeInfo, error) {
	nodes, err := c.clientset.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("failed to list nodes: %w", err)
	}

	var nodeInfos []NodeInfo
	for _, node := range nodes.Items {
		// Skip nodes that are being deleted
		if node.DeletionTimestamp != nil {
			continue
		}

		// Create a fresh nodeInfo struct for each node to avoid any potential data reuse
		nodeInfo := NodeInfo{
			Name:         node.Name,
			NodePool:     node.Labels["karpenter.sh/nodepool"],
			InstanceType: node.Labels["node.kubernetes.io/instance-type"],
			CapacityType: node.Labels["karpenter.sh/capacity-type"],
			Architecture: node.Labels["kubernetes.io/arch"],
			CPUUsage:     nil, // Explicitly initialize to nil
			MemoryUsage:  nil, // Explicitly initialize to nil
		}

		// Extract CPU capacity and allocatable
		var cpuCapacity, cpuAllocatable float64
		if cpuCap, ok := node.Status.Capacity[corev1.ResourceCPU]; ok {
			cpuCapacity = float64(cpuCap.MilliValue()) / 1000.0 // Convert millicores to cores
		}
		if cpuAlloc, ok := node.Status.Allocatable[corev1.ResourceCPU]; ok {
			cpuAllocatable = float64(cpuAlloc.MilliValue()) / 1000.0
		}

		// Extract Memory capacity and allocatable
		var memCapacity, memAllocatable float64
		if memCap, ok := node.Status.Capacity[corev1.ResourceMemory]; ok {
			memCapacity = float64(memCap.Value()) / (1024.0 * 1024.0 * 1024.0) // Convert bytes to GiB
		}
		if memAlloc, ok := node.Status.Allocatable[corev1.ResourceMemory]; ok {
			memAllocatable = float64(memAlloc.Value()) / (1024.0 * 1024.0 * 1024.0)
		}

		// Get pods on this node once to calculate usage
		// Initialize usage counters for this node (reset for each node)
		cpuUsed := 0.0
		memUsed := 0.0

		// Create a per-node context with its own timeout (10 seconds per node)
		// This prevents one slow node from blocking others, while still allowing retries
		nodeCtx, nodeCancel := context.WithTimeout(ctx, 10*time.Second)
		pods, err := c.fetchPodsForNodeWithRetry(nodeCtx, node.Name, 3)
		nodeCancel()

		if err != nil {
			// Log error but continue with empty pod list
			if nodeCtx.Err() == context.DeadlineExceeded {
				fmt.Printf("Warning: Timeout fetching pods for node %s after retries (10s per-node timeout)\n", node.Name)
			} else if ctx.Err() == context.DeadlineExceeded {
				fmt.Printf("Warning: Overall timeout exceeded while fetching pods for node %s\n", node.Name)
			} else {
				fmt.Printf("Warning: Error fetching pods for node %s after retries: %v\n", node.Name, err)
			}
			pods = &corev1.PodList{Items: []corev1.Pod{}}
		} else if len(pods.Items) > 20 {
			c.debugLog("Debug: Node %s has %d pods\n", node.Name, len(pods.Items))
		}

		// Process pods if we have any
		// Following eks-node-viewer approach: only count scheduled pod resource requests (not limits, not init containers)
		// pods is guaranteed to be non-nil after error handling above
		if len(pods.Items) > 0 {
			for _, pod := range pods.Items {
				// Skip pods that are being terminated
				if pod.DeletionTimestamp != nil {
					continue
				}

				// Skip pods in terminal states (Succeeded, Failed) as they're not scheduled
				if pod.Status.Phase == corev1.PodSucceeded || pod.Status.Phase == corev1.PodFailed {
					continue
				}

				// Only count pods that are actually scheduled (have a node assigned)
				// This matches eks-node-viewer's approach of showing "scheduled pod resource requests"
				if pod.Spec.NodeName == "" {
					continue // Pod not yet scheduled
				}

				// Process only regular containers (exclude init containers per eks-node-viewer)
				// Init containers are transient and don't contribute to steady-state resource usage
				for _, container := range pod.Spec.Containers {
					// Only use resource requests (not limits) - this matches eks-node-viewer exactly
					// eks-node-viewer displays "scheduled pod resource requests vs allocatable capacity"
					if cpuReq := container.Resources.Requests[corev1.ResourceCPU]; !cpuReq.IsZero() {
						cpuUsed += float64(cpuReq.MilliValue()) / 1000.0
					}

					if memReq := container.Resources.Requests[corev1.ResourceMemory]; !memReq.IsZero() {
						memUsed += float64(memReq.Value()) / (1024.0 * 1024.0 * 1024.0)
					}
				}
			}
		}

		// Always set CPU usage info if we have allocatable (even if usage is 0)
		if cpuAllocatable > 0 {
			cpuPercent := (cpuUsed / cpuAllocatable) * 100
			if cpuPercent > 100 {
				cpuPercent = 100
			}

			nodeInfo.CPUUsage = &NodeUsage{
				Used:        cpuUsed,
				Capacity:    cpuCapacity,
				Allocatable: cpuAllocatable,
				Percent:     cpuPercent,
			}
		}

		// Always set Memory usage info if we have allocatable (even if usage is 0)
		if memAllocatable > 0 {
			memPercent := (memUsed / memAllocatable) * 100
			if memPercent > 100 {
				memPercent = 100
			}

			nodeInfo.MemoryUsage = &NodeUsage{
				Used:        memUsed,
				Capacity:    memCapacity,
				Allocatable: memAllocatable,
				Percent:     memPercent,
			}
		}

		// Count pods on this node (excluding terminated and terminal pods)
		podCount := 0
		// pods is guaranteed to be non-nil after error handling above
		if len(pods.Items) > 0 {
			for _, pod := range pods.Items {
				if pod.DeletionTimestamp == nil &&
					pod.Status.Phase != corev1.PodSucceeded &&
					pod.Status.Phase != corev1.PodFailed {
					podCount++
				}
			}
		}
		nodeInfo.PodCount = podCount

		// Add node creation time
		if !node.CreationTimestamp.IsZero() {
			nodeInfo.CreationTime = node.CreationTimestamp.Format(time.RFC3339)
		}

		nodeInfos = append(nodeInfos, nodeInfo)
	}

	return nodeInfos, nil
}

// GetNodesByNodePool gets node names that belong to a specific NodePool
func (c *Client) GetNodesByNodePool(ctx context.Context, nodePoolName string) ([]string, error) {
	labelSelector := fmt.Sprintf("karpenter.sh/nodepool=%s", nodePoolName)
	nodes, err := c.clientset.CoreV1().Nodes().List(ctx, metav1.ListOptions{
		LabelSelector: labelSelector,
	})
	if err != nil {
		return nil, err
	}

	var nodeNames []string
	for _, node := range nodes.Items {
		nodeNames = append(nodeNames, node.Name)
	}
	return nodeNames, nil
}

// PodInfo represents a pod running on a node
type PodInfo struct {
	Name         string       `json:"name"`
	Namespace    string       `json:"namespace"`
	NodeName     string       `json:"nodeName"`
	WorkloadName string       `json:"workloadName"`       // Extracted workload name (e.g., "myapp" from "myapp-abc123")
	WorkloadType string       `json:"workloadType"`       // deployment, statefulset, daemonset, pod
	Phase        string       `json:"phase,omitempty"`    // Pod phase (Pending, Running, Succeeded, Failed, Unknown)
	Status       string       `json:"status,omitempty"`   // Pod status
	Requests     ResourceInfo `json:"requests,omitempty"` // Pod resource requests
	Limits       ResourceInfo `json:"limits,omitempty"`   // Pod resource limits
	QOSClass     string       `json:"qosClass,omitempty"` // QoS class (Guaranteed, Burstable, BestEffort)
}

// GetPodsOnNodes gets all pods running on the specified nodes
func (c *Client) GetPodsOnNodes(ctx context.Context, nodeNames map[string]bool) ([]PodInfo, error) {
	var allPods []PodInfo

	// Get pods from all namespaces
	pods, err := c.clientset.CoreV1().Pods("").List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}

	for _, pod := range pods.Items {
		// Check if pod is running on one of our nodes
		if nodeNames[pod.Spec.NodeName] {
			// Extract workload name from pod name (remove pod-specific suffix)
			workloadName := pod.Name
			workloadType := ""

			// Try to get workload from owner references
			for _, owner := range pod.OwnerReferences {
				switch owner.Kind {
				case "ReplicaSet":
					// ReplicaSet name format: workloadname-randomstring
					// Extract workload name
					parts := strings.Split(owner.Name, "-")
					if len(parts) > 1 {
						// Remove the random suffix (last part)
						workloadName = strings.Join(parts[:len(parts)-1], "-")
					}
					workloadType = "deployment"
				case "StatefulSet":
					// StatefulSet pod name format: workloadname-ordinal
					parts := strings.Split(pod.Name, "-")
					if len(parts) > 1 {
						// Remove the ordinal (last part)
						workloadName = strings.Join(parts[:len(parts)-1], "-")
					}
					workloadType = "statefulset"
				case "DaemonSet":
					workloadName = pod.Name
					workloadType = "daemonset"
				}
			}

			allPods = append(allPods, PodInfo{
				Name:         pod.Name,
				Namespace:    pod.Namespace,
				NodeName:     pod.Spec.NodeName,
				WorkloadName: workloadName,
				WorkloadType: workloadType,
			})
		}
	}

	return allPods, nil
}

// discoverNodePoolResource discovers the NodePool resource using API discovery
func (c *Client) discoverNodePoolResource(ctx context.Context) (schema.GroupVersionResource, error) {
	// Try different API versions
	versions := []string{"karpenter.sh/v1", "karpenter.sh/v1beta1", "karpenter.sh/v1alpha1"}

	for _, groupVersion := range versions {
		apiResourceList, err := c.discoveryClient.ServerResourcesForGroupVersion(groupVersion)
		if err != nil {
			continue
		}

		// Find nodepools resource (can be plural or singular)
		for _, resource := range apiResourceList.APIResources {
			if resource.Name == "nodepools" || resource.Name == "nodepool" {
				// Parse group and version from groupVersion (e.g., "karpenter.sh/v1")
				parts := splitGroupVersion(groupVersion)
				return schema.GroupVersionResource{
					Group:    parts[0],
					Version:  parts[1],
					Resource: resource.Name,
				}, nil
			}
		}
	}

	return schema.GroupVersionResource{}, fmt.Errorf("nodepools resource not found in karpenter.sh API")
}

// splitGroupVersion splits "group/version" into [group, version]
func splitGroupVersion(gv string) []string {
	parts := make([]string, 2)
	idx := len(gv) - 1
	for idx >= 0 && gv[idx] != '/' {
		idx--
	}
	if idx >= 0 {
		parts[0] = gv[:idx]
		parts[1] = gv[idx+1:]
	} else {
		parts[0] = gv
		parts[1] = ""
	}
	return parts
}

// GetNodePool gets a specific Karpenter NodePool by name
func (c *Client) GetNodePool(ctx context.Context, name string) (*NodePoolInfo, error) {
	// Discover the resource first
	gvr, err := c.discoverNodePoolResource(ctx)
	if err != nil {
		// Fallback to common versions
		gvr = schema.GroupVersionResource{
			Group:    "karpenter.sh",
			Version:  "v1",
			Resource: "nodepools",
		}
	}

	var item *unstructured.Unstructured
	var lastErr error
	versions := []string{gvr.Version, "v1", "v1beta1", "v1alpha1"}

	for _, version := range versions {
		gvr.Version = version
		item, err = c.dynamicClient.Resource(gvr).Get(ctx, name, metav1.GetOptions{})
		if err == nil {
			break
		}
		lastErr = err
	}

	if item == nil {
		return nil, fmt.Errorf("failed to get nodepool %s (tried versions: %v). Last error: %w", name, versions, lastErr)
	}

	return c.parseNodePool(item)
}

func (c *Client) parseNodePool(item *unstructured.Unstructured) (*NodePoolInfo, error) {
	np := &NodePoolInfo{
		Name:         item.GetName(),
		Labels:       item.GetLabels(),
		Requirements: make(map[string]string),
		Selector:     make(map[string]string),
	}

	// Extract spec
	spec, found, err := unstructured.NestedMap(item.Object, "spec")
	if !found || err != nil {
		return nil, fmt.Errorf("failed to get spec: %w", err)
	}

	// Extract template (v1/v1beta1) or use spec directly (v1alpha1)
	template, found, _ := unstructured.NestedMap(spec, "template")
	if !found {
		// Try v1alpha1 structure (no template wrapper)
		template = spec
	}

	// Extract limits from spec (v1 has limits at spec level)
	limits, _, _ := unstructured.NestedMap(spec, "limits")
	if limits == nil {
		// Try template level
		limits, _, _ = unstructured.NestedMap(template, "limits")
	}
	if limits != nil {
		if cpu, ok := limits["cpu"].(string); ok {
			np.Requirements["cpu"] = cpu
		}
		if memory, ok := limits["memory"].(string); ok {
			np.Requirements["memory"] = memory
		}
	}

	// Extract requirements - v1 has them in spec.template.spec.requirements
	var requirements []interface{}
	var templateSpec map[string]interface{}

	// Try spec.template.spec.requirements first (v1 structure)
	if template != nil {
		templateSpec, _, _ = unstructured.NestedMap(template, "spec")
		if templateSpec != nil {
			requirements, _, _ = unstructured.NestedSlice(templateSpec, "requirements")
		}
	}

	// Fallback to template.requirements (v1beta1/v1alpha1)
	if requirements == nil && template != nil {
		requirements, _, _ = unstructured.NestedSlice(template, "requirements")
	}

	// Fallback to spec.requirements (v1alpha1)
	if requirements == nil {
		requirements, _, _ = unstructured.NestedSlice(spec, "requirements")
	}
	// Range over requirements (safe even if nil - will just not iterate)
	for _, req := range requirements {
		if reqMap, ok := req.(map[string]interface{}); ok {
			key, _ := reqMap["key"].(string)
			operator, _ := reqMap["operator"].(string)
			values, _ := reqMap["values"].([]interface{})

			if operator == "In" && len(values) > 0 {
				if val, ok := values[0].(string); ok {
					switch key {
					case "karpenter.k8s.aws/instance-family":
						// Instance family
					case "karpenter.sh/capacity-type":
						np.CapacityType = val
					case "kubernetes.io/arch":
						np.Architecture = val
					case "karpenter.k8s.aws/instance-size":
						// Instance size
					default:
						np.Requirements[key] = val
					}
				}
			}
		}
	}

	// Extract instance types (v1/v1beta1/v1alpha1)
	// Try template.spec first (v1), then template (v1beta1), then spec (v1alpha1)
	if templateSpec != nil {
		if instanceTypes, _, _ := unstructured.NestedStringSlice(templateSpec, "instanceTypes"); len(instanceTypes) > 0 {
			np.InstanceTypes = instanceTypes
		}
	}
	if len(np.InstanceTypes) == 0 && template != nil {
		if instanceTypes, _, _ := unstructured.NestedStringSlice(template, "instanceTypes"); len(instanceTypes) > 0 {
			np.InstanceTypes = instanceTypes
		}
	}
	if len(np.InstanceTypes) == 0 {
		if instanceTypes, _, _ := unstructured.NestedStringSlice(spec, "instanceTypes"); len(instanceTypes) > 0 {
			np.InstanceTypes = instanceTypes
		}
	}

	// Extract constraints (v1alpha1 only)
	if constraints, _, _ := unstructured.NestedMap(spec, "constraints"); constraints != nil {
		if instanceTypes, _, _ := unstructured.NestedStringSlice(constraints, "instanceTypes"); len(instanceTypes) > 0 {
			np.InstanceTypes = instanceTypes
		}
	}

	// Extract disruption (for min/max)
	disruption, _, _ := unstructured.NestedMap(spec, "disruption")
	if disruption != nil {
		if min, ok := disruption["consolidationPolicy"].(string); ok && min == "WhenEmpty" {
			np.MinSize = 0
		}
	}

	// Extract selector/labels from spec (NodePools can have selectors to match workloads)
	// In Karpenter, workloads match NodePools via nodeSelector or nodeAffinity
	// We'll extract any selector information from the NodePool spec
	if templateSpec != nil {
		if selector, _, _ := unstructured.NestedMap(templateSpec, "nodeSelector"); selector != nil {
			for k, v := range selector {
				if val, ok := v.(string); ok {
					np.Selector[k] = val
				}
			}
		}
	}

	// Also check for labels in template metadata
	if template != nil {
		if templateMetadata, _, _ := unstructured.NestedMap(template, "metadata"); templateMetadata != nil {
			if labels, _, _ := unstructured.NestedStringMap(templateMetadata, "labels"); labels != nil {
				// Merge labels into selector (workloads match via nodeSelector)
				for k, v := range labels {
					np.Selector[k] = v
				}
			}
		}
	}

	// Set defaults
	if np.CapacityType == "" {
		np.CapacityType = "spot" // Default for Karpenter
	}
	if np.Architecture == "" {
		np.Architecture = "amd64" // Default
	}

	// Estimate cost per instance type (will be multiplied by node count later)
	np.EstimatedCost = c.estimateNodePoolCost(np.InstanceTypes, np.CapacityType)

	return np, nil
}

func (c *Client) estimateNodePoolCost(instanceTypes []string, capacityType string) float64 {
	// Rough cost estimates (same as recommender)
	costMap := map[string]float64{
		"t3.medium":    0.0416,
		"t3.large":     0.0832,
		"m6i.large":    0.096,
		"m6i.xlarge":   0.192,
		"m6i.2xlarge":  0.384,
		"m6a.large":    0.0864,
		"m6a.xlarge":   0.1728,
		"c6i.xlarge":   0.17,
		"c6i.2xlarge":  0.34,
		"c6i.4xlarge":  0.68,
		"c6a.xlarge":   0.153,
		"c6a.2xlarge":  0.306,
		"r6i.large":    0.126,
		"r6i.xlarge":   0.252,
		"r6i.2xlarge":  0.504,
		"r6a.large":    0.1134,
		"r6a.xlarge":   0.2268,
		"g4dn.xlarge":  0.526,
		"g4dn.2xlarge": 0.752,
		"g5.xlarge":    1.006,
		"g5.2xlarge":   1.212,
	}

	var avgCost float64
	for _, it := range instanceTypes {
		if cost, ok := costMap[it]; ok {
			avgCost += cost
		} else {
			// Estimate based on instance family
			avgCost += 0.2 // Default estimate
		}
	}
	if len(instanceTypes) > 0 {
		avgCost /= float64(len(instanceTypes))
	}

	// Spot instances are typically 60-70% cheaper
	if capacityType == "spot" {
		avgCost *= 0.65
	}

	return avgCost
}

// NodeDisruptionInfo represents information about a node disruption event
type NodeDisruptionInfo struct {
	NodeName        string            `json:"nodeName"`
	NodePool        string            `json:"nodePool"`
	InstanceType    string            `json:"instanceType"`
	Reason          string            `json:"reason"`                 // consolidation, expiration, drift, etc.
	Message         string            `json:"message"`                // Event message
	FirstSeen       string            `json:"firstSeen"`              // RFC3339 timestamp
	LastSeen        string            `json:"lastSeen"`               // RFC3339 timestamp
	EventCount      int               `json:"eventCount"`             // Number of events for this disruption
	AffectedPods    []PodInfo         `json:"affectedPods,omitempty"` // Pods that were on this node
	Labels          map[string]string `json:"labels,omitempty"`
	Annotations     map[string]string `json:"annotations,omitempty"`    // Node annotations (includes Karpenter disruption reasons)
	IsBlocked       bool              `json:"isBlocked"`                // True if node deletion is blocked
	BlockingReason  string            `json:"blockingReason,omitempty"` // Why it's blocked (PDB, etc.)
	BlockingPods    []string          `json:"blockingPods,omitempty"`   // Pods that are blocking eviction
	BlockingPDBs    []string          `json:"blockingPDBs,omitempty"`   // PDBs that are blocking
	NodeStillExists bool              `json:"nodeStillExists"`          // True if node still exists (might be blocked)
	// Enhanced node information from Kubernetes API
	NodeConditions      []NodeCondition `json:"nodeConditions,omitempty"`      // Node conditions (Ready, MemoryPressure, etc.)
	ResourceCapacity    ResourceInfo    `json:"resourceCapacity,omitempty"`    // Node resource capacity
	ResourceAllocatable ResourceInfo    `json:"resourceAllocatable,omitempty"` // Node allocatable resources
	CreationTime        string          `json:"creationTime,omitempty"`        // When node was created
	DeletionTime        string          `json:"deletionTime,omitempty"`        // When node was marked for deletion
}

// NodeCondition represents a node condition
type NodeCondition struct {
	Type    string `json:"type"`
	Status  string `json:"status"`
	Reason  string `json:"reason,omitempty"`
	Message string `json:"message,omitempty"`
}

// ResourceInfo represents CPU and memory resources
type ResourceInfo struct {
	CPU    string `json:"cpu,omitempty"`
	Memory string `json:"memory,omitempty"`
}

// GetNodeDisruptions retrieves current/live node disruptions based on node state
// This checks nodes that are currently marked for deletion or disruption, not historical events
// It specifically looks for FailedDraining events to identify blocked disruptions
func (c *Client) GetNodeDisruptions(ctx context.Context, sinceHours int) ([]NodeDisruptionInfo, error) {
	var disruptions []NodeDisruptionInfo
	now := time.Now()

	// First, query for FailedDraining events - these indicate nodes that Karpenter tried to drain but failed
	// This is equivalent to: kubectl get events -A --field-selector reason=FailedDraining
	failedDrainingEvents, err := c.clientset.CoreV1().Events("").List(ctx, metav1.ListOptions{
		FieldSelector: "reason=FailedDraining,involvedObject.kind=Node",
	})
	if err == nil {
		// Track nodes we've seen from FailedDraining events
		failedDrainingNodes := make(map[string]*corev1.Event)
		for _, event := range failedDrainingEvents.Items {
			nodeName := event.InvolvedObject.Name
			if nodeName != "" {
				// Keep the most recent event for each node
				if existing, ok := failedDrainingNodes[nodeName]; !ok ||
					event.LastTimestamp.After(existing.LastTimestamp.Time) {
					failedDrainingNodes[nodeName] = &event
				}
			}
		}

		// For each node with FailedDraining event, get detailed information
		for nodeName, event := range failedDrainingNodes {
			node, err := c.clientset.CoreV1().Nodes().Get(ctx, nodeName, metav1.GetOptions{})
			if err != nil {
				// Node might have been deleted, skip
				continue
			}

			// Get node information
			nodePool := node.Labels["karpenter.sh/nodepool"]
			instanceType := node.Labels["node.kubernetes.io/instance-type"]

			// Determine reason from Karpenter annotations or event
			reason := "FailedDraining"
			message := event.Message
			if disruptionReason, ok := node.Annotations["karpenter.sh/disruption"]; ok {
				reason = disruptionReason
			} else if disruptionReason, ok := node.Annotations["karpenter.sh/disruption-reason"]; ok {
				reason = disruptionReason
			}

			// Extract node conditions and resource info
			var nodeConditions []NodeCondition
			for _, condition := range node.Status.Conditions {
				nodeConditions = append(nodeConditions, NodeCondition{
					Type:    string(condition.Type),
					Status:  string(condition.Status),
					Reason:  condition.Reason,
					Message: condition.Message,
				})
			}

			resourceCapacity := ResourceInfo{}
			resourceAllocatable := ResourceInfo{}
			if cpu, ok := node.Status.Capacity[corev1.ResourceCPU]; ok {
				resourceCapacity.CPU = cpu.String()
			}
			if memory, ok := node.Status.Capacity[corev1.ResourceMemory]; ok {
				resourceCapacity.Memory = memory.String()
			}
			if cpu, ok := node.Status.Allocatable[corev1.ResourceCPU]; ok {
				resourceAllocatable.CPU = cpu.String()
			}
			if memory, ok := node.Status.Allocatable[corev1.ResourceMemory]; ok {
				resourceAllocatable.Memory = memory.String()
			}

			deletionTime := ""
			if node.DeletionTimestamp != nil {
				deletionTime = node.DeletionTimestamp.Format(time.RFC3339)
			}

			disruption := &NodeDisruptionInfo{
				NodeName:            node.Name,
				NodePool:            nodePool,
				InstanceType:        instanceType,
				Reason:              reason,
				Message:             message,
				FirstSeen:           event.FirstTimestamp.Format(time.RFC3339),
				LastSeen:            event.LastTimestamp.Format(time.RFC3339),
				EventCount:          1,
				Labels:              node.Labels,
				Annotations:         node.Annotations,
				NodeStillExists:     true,
				IsBlocked:           true, // FailedDraining means it's blocked
				BlockingReason:      "Failed to drain node",
				NodeConditions:      nodeConditions,
				ResourceCapacity:    resourceCapacity,
				ResourceAllocatable: resourceAllocatable,
				CreationTime:        node.CreationTimestamp.Format(time.RFC3339),
				DeletionTime:        deletionTime,
			}

			// Get pods currently running on this node (equivalent to kubectl describe node)
			pods, err := c.getPodsOnNode(ctx, node.Name)
			if err == nil {
				disruption.AffectedPods = pods
			}

			// Check for PDBs and pod eviction issues
			c.checkBlockingConstraints(ctx, disruption, node)

			disruptions = append(disruptions, *disruption)
		}
	}

	// Also check nodes marked for deletion (even if they don't have FailedDraining events yet)
	nodes, err := c.clientset.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("failed to list nodes: %w", err)
	}

	// Track nodes we've already processed from FailedDraining events
	processedNodes := make(map[string]bool)
	for _, d := range disruptions {
		processedNodes[d.NodeName] = true
	}

	// Check each node for disruption state
	for _, node := range nodes.Items {
		// Skip if we already processed this node from FailedDraining events
		if processedNodes[node.Name] {
			continue
		}

		// Check if node is marked for deletion (this is the key indicator)
		if node.DeletionTimestamp == nil {
			continue // Node is not being deleted, skip
		}

		// Node is marked for deletion - this is a disruption
		nodePool := node.Labels["karpenter.sh/nodepool"]
		instanceType := node.Labels["node.kubernetes.io/instance-type"]

		// Determine reason from Karpenter annotations, node conditions, or labels
		reason := "Terminating"
		message := fmt.Sprintf("Node marked for deletion at %s", node.DeletionTimestamp.Format(time.RFC3339))

		// Check Karpenter annotations for disruption reason
		// Karpenter may set annotations like:
		// - karpenter.sh/do-not-disrupt: "true" (blocks disruption)
		// - karpenter.sh/disruption: "consolidation" or "expiration" or "drift"
		if disruptionReason, ok := node.Annotations["karpenter.sh/disruption"]; ok {
			reason = disruptionReason
		} else if disruptionReason, ok := node.Annotations["karpenter.sh/disruption-reason"]; ok {
			reason = disruptionReason
		}

		// Check node conditions for more context
		var nodeConditions []NodeCondition
		for _, condition := range node.Status.Conditions {
			nodeConditions = append(nodeConditions, NodeCondition{
				Type:    string(condition.Type),
				Status:  string(condition.Status),
				Reason:  condition.Reason,
				Message: condition.Message,
			})
			if condition.Type == corev1.NodeReady && condition.Status == corev1.ConditionFalse {
				if strings.Contains(condition.Reason, "Kubelet") {
					if reason == "Terminating" {
						reason = "Terminating"
						message = condition.Message
					}
				}
			}
		}

		// Extract resource information from node
		resourceCapacity := ResourceInfo{}
		resourceAllocatable := ResourceInfo{}
		if cpu, ok := node.Status.Capacity[corev1.ResourceCPU]; ok {
			resourceCapacity.CPU = cpu.String()
		}
		if memory, ok := node.Status.Capacity[corev1.ResourceMemory]; ok {
			resourceCapacity.Memory = memory.String()
		}
		if cpu, ok := node.Status.Allocatable[corev1.ResourceCPU]; ok {
			resourceAllocatable.CPU = cpu.String()
		}
		if memory, ok := node.Status.Allocatable[corev1.ResourceMemory]; ok {
			resourceAllocatable.Memory = memory.String()
		}

		// Check if it's a Karpenter node
		if nodePool == "" {
			// Might still be a Karpenter node, check other labels
			if _, ok := node.Labels["karpenter.sh/nodepool"]; !ok {
				// Check if it has Karpenter instance type label
				if instanceType != "" {
					nodePool = "unknown" // Karpenter node but no nodepool label
				} else {
					continue // Not a Karpenter node, skip
				}
			}
		}

		disruption := &NodeDisruptionInfo{
			NodeName:            node.Name,
			NodePool:            nodePool,
			InstanceType:        instanceType,
			Reason:              reason,
			Message:             message,
			FirstSeen:           node.DeletionTimestamp.Format(time.RFC3339),
			LastSeen:            node.DeletionTimestamp.Format(time.RFC3339),
			EventCount:          1,
			Labels:              node.Labels,
			Annotations:         node.Annotations,
			NodeStillExists:     true,
			IsBlocked:           true, // If node has DeletionTimestamp but still exists, it's blocked
			BlockingReason:      "Node marked for deletion but still exists",
			NodeConditions:      nodeConditions,
			ResourceCapacity:    resourceCapacity,
			ResourceAllocatable: resourceAllocatable,
			CreationTime:        node.CreationTimestamp.Format(time.RFC3339),
			DeletionTime:        node.DeletionTimestamp.Format(time.RFC3339),
		}

		// Get pods currently running on this node
		pods, err := c.getPodsOnNode(ctx, node.Name)
		if err == nil {
			disruption.AffectedPods = pods
		}

		// Check for PDBs and pod eviction issues
		c.checkBlockingConstraints(ctx, disruption, &node)

		disruptions = append(disruptions, *disruption)
	}

	// Also check for recent Karpenter events to catch nodes that might have been disrupted
	// but are no longer in the cluster (already deleted)
	events, err := c.clientset.CoreV1().Events("").List(ctx, metav1.ListOptions{
		FieldSelector: "involvedObject.kind=Node",
	})
	if err == nil {
		// Calculate time window for events (to catch recently deleted nodes)
		sinceTime := metav1.NewTime(now.Add(-time.Duration(sinceHours) * time.Hour))

		// Track nodes we've already seen
		seenNodes := make(map[string]bool)
		for _, d := range disruptions {
			seenNodes[d.NodeName] = true
		}

		// Look for Karpenter disruption events for nodes we haven't seen yet
		for _, event := range events.Items {
			if event.FirstTimestamp.Before(&sinceTime) {
				continue
			}

			// Check if this is a Karpenter disruption event
			isKarpenterEvent := false
			if event.Source.Component == "karpenter" ||
				strings.Contains(event.Source.Component, "karpenter") ||
				strings.Contains(event.Reason, "Terminating") ||
				strings.Contains(event.Reason, "Disrupting") ||
				strings.Contains(event.Reason, "Consolidating") {
				isKarpenterEvent = true
			}

			if !isKarpenterEvent {
				continue
			}

			nodeName := event.InvolvedObject.Name
			if nodeName == "" || seenNodes[nodeName] {
				continue
			}

			// Check if node still exists
			_, err := c.clientset.CoreV1().Nodes().Get(ctx, nodeName, metav1.GetOptions{})
			if err != nil {
				// Node was deleted - this is a completed disruption
				// Try to get more details from the event
				reason := event.Reason
				message := event.Message

				// Extract disruption reason from event message if available
				messageLower := strings.ToLower(message)
				if strings.Contains(messageLower, "consolidat") {
					reason = "Consolidation"
				} else if strings.Contains(messageLower, "expir") || strings.Contains(messageLower, "drift") {
					reason = "Expiration"
				} else if strings.Contains(messageLower, "terminat") || strings.Contains(messageLower, "delet") {
					reason = "Termination"
				}

				disruption := &NodeDisruptionInfo{
					NodeName:        nodeName,
					Reason:          reason,
					Message:         message,
					FirstSeen:       event.FirstTimestamp.Format(time.RFC3339),
					LastSeen:        event.LastTimestamp.Format(time.RFC3339),
					EventCount:      1,
					Labels:          make(map[string]string),
					Annotations:     make(map[string]string),
					NodeStillExists: false,
				}
				disruptions = append(disruptions, *disruption)
				seenNodes[nodeName] = true
			}
		}
	}

	// Sort: blocked disruptions first, then by deletion timestamp (most recent first)
	sort.Slice(disruptions, func(i, j int) bool {
		if disruptions[i].IsBlocked && !disruptions[j].IsBlocked {
			return true
		}
		if !disruptions[i].IsBlocked && disruptions[j].IsBlocked {
			return false
		}
		// Both blocked or both not blocked - sort by timestamp
		iTime := parseTime(disruptions[i].LastSeen)
		jTime := parseTime(disruptions[j].LastSeen)
		return iTime.After(jTime)
	})

	return disruptions, nil
}

// checkBlockingConstraints checks for PDBs and other constraints blocking node deletion
func (c *Client) checkBlockingConstraints(ctx context.Context, disruption *NodeDisruptionInfo, node *corev1.Node) {
	// Get pods on this node
	pods, err := c.getPodsOnNode(ctx, disruption.NodeName)
	if err != nil {
		return
	}

	// Get all Pod Disruption Budgets
	pdbs, err := c.clientset.PolicyV1().PodDisruptionBudgets("").List(ctx, metav1.ListOptions{})
	if err != nil {
		// PDB API might not be available, continue without PDB checks
		return
	}

	var blockingPDBs []string
	var blockingPods []string

	// Check each pod against PDBs
	for _, podInfo := range pods {
		// Get full pod object
		pod, err := c.clientset.CoreV1().Pods(podInfo.Namespace).Get(ctx, podInfo.Name, metav1.GetOptions{})
		if err != nil {
			continue
		}

		// Check if pod has eviction issues
		hasEvictionIssue := false
		for _, condition := range pod.Status.Conditions {
			if condition.Type == corev1.PodScheduled && condition.Status == corev1.ConditionFalse {
				if strings.Contains(condition.Reason, "Unschedulable") || strings.Contains(condition.Message, "disruption") {
					hasEvictionIssue = true
				}
			}
		}

		// Check if pod is protected by a PDB
		for _, pdb := range pdbs.Items {
			// Check if PDB matches this pod
			selector, err := metav1.LabelSelectorAsSelector(pdb.Spec.Selector)
			if err != nil {
				continue
			}

			if selector.Matches(labels.Set(pod.Labels)) {
				// Pod is protected by this PDB
				// Check if PDB would block eviction
				if pdb.Status.DisruptionsAllowed == 0 && pdb.Status.CurrentHealthy <= pdb.Status.DesiredHealthy {
					blockingPDBs = append(blockingPDBs, fmt.Sprintf("%s/%s", pdb.Namespace, pdb.Name))
					blockingPods = append(blockingPods, fmt.Sprintf("%s/%s", pod.Namespace, pod.Name))
					hasEvictionIssue = true
				}
			}
		}

		// Check for other blocking conditions
		if pod.DeletionTimestamp != nil && pod.DeletionGracePeriodSeconds != nil {
			// Pod is being deleted but taking too long
			hasEvictionIssue = true
		}

		if hasEvictionIssue && !contains(blockingPods, fmt.Sprintf("%s/%s", pod.Namespace, pod.Name)) {
			blockingPods = append(blockingPods, fmt.Sprintf("%s/%s", pod.Namespace, pod.Name))
		}
	}

	if len(blockingPDBs) > 0 {
		disruption.BlockingPDBs = blockingPDBs
		disruption.BlockingReason = fmt.Sprintf("Blocked by %d PDB(s)", len(blockingPDBs))
		disruption.IsBlocked = true
	}

	if len(blockingPods) > 0 {
		disruption.BlockingPods = blockingPods
		if disruption.BlockingReason == "" {
			disruption.BlockingReason = fmt.Sprintf("Blocked by %d pod(s)", len(blockingPods))
		}
		disruption.IsBlocked = true
	}
}

// contains checks if a string slice contains a value
func contains(slice []string, value string) bool {
	for _, s := range slice {
		if s == value {
			return true
		}
	}
	return false
}

// getPodsOnNode gets pods that were running on a specific node
func (c *Client) getPodsOnNode(ctx context.Context, nodeName string) ([]PodInfo, error) {
	pods, err := c.clientset.CoreV1().Pods("").List(ctx, metav1.ListOptions{
		FieldSelector: fmt.Sprintf("spec.nodeName=%s", nodeName),
	})
	if err != nil {
		return nil, err
	}

	var podInfos []PodInfo
	for _, pod := range pods.Items {
		// Always use the actual pod name - this is critical
		podName := pod.Name
		if podName == "" {
			continue // Skip pods without names (shouldn't happen, but be safe)
		}

		workloadName := podName // Default to pod name
		workloadType := ""

		// Extract workload name from owner references
		for _, owner := range pod.OwnerReferences {
			if owner.Kind == "ReplicaSet" {
				// ReplicaSet name format: workloadname-randomstring
				parts := strings.Split(owner.Name, "-")
				if len(parts) > 1 {
					workloadName = strings.Join(parts[:len(parts)-1], "-")
				} else {
					workloadName = owner.Name
				}
				workloadType = "deployment"
				break // Found workload, stop looking
			} else if owner.Kind == "StatefulSet" {
				// StatefulSet pod name format: workloadname-ordinal
				parts := strings.Split(podName, "-")
				if len(parts) > 1 {
					// Remove the ordinal (last part)
					workloadName = strings.Join(parts[:len(parts)-1], "-")
				}
				workloadType = "statefulset"
				break // Found workload, stop looking
			} else if owner.Kind == "DaemonSet" {
				// For DaemonSet, workload name is same as pod name
				workloadName = podName
				workloadType = "daemonset"
				break // Found workload, stop looking
			}
		}

		// If no owner reference, it's a standalone pod
		if workloadType == "" {
			workloadType = "pod"
		}

		// Ensure namespace is set
		namespace := pod.Namespace
		if namespace == "" {
			namespace = "default"
		}

		// Extract pod phase and status
		phase := string(pod.Status.Phase)
		status := phase
		if len(pod.Status.ContainerStatuses) > 0 {
			// Get status from first container
			containerStatus := pod.Status.ContainerStatuses[0]
			if containerStatus.State.Waiting != nil {
				status = containerStatus.State.Waiting.Reason
			} else if containerStatus.State.Running != nil {
				status = "Running"
			} else if containerStatus.State.Terminated != nil {
				status = containerStatus.State.Terminated.Reason
			}
		}

		// Extract resource requests and limits
		requests := ResourceInfo{}
		limits := ResourceInfo{}
		var cpuRequest, memoryRequest, cpuLimit, memoryLimit resource.Quantity

		for _, container := range pod.Spec.Containers {
			if container.Resources.Requests != nil {
				if cpu, ok := container.Resources.Requests[corev1.ResourceCPU]; ok {
					cpuRequest.Add(cpu)
				}
				if mem, ok := container.Resources.Requests[corev1.ResourceMemory]; ok {
					memoryRequest.Add(mem)
				}
			}
			if container.Resources.Limits != nil {
				if cpu, ok := container.Resources.Limits[corev1.ResourceCPU]; ok {
					cpuLimit.Add(cpu)
				}
				if mem, ok := container.Resources.Limits[corev1.ResourceMemory]; ok {
					memoryLimit.Add(mem)
				}
			}
		}

		if !cpuRequest.IsZero() {
			requests.CPU = cpuRequest.String()
		}
		if !memoryRequest.IsZero() {
			requests.Memory = memoryRequest.String()
		}
		if !cpuLimit.IsZero() {
			limits.CPU = cpuLimit.String()
		}
		if !memoryLimit.IsZero() {
			limits.Memory = memoryLimit.String()
		}

		// Determine QoS class
		qosClass := "BestEffort"
		hasRequests := !cpuRequest.IsZero() || !memoryRequest.IsZero()
		hasLimits := !cpuLimit.IsZero() || !memoryLimit.IsZero()

		if hasRequests && hasLimits {
			// Check if requests == limits for all resources
			cpuEqual := cpuRequest.Equal(cpuLimit) || (cpuRequest.IsZero() && cpuLimit.IsZero())
			memEqual := memoryRequest.Equal(memoryLimit) || (memoryRequest.IsZero() && memoryLimit.IsZero())
			if cpuEqual && memEqual {
				qosClass = "Guaranteed"
			} else {
				qosClass = "Burstable"
			}
		} else if hasRequests {
			qosClass = "Burstable"
		}

		podInfos = append(podInfos, PodInfo{
			Name:         podName,
			Namespace:    namespace,
			NodeName:     pod.Spec.NodeName,
			WorkloadName: workloadName,
			WorkloadType: workloadType,
			Phase:        phase,
			Status:       status,
			Requests:     requests,
			Limits:       limits,
			QOSClass:     qosClass,
		})
	}

	return podInfos, nil
}

// parseTime parses an RFC3339 timestamp string
func parseTime(timeStr string) time.Time {
	t, err := time.Parse(time.RFC3339, timeStr)
	if err != nil {
		return time.Time{}
	}
	return t
}

// sortDisruptionsByTime sorts disruptions by LastSeen time (most recent first)
// Deprecated: Not currently used, kept for potential future use
//nolint:unused // Kept for potential future use
func sortDisruptionsByTime(disruptions []NodeDisruptionInfo) {
	// Simple insertion sort by LastSeen
	for i := 1; i < len(disruptions); i++ {
		key := disruptions[i]
		j := i - 1

		keyTime := parseTime(key.LastSeen)
		for j >= 0 && parseTime(disruptions[j].LastSeen).Before(keyTime) {
			disruptions[j+1] = disruptions[j]
			j--
		}
		disruptions[j+1] = key
	}
}

// GetRecentNodeDeletions gets information about nodes that were recently deleted
func (c *Client) GetRecentNodeDeletions(ctx context.Context, sinceHours int) ([]NodeDisruptionInfo, error) {
	// Get disruption events (which include node deletions)
	disruptions, err := c.GetNodeDisruptions(ctx, sinceHours)
	if err != nil {
		return nil, err
	}

	// Filter for actual deletions/terminations
	var deletions []NodeDisruptionInfo
	for _, disruption := range disruptions {
		// Check if this is a deletion event
		if strings.Contains(strings.ToLower(disruption.Reason), "terminat") ||
			strings.Contains(strings.ToLower(disruption.Reason), "delet") ||
			strings.Contains(strings.ToLower(disruption.Message), "terminat") ||
			strings.Contains(strings.ToLower(disruption.Message), "delet") ||
			strings.Contains(strings.ToLower(disruption.Message), "remov") {
			deletions = append(deletions, disruption)
		}
	}

	return deletions, nil
}
