package kubernetes

import (
	"context"
	"errors"
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
)

// llmPod builds a running vLLM serving pod (matches the llmImageMarkers on
// container image) with an optional HAMi vgpu annotation.
func llmPod(name, nodeName string, annotations map[string]string) *corev1.Pod {
	p := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "prod", Annotations: annotations},
		Spec: corev1.PodSpec{
			NodeName: nodeName,
			Containers: []corev1.Container{{
				Name:  "main",
				Image: "vllm/vllm-openai:latest",
				Ports: []corev1.ContainerPort{{ContainerPort: 8000}},
			}},
		},
		Status: corev1.PodStatus{Phase: corev1.PodRunning, PodIP: "10.0.0.5"},
	}
	return p
}

func TestFindLLMPodsGPUDevices(t *testing.T) {
	t.Parallel()

	hami := map[string]string{
		"hami.io/vgpu-devices-allocated": ";GPU-b3d6e634-2050-5cca-daf2-1777c4e3ed51,NVIDIA,45000,0:;GPU-a1a2a3a4-1111-2222-3333-444444444444,NVIDIA,41000,1:;",
	}

	// #given: one HAMi-annotated vLLM pod, one plain vLLM pod, one non-LLM pod
	objects := []runtime.Object{
		llmPod("vllm-hami", "node-1", hami),
		llmPod("vllm-plain", "node-1", nil),
		&corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{Name: "nginx", Namespace: "prod"},
			Spec: corev1.PodSpec{
				Containers: []corev1.Container{{Name: "main", Image: "nginx:latest"}},
			},
			Status: corev1.PodStatus{Phase: corev1.PodRunning, PodIP: "10.0.0.9"},
		},
	}
	clientset := fake.NewClientset(objects...)
	c := &Client{clientset: clientset, debug: false}

	// #when
	pods, err := c.FindLLMPods(context.Background())
	if err != nil {
		t.Fatalf("FindLLMPods() error = %v", err)
	}

	// #then: only the two vLLM pods are discovered
	if len(pods) != 2 {
		t.Fatalf("expected 2 LLM pods, got %d: %+v", len(pods), pods)
	}

	byName := map[string]LLMPodInfo{}
	for _, p := range pods {
		byName[p.Name] = p
	}

	hamiPod, ok := byName["vllm-hami"]
	if !ok {
		t.Fatal("expected to find vllm-hami")
	}
	if len(hamiPod.GPUDevices) != 2 {
		t.Fatalf("vllm-hami GPUDevices = %+v, want 2 devices", hamiPod.GPUDevices)
	}
	if hamiPod.GPUDevices[0].UUID != "GPU-b3d6e634-2050-5cca-daf2-1777c4e3ed51" ||
		hamiPod.GPUDevices[0].MemoryMiB != 45000 || hamiPod.GPUDevices[0].Index != 0 {
		t.Errorf("vllm-hami GPUDevices[0] = %+v, want UUID=GPU-b3d6... Mem=45000 Index=0", hamiPod.GPUDevices[0])
	}
	if hamiPod.GPUDevices[1].UUID != "GPU-a1a2a3a4-1111-2222-3333-444444444444" ||
		hamiPod.GPUDevices[1].MemoryMiB != 41000 || hamiPod.GPUDevices[1].Index != 1 {
		t.Errorf("vllm-hami GPUDevices[1] = %+v, want UUID=GPU-a1a2... Mem=41000 Index=1", hamiPod.GPUDevices[1])
	}

	plainPod, ok := byName["vllm-plain"]
	if !ok {
		t.Fatal("expected to find vllm-plain")
	}
	if len(plainPod.GPUDevices) != 0 {
		t.Errorf("vllm-plain GPUDevices = %+v, want none (no HAMi annotation)", plainPod.GPUDevices)
	}
}

func TestGetNodePlacementHostname(t *testing.T) {
	t.Parallel()

	// #given: a node named "k3s" carrying kubernetes.io/hostname=empathy1,
	// and a node with no hostname label (must fall back to its name).
	objects := []runtime.Object{
		&corev1.Node{ObjectMeta: metav1.ObjectMeta{
			Name:   "k3s",
			Labels: map[string]string{"kubernetes.io/hostname": "empathy1"},
		}},
		&corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: "worker-a"}},
	}
	clientset := fake.NewClientset(objects...)
	c := &Client{clientset: clientset, debug: false}

	// #when
	placements, err := c.GetNodePlacement(context.Background(), []string{"k3s", "worker-a"})
	if err != nil {
		t.Fatalf("GetNodePlacement() error = %v", err)
	}

	// #then
	k3s, ok := placements["k3s"]
	if !ok {
		t.Fatal("expected placement for node k3s")
	}
	if k3s.NodeName != "k3s" {
		t.Errorf("k3s NodeName = %q, want k3s", k3s.NodeName)
	}
	if k3s.Hostname != "empathy1" {
		t.Errorf("k3s Hostname = %q, want empathy1 (from kubernetes.io/hostname)", k3s.Hostname)
	}

	workerA, ok := placements["worker-a"]
	if !ok {
		t.Fatal("expected placement for node worker-a")
	}
	if workerA.Hostname != "worker-a" {
		t.Errorf("worker-a Hostname = %q, want worker-a (fallback to node name)", workerA.Hostname)
	}
}

func TestFindLLMPodsGPURequested(t *testing.T) {
	t.Parallel()

	// #given: one pod with a GPU limit on two containers, one with only a
	// request, one with no GPU
	withGPU := func(name string, limits, requests int64, containers int) *corev1.Pod {
		p := llmPod(name, "node-1", nil)
		for i := 1; i < containers; i++ {
			p.Spec.Containers = append(p.Spec.Containers, corev1.Container{Name: "side", Image: "busybox"})
		}
		gpu := corev1.ResourceName("nvidia.com/gpu")
		for i := range p.Spec.Containers {
			p.Spec.Containers[i].Resources = corev1.ResourceRequirements{Limits: corev1.ResourceList{}, Requests: corev1.ResourceList{}}
			if limits > 0 {
				p.Spec.Containers[i].Resources.Limits[gpu] = *resource.NewQuantity(limits, resource.DecimalSI)
			}
			if requests > 0 {
				p.Spec.Containers[i].Resources.Requests[gpu] = *resource.NewQuantity(requests, resource.DecimalSI)
			}
		}
		return p
	}
	c := &Client{clientset: fake.NewClientset(
		withGPU("two-containers", 2, 0, 2),
		withGPU("request-only", 0, 1, 1),
		withGPU("no-gpu", 0, 0, 1),
	)}

	// #when
	pods, err := c.FindLLMPods(context.Background())
	if err != nil {
		t.Fatalf("FindLLMPods() error = %v", err)
	}

	// #then
	got := map[string]int{}
	for _, p := range pods {
		got[p.Name] = p.GPURequested
	}
	want := map[string]int{"two-containers": 4, "request-only": 1, "no-gpu": 0}
	for name, w := range want {
		if got[name] != w {
			t.Errorf("%s GPURequested = %d, want %d", name, got[name], w)
		}
	}
}

func TestGetNodePlacementCapacityTypeAndGPUMemory(t *testing.T) {
	t.Parallel()

	// #given: a Karpenter spot node with per-GPU memory labels, an EKS
	// on-demand node with HAMi's gpumem capacity, and an unlabelled node
	objects := []runtime.Object{
		&corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: "karpenter-spot", Labels: map[string]string{
			"karpenter.sh/capacity-type": "spot",
			"nvidia.com/gpu.count":       "4",
			"nvidia.com/gpu.memory":      "46068",
		}}},
		&corev1.Node{
			ObjectMeta: metav1.ObjectMeta{Name: "eks-od", Labels: map[string]string{
				"eks.amazonaws.com/capacityType": "ON_DEMAND",
			}},
			Status: corev1.NodeStatus{Capacity: corev1.ResourceList{
				"nvidia.com/gpu":    *resource.NewQuantity(1, resource.DecimalSI),
				"nvidia.com/gpumem": *resource.NewQuantity(23028, resource.DecimalSI),
			}},
		},
		&corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: "eks-spot", Labels: map[string]string{
			"eks.amazonaws.com/capacityType": "SPOT",
		}}},
		&corev1.Node{ObjectMeta: metav1.ObjectMeta{Name: "plain"}},
	}
	c := &Client{clientset: fake.NewClientset(objects...)}

	// #when
	placements, err := c.GetNodePlacement(context.Background(), []string{"karpenter-spot", "eks-od", "eks-spot", "plain"})
	if err != nil {
		t.Fatalf("GetNodePlacement() error = %v", err)
	}

	// #then
	cases := []struct {
		node     string
		capacity string
		memMiB   float64
	}{
		{"karpenter-spot", "spot", 4 * 46068},
		{"eks-od", "on-demand", 23028},
		{"eks-spot", "spot", 0},
		{"plain", "", 0},
	}
	for _, tc := range cases {
		p := placements[tc.node]
		if p.CapacityType != tc.capacity {
			t.Errorf("%s CapacityType = %q, want %q", tc.node, p.CapacityType, tc.capacity)
		}
		if p.GPUMemTotalMiB != tc.memMiB {
			t.Errorf("%s GPUMemTotalMiB = %v, want %v", tc.node, p.GPUMemTotalMiB, tc.memMiB)
		}
	}
}

func TestFindLiteLLMPods(t *testing.T) {
	t.Parallel()

	// #given: one pod matched by image (with explicit port), one by command
	// (port falls back to 4000), one vLLM pod (not a gateway), one pending
	// pod (skipped).
	litellmImage := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "litellm-proxy-0", Namespace: "ai"},
		Spec: corev1.PodSpec{
			NodeName: "node-1",
			Containers: []corev1.Container{{
				Name:  "proxy",
				Image: "ghcr.io/berriai/litellm:main-latest",
				Ports: []corev1.ContainerPort{{ContainerPort: 4000}},
			}},
		},
		Status: corev1.PodStatus{Phase: corev1.PodRunning, PodIP: "10.0.1.5"},
	}
	litellmCmd := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "litellm-cmd", Namespace: "ai"},
		Spec: corev1.PodSpec{
			NodeName: "node-2",
			Containers: []corev1.Container{{
				Name:    "proxy",
				Image:   "python:3.11-slim",
				Command: []string{"litellm"},
				Args:    []string{"--config", "/app/config.yaml"},
			}},
		},
		Status: corev1.PodStatus{Phase: corev1.PodRunning, PodIP: "10.0.1.6"},
	}
	vllmPod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "vllm", Namespace: "ai"},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{{
				Name:  "main",
				Image: "vllm/vllm-openai:latest",
				Ports: []corev1.ContainerPort{{ContainerPort: 8000}},
			}},
		},
		Status: corev1.PodStatus{Phase: corev1.PodRunning, PodIP: "10.0.1.7"},
	}
	pendingPod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "litellm-pending", Namespace: "ai"},
		Spec: corev1.PodSpec{
			Containers: []corev1.Container{{Name: "proxy", Image: "ghcr.io/berriai/litellm:main-latest"}},
		},
		Status: corev1.PodStatus{Phase: corev1.PodPending},
	}

	clientset := fake.NewClientset(litellmImage, litellmCmd, vllmPod, pendingPod)
	c := &Client{clientset: clientset, debug: false}

	// #when
	pods, err := c.FindLiteLLMPods(context.Background())
	if err != nil {
		t.Fatalf("FindLiteLLMPods() error = %v", err)
	}

	// #then: only the two LiteLLM pods, with the right ports.
	if len(pods) != 2 {
		t.Fatalf("expected 2 LiteLLM pods, got %d: %+v", len(pods), pods)
	}
	byName := map[string]LiteLLMPodInfo{}
	for _, p := range pods {
		byName[p.Name] = p
	}
	if p, ok := byName["litellm-proxy-0"]; !ok {
		t.Fatal("expected to find litellm-proxy-0")
	} else {
		if p.Port != 4000 {
			t.Errorf("litellm-proxy-0 Port = %d, want 4000", p.Port)
		}
		if p.IP != "10.0.1.5" {
			t.Errorf("litellm-proxy-0 IP = %q, want 10.0.1.5", p.IP)
		}
	}
	if p, ok := byName["litellm-cmd"]; !ok {
		t.Fatal("expected to find litellm-cmd (command marker)")
	} else {
		if p.Port != 4000 {
			t.Errorf("litellm-cmd Port = %d, want default 4000", p.Port)
		}
	}
	if _, ok := byName["vllm"]; ok {
		t.Error("vllm pod must not be matched as a LiteLLM gateway")
	}
	if _, ok := byName["litellm-pending"]; ok {
		t.Error("non-running pod must be skipped")
	}
}

func TestRawGetWithoutTransport(t *testing.T) {
	t.Parallel()
	c := &Client{clientset: fake.NewClientset()}
	if _, err := c.RawGet(context.Background(), "/apis/metrics.k8s.io/v1beta1/pods"); !errors.Is(err, ErrNoRawAPI) {
		t.Errorf("RawGet() on a fake clientset = %v, want ErrNoRawAPI", err)
	}
}
