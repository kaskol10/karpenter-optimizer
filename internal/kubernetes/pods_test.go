package kubernetes

import (
	"context"
	"errors"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func podWithContainers(ns, name string, containers []string, ready bool, restarts int32) *corev1.Pod {
	p := pod(ns, name, nil)
	for _, c := range containers {
		p.Spec.Containers = append(p.Spec.Containers, corev1.Container{Name: c})
	}
	if ready {
		p.Status.Phase = corev1.PodRunning
	}
	for _, cs := range p.Spec.Containers {
		p.Status.ContainerStatuses = append(p.Status.ContainerStatuses, corev1.ContainerStatus{
			Name:         cs.Name,
			Ready:        ready,
			RestartCount: restarts,
		})
	}
	p.CreationTimestamp = metav1.Now()
	return p
}

// TestListPodsSummarizes verifies that ListPods returns compact summaries
// with the fields the log-explorer pod picker needs.
func TestListPodsSummarizes(t *testing.T) {
	c := fakeClient(t,
		podWithContainers("default", "web-1", []string{"app", "sidecar"}, true, 0),
		pod("karpenter", "karpenter-core-1", map[string]string{"app.kubernetes.io/name": "karpenter"}),
	)

	pods, err := c.ListPods(context.Background(), "")
	if err != nil {
		t.Fatalf("ListPods: %v", err)
	}
	if len(pods) != 2 {
		t.Fatalf("expected 2 pods, got %d", len(pods))
	}

	byName := map[string]PodSummary{}
	for _, p := range pods {
		byName[p.Name] = p
	}

	web := byName["web-1"]
	if web.Namespace != "default" {
		t.Errorf("web-1 namespace = %q, want default", web.Namespace)
	}
	if web.Ready != "2/2" {
		t.Errorf("web-1 ready = %q, want 2/2", web.Ready)
	}
	if len(web.Containers) != 2 || web.Containers[0] != "app" {
		t.Errorf("web-1 containers = %v, want [app sidecar]", web.Containers)
	}
	if web.Karpenter {
		t.Errorf("web-1 must not be flagged as a Karpenter pod")
	}
	if web.Age == "" {
		t.Errorf("web-1 age must not be empty")
	}

	karp := byName["karpenter-core-1"]
	if !karp.Karpenter {
		t.Errorf("karpenter-core-1 must be flagged as a Karpenter pod")
	}
}

// TestListPodsNamespaceScope verifies the namespace filter is honored.
func TestListPodsNamespaceScope(t *testing.T) {
	c := fakeClient(t,
		pod("default", "web-1", nil),
		pod("karpenter", "karpenter-core-1", nil),
	)

	pods, err := c.ListPods(context.Background(), "karpenter")
	if err != nil {
		t.Fatalf("ListPods: %v", err)
	}
	if len(pods) != 1 || pods[0].Name != "karpenter-core-1" {
		t.Fatalf("expected only karpenter-core-1, got %v", pods)
	}
}

// TestListPodsCountsRestarts verifies RestartCount aggregates container and
// init-container restarts so crash-looping pods surface in the picker.
func TestListPodsCountsRestarts(t *testing.T) {
	p := podWithContainers("default", "crasher", []string{"app"}, false, 7)
	p.Spec.InitContainers = []corev1.Container{{Name: "init"}}
	p.Status.InitContainerStatuses = []corev1.ContainerStatus{{Name: "init", RestartCount: 2}}
	c := fakeClient(t, p)

	pods, err := c.ListPods(context.Background(), "default")
	if err != nil {
		t.Fatalf("ListPods: %v", err)
	}
	if len(pods) != 1 {
		t.Fatalf("expected 1 pod, got %d", len(pods))
	}
	if pods[0].RestartCount != 9 {
		t.Errorf("restartCount = %d, want 9", pods[0].RestartCount)
	}
}

// TestGetPodLogsRejectsUnknownPod verifies a nonexistent pod is a plain
// error (not the Karpenter policy error — there is no gate here).
func TestGetPodLogsRejectsUnknownPod(t *testing.T) {
	c := fakeClient(t)

	_, err := c.GetPodLogs(context.Background(), "default", "ghost", "", nil, nil, false)
	if err == nil {
		t.Fatal("expected an error for a nonexistent pod")
	}
	if errors.Is(err, ErrNotKarpenterPod) {
		t.Fatalf("generic GetPodLogs must not surface the Karpenter policy error: %v", err)
	}
}

// TestGetPodLogsRejectsUnknownContainer verifies the container name is
// validated against the pod spec before streaming.
func TestGetPodLogsRejectsUnknownContainer(t *testing.T) {
	c := fakeClient(t, podWithContainers("default", "web-1", []string{"app"}, true, 0))

	_, err := c.GetPodLogs(context.Background(), "default", "web-1", "nope", nil, nil, false)
	if err == nil {
		t.Fatal("expected an error for an unknown container")
	}
	if errors.Is(err, ErrNotKarpenterPod) {
		t.Fatalf("unknown container must not surface the Karpenter policy error: %v", err)
	}
}

// TestGetPodLogsAllowsNonKarpenterPod is the counterpoint to
// TestGetKarpenterLogsRejectsForeignPod: the generic path must work for any
// pod, which is what the /pods/logs endpoint relies on.
func TestGetPodLogsAllowsNonKarpenterPod(t *testing.T) {
	c := fakeClient(t, podWithContainers("default", "web-1", []string{"app"}, true, 0))

	// The log stream itself will fail against the fake clientset (it does
	// not implement the pods/log subresource), but it must not fail the
	// earlier container validation and must not be the policy error.
	_, err := c.GetPodLogs(context.Background(), "default", "web-1", "app", nil, nil, false)
	if err == nil {
		t.Skip("fake clientset unexpectedly returned logs; nothing to verify")
	}
	if errors.Is(err, ErrNotKarpenterPod) {
		t.Fatalf("GetPodLogs rejected a plain pod with the Karpenter policy error: %v", err)
	}
}

// TestFormatPodAge covers the day/hour/minute buckets and the negative-time
// guard.
func TestFormatPodAge(t *testing.T) {
	tests := []struct {
		name     string
		creation time.Time
		want     string
	}{
		{"days", time.Now().Add(-3 * 24 * time.Hour), "3d"},
		{"hours", time.Now().Add(-5 * time.Hour), "5h"},
		{"minutes", time.Now().Add(-12 * time.Minute), "12m"},
		{"sub-minute", time.Now().Add(-10 * time.Second), "0m"},
		{"future", time.Now().Add(time.Hour), "0m"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := formatPodAge(tt.creation)
			if got != tt.want {
				t.Errorf("formatPodAge(%v) = %q, want %q", tt.creation, got, tt.want)
			}
		})
	}
}
