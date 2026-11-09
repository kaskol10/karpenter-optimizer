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
		// Wording seen on Karpenter v1 clusters: no "/Delete" suffix.
		{"karpenter", "", "DisruptionTerminating", "Disrupting Node: Underutilized", "Underutilized"},
		{"karpenter", "", "InstanceTerminating", "Instance is terminating", "InstanceTerminating"},
		{"karpenter", "", "Unconsolidatable", "Can't replace with a cheaper node", ""},
		{"karpenter", "", "ConsolidationRejected", "Consolidation rejected: delete: [ip-10-0-0-1], reason: churn (savings: $0.18)", ""},
		{"karpenter", "", "DisruptionBlocked", "Node is deleting or marked for deletion", ""},
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

// A consolidated node logs the decision, then the instance terminating a few
// minutes later (seen on a real cluster). The decision is the reason.
func TestNodeDisruptionReasonsPrefersTheDecision(t *testing.T) {
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
	c := NewClientWithClientset(fake.NewClientset(
		ev("a1", "consolidated", "DisruptionTerminating", "Disrupting Node: Underutilized", now.Add(-4*time.Minute)),
		ev("a2", "consolidated", "InstanceTerminating", "Instance is terminating", now),
		ev("b1", "spot", "InstanceTerminating", "Instance is terminating", now),
		ev("b2", "spot", "SpotInterrupted", "Spot interruption warning was triggered", now.Add(-2*time.Minute)),
		ev("c1", "plain", "InstanceTerminating", "Instance is terminating", now),
		ev("d1", "twice", "DisruptionTerminating", "Disrupting Node: Underutilized", now.Add(-time.Hour)),
		ev("d2", "twice", "DisruptionTerminating", "Disrupting Node: Empty", now),
	))
	got, err := c.NodeDisruptionReasons(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"consolidated": "Underutilized", "spot": "SpotInterrupted", "plain": "InstanceTerminating", "twice": "Empty"}
	for node, reason := range want {
		if got[node] != reason {
			t.Errorf("%s: got %q, want %q", node, got[node], reason)
		}
	}
}
