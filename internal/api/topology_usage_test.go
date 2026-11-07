package api

import (
	"testing"

	"github.com/karpenter-optimizer/internal/config"
	"github.com/karpenter-optimizer/internal/kubernetes"
	"github.com/karpenter-optimizer/internal/usage"
	"k8s.io/client-go/kubernetes/fake"
)

func TestAttachTopologyUsage(t *testing.T) {
	t.Parallel()

	nodes := []TopologyNode{{Name: "n1", Pods: []TopologyPod{
		{Namespace: "prod", Name: "web-1"},
		{Namespace: "prod", Name: "web-2"},
	}}}

	// No source: untouched.
	attachTopologyUsage(nodes, nil)
	if nodes[0].Pods[0].Usage != nil {
		t.Fatal("usage attached without a snapshot")
	}

	snap := &usage.Snapshot{Pods: map[string]usage.PodUsage{"prod/web-1": {CPUCores: 0.3, MemoryGiB: 1}}}
	attachTopologyUsage(nodes, snap)
	if u := nodes[0].Pods[0].Usage; u == nil || u.CPUCores != 0.3 || u.MemoryGiB != 1 {
		t.Errorf("web-1 usage = %+v", u)
	}
	if nodes[0].Pods[1].Usage != nil {
		t.Errorf("web-2 has no metrics but got %+v", nodes[0].Pods[1].Usage)
	}
}

func TestGPUUsageOf(t *testing.T) {
	t.Parallel()
	if gpuUsageOf(nil) != nil || gpuUsageOf(&usage.Snapshot{}) != nil {
		t.Error("expected nil without GPU usage")
	}
	if got := gpuUsageOf(&usage.Snapshot{GPUs: map[string]float64{"GPU-a": 31000}}); got["GPU-a"] != 31000 {
		t.Errorf("gpuUsageOf = %v", got)
	}
}

func TestNewUsageCollector(t *testing.T) {
	t.Parallel()
	if newUsageCollector(&config.Config{}, nil) != nil {
		t.Error("expected no collector without a Kubernetes client")
	}
	k8s := kubernetes.NewClientWithClientset(fake.NewClientset())
	c := newUsageCollector(&config.Config{PrometheusURL: "http://127.0.0.1:0"}, k8s)
	if c == nil {
		t.Fatal("expected a collector")
	}
	// Prometheus is unreachable and the fake clientset has no REST
	// transport, so there is no usage, and that is not an error.
	if snap := c.Get(t.Context()); snap != nil {
		t.Errorf("Get() = %+v, want nil", snap)
	}
}
