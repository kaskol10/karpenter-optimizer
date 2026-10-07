package kubernetes

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
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
