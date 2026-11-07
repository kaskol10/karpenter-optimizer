package kubernetes

import (
	"context"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// interruptionReasons are Karpenter node events that end a node without a
// disruption decision (cloud-side interruptions).
var interruptionReasons = map[string]bool{
	"SpotInterrupted":     true,
	"InstanceTerminating": true,
	"InstanceStopping":    true,
	"InstanceUnhealthy":   true,
}

// NodeDisruptionReasons returns the latest Karpenter disruption reason per
// node name, read from Node events (one list call, events only live about an
// hour). The placement-history sampler stamps it on each node so a later
// termination event can say why the node went ("Underutilized", "Drifted",
// "SpotInterrupted").
func (c *Client) NodeDisruptionReasons(ctx context.Context) (map[string]string, error) {
	events, err := c.clientset.CoreV1().Events("").List(ctx, metav1.ListOptions{
		FieldSelector: "involvedObject.kind=Node",
	})
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	latest := map[string]metav1.Time{}
	for _, e := range events.Items {
		reason := karpenterDisruptionReason(e.Source.Component, e.ReportingController, e.Reason, e.Message)
		name := e.InvolvedObject.Name
		if reason == "" || name == "" {
			continue
		}
		at := e.LastTimestamp
		if at.IsZero() {
			at = metav1.NewTime(e.EventTime.Time)
		}
		if prev, ok := latest[name]; ok && at.Before(&prev) {
			continue
		}
		latest[name] = at
		out[name] = reason
	}
	return out, nil
}

// karpenterDisruptionReason extracts the disruption reason from a Karpenter
// node event, or "" when the event is not a disruption. Karpenter writes
// messages like "Disrupting Node: Underutilized/Delete" or
// "Disrupting NodeClaim: Drifted/Replace"; the word before the slash is the
// reason.
func karpenterDisruptionReason(component, controller, reason, message string) string {
	if interruptionReasons[reason] {
		return reason
	}
	fromKarpenter := strings.Contains(component, "karpenter") || strings.Contains(controller, "karpenter")
	if !fromKarpenter && !strings.HasPrefix(reason, "Disruption") {
		return ""
	}
	for _, prefix := range []string{"Disrupting Node: ", "Disrupting NodeClaim: "} {
		if i := strings.Index(message, prefix); i >= 0 {
			rest := message[i+len(prefix):]
			if j := strings.IndexAny(rest, "/ "); j >= 0 {
				rest = rest[:j]
			}
			if rest != "" {
				return rest
			}
		}
	}
	if reason == "DisruptionTerminating" {
		return "Disrupted"
	}
	return ""
}
