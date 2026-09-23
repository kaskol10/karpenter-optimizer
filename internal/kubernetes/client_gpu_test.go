package kubernetes

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	discoveryfake "k8s.io/client-go/discovery/fake"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
)

// newTestDiscoveryClient returns a fake discovery client that advertises the
// Karpenter NodePool resource (or none, when withKarpenter is false).
func newTestDiscoveryClient(t *testing.T, withKarpenter bool) *discoveryfake.FakeDiscovery {
	t.Helper()
	fd := &discoveryfake.FakeDiscovery{
		Fake: &k8stesting.Fake{},
	}
	if withKarpenter {
		fd.Resources = []*metav1.APIResourceList{{
			GroupVersion: "karpenter.sh/v1",
			APIResources: []metav1.APIResource{
				{Name: "nodepools", Namespaced: false, Kind: "NodePool"},
			},
		}}
	}
	return fd
}

func TestHasKarpenter(t *testing.T) {
	t.Parallel()

	t.Run("detected when nodepools resource exists", func(t *testing.T) {
		t.Parallel()
		c := &Client{discoveryClient: newTestDiscoveryClient(t, true)}
		if !c.HasKarpenter(context.Background()) {
			t.Fatal("expected HasKarpenter to report true")
		}
	})

	t.Run("not detected when karpenter API absent", func(t *testing.T) {
		t.Parallel()
		c := &Client{discoveryClient: newTestDiscoveryClient(t, false)}
		if c.HasKarpenter(context.Background()) {
			t.Fatal("expected HasKarpenter to report false")
		}
	})

	t.Run("result is cached after first call", func(t *testing.T) {
		t.Parallel()
		c := &Client{discoveryClient: newTestDiscoveryClient(t, true)}
		if !c.HasKarpenter(context.Background()) {
			t.Fatal("expected HasKarpenter to report true on first call")
		}
		// Replace discovery client with one that has no Karpenter; the cached
		// result should still be reported.
		c.discoveryClient = newTestDiscoveryClient(t, false)
		if !c.HasKarpenter(context.Background()) {
			t.Fatal("expected cached HasKarpenter result to be reused")
		}
		if !c.KarpenterChecked() {
			t.Fatal("expected KarpenterChecked to be true")
		}
	})
}

// gpuNode builds a core v1 Node with the given GPU capacity and model label.
func gpuNode(name string, gpu int64, model string) *corev1.Node {
	n := &corev1.Node{
		ObjectMeta: metav1.ObjectMeta{Name: name},
		Status: corev1.NodeStatus{
			Capacity:    corev1.ResourceList{},
			Allocatable: corev1.ResourceList{},
		},
	}
	n.Status.Capacity[corev1.ResourceName("nvidia.com/gpu")] = *resource.NewQuantity(gpu, resource.BinarySI)
	n.Status.Allocatable[corev1.ResourceName("nvidia.com/gpu")] = *resource.NewQuantity(gpu, resource.BinarySI)
	if model != "" {
		n.Labels = map[string]string{"nvidia.com/gpu.product": model}
	}
	return n
}

// gpuPod builds a pod with a single container requesting the given number of GPUs.
func gpuPod(nodeName string, gpu int64) *corev1.Pod {
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "gpu-pod", Namespace: "default"},
		Spec: corev1.PodSpec{
			NodeName: nodeName,
			Containers: []corev1.Container{{
				Name: "main",
				Resources: corev1.ResourceRequirements{
					Requests: corev1.ResourceList{
						corev1.ResourceName("nvidia.com/gpu"): *resource.NewQuantity(gpu, resource.BinarySI),
					},
				},
			}},
		},
	}
}

func TestGetAllNodesWithUsageGPU(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name               string
		node               *corev1.Node
		pods               []runtime.Object
		wantCapacity       float64
		wantAllocated      float64
		wantModel          string
		wantGPUCapacitySet bool // whether GPUCapacity/GPUAllocated should be non-zero
	}{
		{
			name:               "zero-GPU node has no GPU fields",
			node:               &corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: "cpu-node"}},
			pods:               []runtime.Object{},
			wantCapacity:       0,
			wantAllocated:      0,
			wantModel:          "",
			wantGPUCapacitySet: false,
		},
		{
			name:               "integer GPU with model label",
			node:               gpuNode("a100-node", 4, "NVIDIA A100-SXM4-80GB"),
			pods:               []runtime.Object{gpuPod("a100-node", 2)},
			wantCapacity:       4,
			wantAllocated:      2,
			wantModel:          "NVIDIA A100-SXM4-80GB",
			wantGPUCapacitySet: true,
		},
		{
			name:               "fractional GPU request",
			node:               gpuNode("t4-node", 2, "NVIDIA T4"),
			pods:               []runtime.Object{gpuPod("t4-node", 1)},
			wantCapacity:       2,
			wantAllocated:      1,
			wantModel:          "NVIDIA T4",
			wantGPUCapacitySet: true,
		},
		{
			name:               "missing model label reports empty model",
			node:               gpuNode("mystery-node", 1, ""),
			pods:               []runtime.Object{},
			wantCapacity:       1,
			wantAllocated:      0,
			wantModel:          "",
			wantGPUCapacitySet: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			objects := []runtime.Object{tc.node}
			objects = append(objects, tc.pods...)
			clientset := fake.NewClientset(objects...)
			c := &Client{clientset: clientset, debug: false}

			nodes, err := c.GetAllNodesWithUsage(context.Background())
			if err != nil {
				t.Fatalf("GetAllNodesWithUsage() error = %v", err)
			}
			if len(nodes) != 1 {
				t.Fatalf("expected 1 node, got %d", len(nodes))
			}
			n := nodes[0]
			if n.GPUCapacity != tc.wantCapacity {
				t.Errorf("GPUCapacity = %v, want %v", n.GPUCapacity, tc.wantCapacity)
			}
			if n.GPUAllocated != tc.wantAllocated {
				t.Errorf("GPUAllocated = %v, want %v", n.GPUAllocated, tc.wantAllocated)
			}
			if n.GPUModel != tc.wantModel {
				t.Errorf("GPUModel = %q, want %q", n.GPUModel, tc.wantModel)
			}
			if tc.wantGPUCapacitySet && n.GPUCapacity == 0 {
				t.Error("expected GPU capacity to be reported for GPU node")
			}
		})
	}
}

func TestGetPodsOnNodesGPURequested(t *testing.T) {
	t.Parallel()

	node := &corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: "gpu-node"}}
	objects := []runtime.Object{
		node,
		gpuPod("gpu-node", 3),
		&corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{Name: "cpu-pod", Namespace: "default"},
			Spec:       corev1.PodSpec{NodeName: "gpu-node"},
		},
	}
	clientset := fake.NewClientset(objects...)
	c := &Client{clientset: clientset, debug: false}

	pods, err := c.GetPodsOnNodes(context.Background(), map[string]bool{"gpu-node": true})
	if err != nil {
		t.Fatalf("GetPodsOnNodes() error = %v", err)
	}
	if len(pods) != 2 {
		t.Fatalf("expected 2 pods, got %d", len(pods))
	}

	var sawGPU, sawZero bool
	for _, p := range pods {
		switch p.Name {
		case "gpu-pod":
			sawGPU = true
			if p.GPURequested != 3 {
				t.Errorf("gpu-pod GPURequested = %v, want 3", p.GPURequested)
			}
		case "cpu-pod":
			sawZero = true
			if p.GPURequested != 0 {
				t.Errorf("cpu-pod GPURequested = %v, want 0", p.GPURequested)
			}
		}
	}
	if !sawGPU {
		t.Error("expected to find gpu-pod in results")
	}
	if !sawZero {
		t.Error("expected to find cpu-pod in results")
	}
}
