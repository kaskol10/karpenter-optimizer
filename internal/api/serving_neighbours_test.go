package api

import (
	"reflect"
	"testing"

	"github.com/karpenter-optimizer/internal/kubernetes"
	"github.com/karpenter-optimizer/internal/llmhealth"
)

// These cases mirror frontend/src/lib/servingPlacement.test.js so the backend
// and the Topology view agree on who shares a GPU.

const (
	uuidA = "GPU-a1a1a1a1-0000-0000-0000-000000000000"
	uuidB = "GPU-b2b2b2b2-0000-0000-0000-000000000000"
)

func podOn(ns, name string, gpu float64, devices ...kubernetes.GPUDevice) kubernetes.PodInfo {
	return kubernetes.PodInfo{Namespace: ns, Name: name, NodeName: "node-1", GPURequested: gpu, GPUDevices: devices}
}

func TestGPUNeighboursFor(t *testing.T) {
	t.Parallel()

	devA := kubernetes.GPUDevice{UUID: uuidA, MemoryMiB: 20000}
	devB := kubernetes.GPUDevice{UUID: uuidB, Index: 1, MemoryMiB: 20000}
	hamiNode := []kubernetes.PodInfo{
		podOn("llm", "llama-0", 1, devA),
		podOn("batch", "embed-0", 1, kubernetes.GPUDevice{UUID: uuidA, MemoryMiB: 8000}),
		podOn("llm", "small-0", 1, devB),
		podOn("kube-system", "node-exporter", 0),
	}

	tests := []struct {
		name        string
		pod         llmhealth.PodHealth
		nodePods    []kubernetes.PodInfo
		wantShares  []llmhealth.GPUShare
		wantPrecise bool
	}{
		{
			name: "matches pods on the same physical GPU by UUID",
			pod: llmhealth.PodHealth{Namespace: "llm", Name: "llama-0", GPUCapacity: 2,
				GPUDevices: []llmhealth.GPUDevice{{UUID: uuidA, MemoryMiB: 20000}}},
			nodePods: hamiNode,
			wantShares: []llmhealth.GPUShare{{UUID: uuidA, Pods: []llmhealth.NeighbourPod{
				{Namespace: "batch", Name: "embed-0", MemoryMiB: 8000},
			}}},
			wantPrecise: true,
		},
		{
			name:     "falls back to the pod's own placement when the probe has no devices",
			pod:      llmhealth.PodHealth{Namespace: "llm", Name: "llama-0", GPUCapacity: 2},
			nodePods: hamiNode,
			wantShares: []llmhealth.GPUShare{{UUID: uuidA, Pods: []llmhealth.NeighbourPod{
				{Namespace: "batch", Name: "embed-0", MemoryMiB: 8000},
			}}},
			wantPrecise: true,
		},
		{
			name:        "a pod alone on its GPU has no shares",
			pod:         llmhealth.PodHealth{Namespace: "llm", Name: "small-0", GPUCapacity: 2},
			nodePods:    hamiNode,
			wantShares:  []llmhealth.GPUShare{},
			wantPrecise: true,
		},
		{
			name: "devices without UUIDs match by index",
			pod: llmhealth.PodHealth{Namespace: "llm", Name: "a",
				GPUDevices: []llmhealth.GPUDevice{{Index: 3}}},
			nodePods: []kubernetes.PodInfo{
				podOn("llm", "a", 1, kubernetes.GPUDevice{Index: 3}),
				podOn("ml", "b", 1, kubernetes.GPUDevice{Index: 3, MemoryMiB: 4000}),
				podOn("ml", "c", 1, kubernetes.GPUDevice{Index: 2}),
			},
			wantShares: []llmhealth.GPUShare{{Index: 3, Pods: []llmhealth.NeighbourPod{
				{Namespace: "ml", Name: "b", MemoryMiB: 4000},
			}}},
			wantPrecise: true,
		},
		{
			name: "single-GPU node without placement: other GPU pods time-slice the card",
			pod:  llmhealth.PodHealth{Namespace: "llm", Name: "qwen-0", GPUCapacity: 1},
			nodePods: []kubernetes.PodInfo{
				podOn("llm", "qwen-0", 1),
				{Namespace: "ml", Name: "trainer", GPURequested: 1, GPUMemRequestMiB: 6000},
				podOn("kube-system", "node-exporter", 0),
			},
			wantShares: []llmhealth.GPUShare{{Pods: []llmhealth.NeighbourPod{
				{Namespace: "ml", Name: "trainer", MemoryMiB: 6000},
			}}},
			wantPrecise: false,
		},
		{
			name:        "multi-GPU node without placement: GPUs assumed exclusive",
			pod:         llmhealth.PodHealth{Namespace: "llm", Name: "mistral-0", GPUCapacity: 4},
			nodePods:    []kubernetes.PodInfo{podOn("llm", "mistral-0", 1), podOn("ml", "other", 1)},
			wantShares:  []llmhealth.GPUShare{},
			wantPrecise: false,
		},
		{
			name:        "no pods listed for the node: alone, never nil",
			pod:         llmhealth.PodHealth{Namespace: "llm", Name: "x", GPUCapacity: 1},
			nodePods:    nil,
			wantShares:  []llmhealth.GPUShare{},
			wantPrecise: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			shares, precise := gpuNeighboursFor(tt.pod, tt.nodePods)
			if shares == nil {
				t.Fatal("shares is nil; want an empty slice so JSON says [] (alone), not null (unknown)")
			}
			if !reflect.DeepEqual(shares, tt.wantShares) {
				t.Errorf("shares = %+v, want %+v", shares, tt.wantShares)
			}
			if precise != tt.wantPrecise {
				t.Errorf("precise = %v, want %v", precise, tt.wantPrecise)
			}
		})
	}
}

func TestGPUKey(t *testing.T) {
	t.Parallel()
	if got := gpuKey(uuidA, 0); got != uuidA {
		t.Errorf("gpuKey(uuid) = %q, want the UUID", got)
	}
	if got := gpuKey("", 2); got != "idx-2" {
		t.Errorf("gpuKey(no uuid) = %q, want idx-2", got)
	}
}
