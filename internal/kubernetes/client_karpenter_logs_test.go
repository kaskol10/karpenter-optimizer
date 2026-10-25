package kubernetes

import (
	"context"
	"errors"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

// fakeClient builds a Client wired to a fake clientset containing the given
// pods (enough to exercise the GetKarpenterLogs label gate).
func fakeClient(t *testing.T, pods ...*corev1.Pod) *Client {
	t.Helper()
	cs := fake.NewClientset()
	for _, p := range pods {
		if _, err := cs.CoreV1().Pods(p.Namespace).Create(context.Background(), p, metav1.CreateOptions{}); err != nil {
			t.Fatalf("seed pod %s/%s: %v", p.Namespace, p.Name, err)
		}
	}
	return &Client{clientset: cs}
}

func pod(ns, name string, labels map[string]string) *corev1.Pod {
	return &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: name, Labels: labels}}
}

// TestGetKarpenterLogsRejectsForeignPod is a regression test: GetKarpenterLogs
// must refuse to stream logs from a pod that is not a Karpenter pod, so the
// endpoint cannot be turned into a cluster-wide log dumper.
func TestGetKarpenterLogsRejectsForeignPod(t *testing.T) {
	c := fakeClient(t,
		pod("default", "web-1", map[string]string{"app": "web"}),
	)

	// #when — request logs for a non-Karpenter pod.
	_, err := c.GetKarpenterLogs(context.Background(), "default", "web-1", false, nil)

	// #then — refused as a policy error, not a server fault.
	if !errors.Is(err, ErrNotKarpenterPod) {
		t.Fatalf("expected ErrNotKarpenterPod, got %v", err)
	}
}

// TestGetKarpenterLogsAllowsKarpenterPod verifies the gate lets a labeled
// Karpenter pod through (the subsequent log-stream step may fail against the
// fake clientset, but it must not be the policy error).
func TestGetKarpenterLogsAllowsKarpenterPod(t *testing.T) {
	c := fakeClient(t,
		pod("karpenter", "karpenter-core-1", map[string]string{"app.kubernetes.io/name": "karpenter"}),
	)

	// #when
	_, err := c.GetKarpenterLogs(context.Background(), "karpenter", "karpenter-core-1", false, nil)

	// #then — not rejected by the policy gate.
	if errors.Is(err, ErrNotKarpenterPod) {
		t.Fatalf("Karpenter-labeled pod was rejected by the gate: %v", err)
	}
}

// TestGetKarpenterLogsUnknownPod verifies a nonexistent pod is a plain error
// (not the policy error).
func TestGetKarpenterLogsUnknownPod(t *testing.T) {
	c := fakeClient(t)

	_, err := c.GetKarpenterLogs(context.Background(), "default", "ghost", false, nil)

	if err == nil {
		t.Fatal("expected an error for a nonexistent pod")
	}
	if errors.Is(err, ErrNotKarpenterPod) {
		t.Fatalf("nonexistent pod reported as policy error, got %v", err)
	}
}
