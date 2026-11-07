package kubernetes

import (
	"context"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

func TestKarpenterDisruptionReason(t *testing.T) {
	cases := []struct {
		component, controller, reason, message, want string
	}{
		{"karpenter", "", "DisruptionTerminating", "Disrupting Node: Underutilized/Delete", "Underutilized"},
		{"", "karpenter", "DisruptionLaunching", "Launching NodeClaim: Disrupting NodeClaim: Drifted/Replace", "Drifted"},
		{"karpenter", "", "DisruptionTerminating", "Disrupting Node: Empty", "Empty"},
		{"karpenter", "", "DisruptionTerminating", "terminating", "Disrupted"},
		{"karpenter", "", "DisruptionBlocked", "Cannot disrupt Node: pdb prevents pod evictions", ""},
		{"karpenter", "", "SpotInterrupted", "Spot interruption warning was triggered", "SpotInterrupted"},
		{"kubelet", "", "NodeNotReady", "Disrupting Node: Underutilized/Delete", ""},
		{"kubelet", "", "Unconsolidatable", "", ""},
	}
	for _, c := range cases {
		if got := karpenterDisruptionReason(c.component, c.controller, c.reason, c.message); got != c.want {
			t.Errorf("%s/%q: got %q, want %q", c.reason, c.message, got, c.want)
		}
	}
}

func TestNodeDisruptionReasonsKeepsLatestPerNode(t *testing.T) {
	now := time.Now()
	ev := func(name, node, reason, msg string, at time.Time) *corev1.Event {
		return &corev1.Event{
			ObjectMeta:     metav1.ObjectMeta{Namespace: "default", Name: name},
			InvolvedObject: corev1.ObjectReference{Kind: "Node", Name: node},
			Source:         corev1.EventSource{Component: "karpenter"},
			Reason:         reason,
			Message:        msg,
			LastTimestamp:  metav1.NewTime(at),
		}
	}
	newer := ev("e2", "n1", "DisruptionTerminating", "Disrupting Node: Drifted/Replace", now)
	older := ev("e1", "n1", "DisruptionTerminating", "Disrupting Node: Underutilized/Delete", now.Add(-time.Minute))
	eventTime := ev("e3", "n2", "SpotInterrupted", "", time.Time{})
	eventTime.LastTimestamp = metav1.Time{}
	eventTime.EventTime = metav1.NewMicroTime(now)
	noise := ev("e4", "n3", "Unconsolidatable", "", now)

	c := NewClientWithClientset(fake.NewClientset(newer, older, eventTime, noise))
	got, err := c.NodeDisruptionReasons(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got["n1"] != "Drifted" || got["n2"] != "SpotInterrupted" || len(got) != 2 {
		t.Fatalf("got %v", got)
	}
}
