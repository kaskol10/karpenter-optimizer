package kubernetes

import (
	"context"
	"strconv"
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

// hamilNode builds a node whose capacity reports an inflated (MIG/time-slicing)
// GPU count, but whose nvidia.com/gpu.count label reports the physical count,
// plus per-GPU memory label (MiB).
func hamilNode(name string, labelCount int64, capacityCount int64, perGPUMemMiB, capacityMemMiB int64, model string) *corev1.Node {
	n := gpuNode(name, capacityCount, model)
	n.Labels["nvidia.com/gpu.count"] = strconv.FormatInt(labelCount, 10)
	if perGPUMemMiB > 0 {
		n.Labels["nvidia.com/gpu.memory"] = strconv.FormatInt(perGPUMemMiB, 10)
	}
	if capacityMemMiB > 0 {
		n.Status.Capacity[corev1.ResourceName("nvidia.com/gpumem")] = *resource.NewQuantity(capacityMemMiB, resource.BinarySI)
	}
	return n
}

// gpuPod builds a pod with the given name and a single container requesting the
// given number of GPUs.
func gpuPod(podName, nodeName string, gpu int64) *corev1.Pod {
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: podName, Namespace: "default"},
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

// gpuMemPod builds a pod requesting the given number of GPUs plus an explicit
// nvidia.com/gpumem (MiB) request, as HAMi vGPU pods do.
func gpuMemPod(podName, nodeName string, gpu, memMiB int64) *corev1.Pod {
	p := gpuPod(podName, nodeName, gpu)
	p.Spec.Containers[0].Resources.Requests[corev1.ResourceName("nvidia.com/gpumem")] = *resource.NewQuantity(memMiB, resource.BinarySI)
	return p
}

// hamiAnnotatedPod builds a pod requesting one GPU, carrying the HAMi
// vgpu-devices-allocated annotation (the vLLM sample from the design).
func hamiAnnotatedPod(podName, nodeName string) *corev1.Pod {
	p := gpuPod(podName, nodeName, 1)
	p.Annotations = map[string]string{
		"hami.io/vgpu-devices-allocated": ";GPU-b3d6e634-2050-5cca-daf2-1777c4e3ed51,NVIDIA,45000,0:;",
	}
	return p
}

func TestParseHamiVGPUDevices(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		ann  string
		want []GPUDevice
	}{
		{name: "empty annotation", ann: "", want: nil},
		{
			name: "single device vLLM sample",
			ann:  ";GPU-b3d6e634-2050-5cca-daf2-1777c4e3ed51,NVIDIA,45000,0:;",
			want: []GPUDevice{{UUID: "GPU-b3d6e634-2050-5cca-daf2-1777c4e3ed51", Model: "NVIDIA", MemoryMiB: 45000, Index: 0}},
		},
		{
			name: "two devices",
			ann:  ";GPU-a,NVIDIA,45000,0:;GPU-b,NVIDIA,41000,1:;",
			want: []GPUDevice{
				{UUID: "GPU-a", Model: "NVIDIA", MemoryMiB: 45000, Index: 0},
				{UUID: "GPU-b", Model: "NVIDIA", MemoryMiB: 41000, Index: 1},
			},
		},
		{name: "malformed entries skipped", ann: ";bad,MODEL,notanumber,0:;GPU-c,NVIDIA,100,0:;", want: []GPUDevice{{UUID: "GPU-c", Model: "NVIDIA", MemoryMiB: 100}}},
		{name: "no trailing colon", ann: "GPU-d,NVIDIA,1024,2", want: []GPUDevice{{UUID: "GPU-d", Model: "NVIDIA", MemoryMiB: 1024, Index: 2}}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := parseHamiVGPUDevices(tc.ann)
			if len(got) != len(tc.want) {
				t.Fatalf("got %d devices, want %d: %+v", len(got), len(tc.want), got)
			}
			for i := range tc.want {
				if got[i] != tc.want[i] {
					t.Errorf("device[%d] = %+v, want %+v", i, got[i], tc.want[i])
				}
			}
		})
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
		wantMemTotalMiB    float64
		wantMemAllocMiB    float64
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
			pods:               []runtime.Object{gpuPod("gpu-pod", "a100-node", 2)},
			wantCapacity:       4,
			wantAllocated:      2,
			wantModel:          "NVIDIA A100-SXM4-80GB",
			wantGPUCapacitySet: true,
		},
		{
			name:               "fractional GPU request",
			node:               gpuNode("t4-node", 2, "NVIDIA T4"),
			pods:               []runtime.Object{gpuPod("gpu-pod", "t4-node", 1)},
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
		{
			// Label reports the physical count (2) while capacity is inflated (20,
			// e.g. MIG/time-slicing). Label must win. Memory = 2 x 95830 MiB.
			name:               "gpu.count label wins over inflated capacity",
			node:               hamilNode("mig-node", 2, 20, 95830, 0, "NVIDIA A100-SXM4-80GB"),
			pods:               []runtime.Object{},
			wantCapacity:       2,
			wantAllocated:      0,
			wantModel:          "NVIDIA A100-SXM4-80GB",
			wantMemTotalMiB:    2 * 95830,
			wantGPUCapacitySet: true,
		},
		{
			// HAMi vGPU: pod requests nvidia.com/gpu:1 + nvidia.com/gpumem:45k.
			// Count allocation = 1; memory allocation = 45000 MiB.
			name:               "hami gpumem request drives memory allocation",
			node:               hamilNode("hami-node", 2, 2, 95830, 0, "NVIDIA A100-SXM4-80GB"),
			pods:               []runtime.Object{gpuMemPod("gpu-pod", "hami-node", 1, 45000)},
			wantCapacity:       2,
			wantAllocated:      1,
			wantModel:          "NVIDIA A100-SXM4-80GB",
			wantMemTotalMiB:    2 * 95830,
			wantMemAllocMiB:    45000,
			wantGPUCapacitySet: true,
		},
		{
			// hami annotation overrides the request-based memory estimate.
			name:               "hami annotation actuals override request",
			node:               hamilNode("vllm-node", 2, 2, 95830, 0, "NVIDIA A100-SXM4-80GB"),
			pods:               []runtime.Object{hamiAnnotatedPod("gpu-pod", "vllm-node")},
			wantCapacity:       2,
			wantAllocated:      1,
			wantModel:          "NVIDIA A100-SXM4-80GB",
			wantMemTotalMiB:    2 * 95830,
			wantMemAllocMiB:    45000,
			wantGPUCapacitySet: true,
		},
		{
			// Whole-GPU claim without gpumem: memory = gpu_count x per-GPU memory.
			name:               "whole-GPU claim uses per-GPU memory",
			node:               gpuNode("whole-node", 4, "NVIDIA A100-SXM4-80GB"),
			pods:               []runtime.Object{gpuPod("gpu-pod", "whole-node", 2)},
			wantCapacity:       4,
			wantAllocated:      2,
			wantModel:          "NVIDIA A100-SXM4-80GB",
			wantGPUCapacitySet: true,
			// No memory label => memory unknown, so claim stays 0.
		},
		{
			// Whole-GPU claim with known per-GPU memory (2 x 95830 / 2 = 95830 per GPU).
			name:               "whole-GPU claim with known per-GPU memory",
			node:               hamilNode("whole-mem-node", 2, 2, 95830, 0, "NVIDIA A100-SXM4-80GB"),
			pods:               []runtime.Object{gpuPod("gpu-pod", "whole-mem-node", 2)},
			wantCapacity:       2,
			wantAllocated:      2,
			wantModel:          "NVIDIA A100-SXM4-80GB",
			wantMemTotalMiB:    2 * 95830,
			wantMemAllocMiB:    2 * 95830,
			wantGPUCapacitySet: true,
		},
		{
			// Node total memory from nvidia.com/gpumem capacity when no per-GPU label.
			name:               "node memory from gpumem capacity fallback",
			node:               hamilNode("gpumem-node", 2, 2, 0, 200000, "NVIDIA A100-SXM4-80GB"),
			pods:               []runtime.Object{gpuPod("gpu-pod", "gpumem-node", 1)},
			wantCapacity:       2,
			wantAllocated:      1,
			wantModel:          "NVIDIA A100-SXM4-80GB",
			wantMemTotalMiB:    200000,
			wantMemAllocMiB:    100000, // 1 x (200000/2)
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
			if n.GPUMemTotalMiB != tc.wantMemTotalMiB {
				t.Errorf("GPUMemTotalMiB = %v, want %v", n.GPUMemTotalMiB, tc.wantMemTotalMiB)
			}
			if n.GPUMemAllocatedMiB != tc.wantMemAllocMiB {
				t.Errorf("GPUMemAllocatedMiB = %v, want %v", n.GPUMemAllocatedMiB, tc.wantMemAllocMiB)
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
		gpuPod("gpu-pod", "gpu-node", 3),
		gpuMemPod("gpu-pod-2", "gpu-node", 1, 45000),
		hamiAnnotatedPod("gpu-pod-3", "gpu-node"),
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
	if len(pods) != 4 {
		t.Fatalf("expected 4 pods, got %d", len(pods))
	}

	var sawGPU, sawGPUMem, sawHami, sawZero bool
	for _, p := range pods {
		switch p.Name {
		case "gpu-pod":
			sawGPU = true
			if p.GPURequested != 3 {
				t.Errorf("gpu-pod GPURequested = %v, want 3", p.GPURequested)
			}
			if p.GPUMemRequestMiB != 0 {
				t.Errorf("gpu-pod GPUMemRequestMiB = %v, want 0", p.GPUMemRequestMiB)
			}
		case "gpu-pod-2":
			sawGPUMem = true
			if p.GPURequested != 1 {
				t.Errorf("gpu-pod-2 GPURequested = %v, want 1", p.GPURequested)
			}
			if p.GPUMemRequestMiB != 45000 {
				t.Errorf("gpu-pod-2 GPUMemRequestMiB = %v, want 45000", p.GPUMemRequestMiB)
			}
		case "gpu-pod-3":
			sawHami = true
			if p.GPURequested != 1 {
				t.Errorf("gpu-pod-3 GPURequested = %v, want 1", p.GPURequested)
			}
			if len(p.GPUDevices) != 1 {
				t.Fatalf("gpu-pod-3 GPUDevices = %+v, want 1 device", p.GPUDevices)
			}
			if p.GPUDevices[0].MemoryMiB != 45000 || p.GPUDevices[0].Index != 0 {
				t.Errorf("gpu-pod-3 GPUDevices[0] = %+v, want MemoryMiB=45000 Index=0", p.GPUDevices[0])
			}
			if got := p.GPUDeviceMemoryMiB(); got != 45000 {
				t.Errorf("gpu-pod-3 GPUDeviceMemoryMiB() = %v, want 45000", got)
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
	if !sawGPUMem {
		t.Error("expected to find gpu-pod-2 in results")
	}
	if !sawHami {
		t.Error("expected to find gpu-pod-3 in results")
	}
	if !sawZero {
		t.Error("expected to find cpu-pod in results")
	}
}
