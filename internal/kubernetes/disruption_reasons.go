package kubernetes

import (
	"context"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// interruptionReasons are Karpenter node events about the instance itself,
// with how much each says about why the node went (higher wins, see
// reasonRank). A spot interruption is a cause. "Instance is terminating"
// and "stopping" follow every termination, including Karpenter's own
// consolidation, so they are only a reason when nothing better was seen.
var interruptionReasons = map[string]int{
	"SpotInterrupted":     2,
	"InstanceUnhealthy":   2,
	"InstanceTerminating": 1,
	"InstanceStopping":    1,
}

// reasonRank orders reasons for one node: a Karpenter disruption decision
// ("Underutilized", "Empty", "Drifted"…) beats an interruption cause, which
// beats the generic instance-state events.
func reasonRank(reason string) int {
	if r, ok := interruptionReasons[reason]; ok {
		return r
	}
	return 3
}

// NodeDisruptionReasons returns the Karpenter disruption reason per node
// name, read from Node events (one list call, events only live about an
// hour): the most telling reason seen (reasonRank), the latest among equals.
// A consolidated node logs "Disrupting Node: Underutilized" and, minutes
// later, "Instance is terminating"; the first is the reason. The placement-history sampler stamps it on each node so a later
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
	rank := map[string]int{}
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
		r := reasonRank(reason)
		if prev, ok := latest[name]; ok && (r < rank[name] || (r == rank[name] && at.Before(&prev))) {
			continue
		}
		latest[name] = at
		rank[name] = r
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
	if _, ok := interruptionReasons[reason]; ok {
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
