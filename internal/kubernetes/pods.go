package kubernetes

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	k8serrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// IsNotFound reports whether the error is a Kubernetes API "not found"
// response. Callers use it to turn a stale pod reference (the pod was
// deleted between listing and log fetch) into a 404 instead of a 500.
func IsNotFound(err error) bool {
	return k8serrors.IsNotFound(err)
}

// PodSummary is a compact, UI-oriented view of a pod used by the generic
// log-explorer pod picker. It intentionally avoids mirroring the full
// corev1.Pod so the API response stays small.
type PodSummary struct {
	Name       string   `json:"name"`
	Namespace  string   `json:"namespace"`
	NodeName   string   `json:"nodeName,omitempty"`
	Status     string   `json:"status"` // PodPhase
	Ready      string   `json:"ready"`  // e.g. "2/3"
	Age        string   `json:"age"`    // e.g. "3d", "5h", "12m"
	Containers []string `json:"containers"`
	// RestartCount is the sum of container restarts — a cheap proxy for
	// crash-looping pods, useful for prioritizing in the log explorer.
	RestartCount int32 `json:"restartCount,omitempty"`
	// Karpenter mirrors the app.kubernetes.io/name=karpenter label so the
	// UI can group Karpenter controller pods at the top of the picker.
	Karpenter bool `json:"karpenter,omitempty"`
}

// ListPods lists pods cluster-wide (or scoped to a namespace when
// namespace != "") as compact PodSummary entries. It paginates the listing
// so large clusters do not hit the API-server page limit.
func (c *Client) ListPods(ctx context.Context, namespace string) ([]PodSummary, error) {
	var out []PodSummary
	pages := 0
	var continueToken string
	for {
		podList, err := c.clientset.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{
			Limit:    5000,
			Continue: continueToken,
		})
		if err != nil {
			return nil, fmt.Errorf("failed to list pods: %w", err)
		}
		for i := range podList.Items {
			out = append(out, summarizePod(&podList.Items[i]))
		}
		continueToken = podList.Continue
		if continueToken == "" {
			break
		}
		pages++
		if pages > 200 { // safety bound against a stuck continue token
			break
		}
	}
	return out, nil
}

// summarizePod converts a corev1.Pod into its compact PodSummary form.
func summarizePod(pod *corev1.Pod) PodSummary {
	readyCount := 0
	restarts := int32(0)
	for _, cs := range pod.Status.ContainerStatuses {
		if cs.Ready {
			readyCount++
		}
		restarts += cs.RestartCount
	}
	for _, cs := range pod.Status.InitContainerStatuses {
		restarts += cs.RestartCount
	}

	total := len(pod.Spec.Containers)
	if len(pod.Status.ContainerStatuses) > total {
		total = len(pod.Status.ContainerStatuses)
	}
	ready := fmt.Sprintf("%d/%d", readyCount, total)

	containers := make([]string, 0, len(pod.Spec.Containers))
	for _, ct := range pod.Spec.Containers {
		containers = append(containers, ct.Name)
	}

	return PodSummary{
		Name:         pod.Name,
		Namespace:    pod.Namespace,
		NodeName:     pod.Spec.NodeName,
		Status:       string(pod.Status.Phase),
		Ready:        ready,
		Age:          formatPodAge(pod.CreationTimestamp.Time),
		Containers:   containers,
		RestartCount: restarts,
		Karpenter:    isKarpenterPod(pod),
	}
}

// formatPodAge renders a human-friendly age string like "3d", "5h" or "12m".
func formatPodAge(creation time.Time) string {
	age := time.Since(creation)
	if age < 0 {
		age = 0
	}
	if age.Hours() >= 24 {
		return fmt.Sprintf("%dd", int(age.Hours()/24))
	}
	if age.Hours() >= 1 {
		return fmt.Sprintf("%dh", int(age.Hours()))
	}
	return fmt.Sprintf("%dm", int(age.Minutes()))
}

// GetPodLogs returns the log lines for a pod. Unlike GetKarpenterLogs it
// applies no label gate — the dedicated /karpenter/logs endpoint remains
// the only one that is restricted to Karpenter pods, while this method
// backs the generic /pods/logs endpoint.
//
// container, tailLines, sinceSeconds and previous are optional; empty/nil
// selects the default container and full tail.
func (c *Client) GetPodLogs(ctx context.Context, namespace, podName, container string, tailLines, sinceSeconds *int64, previous bool) ([]string, error) {
	pod, err := c.clientset.CoreV1().Pods(namespace).Get(ctx, podName, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("failed to get pod %s/%s: %w", namespace, podName, err)
	}
	// Validate the container name against the pod spec (defaulting to the
	// first container when none is requested).
	if container != "" {
		found := false
		for _, ct := range pod.Spec.Containers {
			if ct.Name == container {
				found = true
				break
			}
		}
		for _, ct := range pod.Spec.InitContainers {
			if ct.Name == container {
				found = true
				break
			}
		}
		if !found {
			return nil, fmt.Errorf("container %q not found on pod %s/%s", container, namespace, podName)
		}
	}

	opts := &corev1.PodLogOptions{
		Container: container,
		Previous:  previous,
	}
	if tailLines != nil {
		opts.TailLines = tailLines
	}
	if sinceSeconds != nil {
		opts.SinceSeconds = sinceSeconds
	}

	req := c.clientset.CoreV1().Pods(namespace).GetLogs(podName, opts)
	stream, err := req.Stream(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to get log stream: %w", err)
	}
	defer func() {
		_ = stream.Close() // Ignore close errors
	}()

	var logs []string
	scanner := bufio.NewScanner(stream)
	// Allow long log lines (single JSON log lines can exceed the default 64KB).
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.TrimSpace(line) == "" {
			continue
		}
		logs = append(logs, line)
	}
	if err := scanner.Err(); err != nil && err != io.EOF {
		return nil, fmt.Errorf("failed to read log stream: %w", err)
	}

	return logs, nil
}
