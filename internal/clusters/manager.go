package clusters

import (
	"context"
	"fmt"
	"os"
	"sync"

	"github.com/karpenter-optimizer/internal/kubernetes"
)

type Cluster struct {
	Name       string `json:"name"`
	Kubeconfig string `json:"kubeconfig,omitempty"`
	Context    string `json:"context,omitempty"`
	Endpoint   string `json:"endpoint,omitempty"`
	IsActive   bool   `json:"isActive"`
}

type ClusterManager struct {
	clusters map[string]*ClusterConfig
	mu       sync.RWMutex
}

type ClusterConfig struct {
	Cluster   *Cluster
	K8sClient *kubernetes.Client
}

func NewClusterManager() *ClusterManager {
	return &ClusterManager{
		clusters: make(map[string]*ClusterConfig),
	}
}

func (m *ClusterManager) AddCluster(cluster *Cluster) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if cluster.Name == "" {
		return fmt.Errorf("cluster name is required")
	}

	if _, exists := m.clusters[cluster.Name]; exists {
		return fmt.Errorf("cluster %s already exists", cluster.Name)
	}

	var k8sClient *kubernetes.Client
	var err error

	if cluster.Kubeconfig != "" {
		k8sClient, err = kubernetes.NewClientWithDebug(cluster.Kubeconfig, cluster.Context, false)
	} else {
		k8sClient, err = kubernetes.NewClientWithDebug("", cluster.Context, false)
	}

	if err != nil {
		return fmt.Errorf("failed to create Kubernetes client for cluster %s: %w", cluster.Name, err)
	}

	m.clusters[cluster.Name] = &ClusterConfig{
		Cluster:   cluster,
		K8sClient: k8sClient,
	}

	return nil
}

func (m *ClusterManager) RemoveCluster(name string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if _, exists := m.clusters[name]; !exists {
		return fmt.Errorf("cluster %s not found", name)
	}

	delete(m.clusters, name)
	return nil
}

func (m *ClusterManager) GetCluster(name string) (*Cluster, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	config, exists := m.clusters[name]
	if !exists {
		return nil, fmt.Errorf("cluster %s not found", name)
	}

	return config.Cluster, nil
}

func (m *ClusterManager) ListClusters() []*Cluster {
	m.mu.RLock()
	defer m.mu.RUnlock()

	clusters := make([]*Cluster, 0, len(m.clusters))
	for _, config := range m.clusters {
		clusters = append(clusters, config.Cluster)
	}

	return clusters
}

func (m *ClusterManager) GetClient(name string) (*kubernetes.Client, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	config, exists := m.clusters[name]
	if !exists {
		return nil, fmt.Errorf("cluster %s not found", name)
	}

	return config.K8sClient, nil
}

func (m *ClusterManager) GetActiveCluster() (*Cluster, *kubernetes.Client, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	for _, config := range m.clusters {
		if config.Cluster.IsActive {
			return config.Cluster, config.K8sClient, nil
		}
	}

	return nil, nil, fmt.Errorf("no active cluster configured")
}

func (m *ClusterManager) SetActiveCluster(name string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	if _, exists := m.clusters[name]; !exists {
		return fmt.Errorf("cluster %s not found", name)
	}

	for _, config := range m.clusters {
		config.Cluster.IsActive = (config.Cluster.Name == name)
	}

	return nil
}

func (m *ClusterManager) HealthCheck(ctx context.Context, name string) (string, error) {
	m.mu.RLock()
	config, exists := m.clusters[name]
	m.mu.RUnlock()

	if !exists {
		return "unknown", fmt.Errorf("cluster %s not found", name)
	}

	_, err := config.K8sClient.ListNodePools(ctx)
	if err != nil {
		return "unhealthy", err
	}

	return "healthy", nil
}

func LoadClustersFromEnv() ([]*Cluster, error) {
	clusters := []*Cluster{}

	clustersEnv := os.Getenv("MULTI_CLUSTER_CONFIG")
	if clustersEnv == "" {
		return clusters, nil
	}

	// Format: cluster1:kubeconfig1:context1,cluster2:kubeconfig2:context2
	// Or simpler: cluster1,cluster2 (uses default kubeconfig)

	return clusters, nil
}
