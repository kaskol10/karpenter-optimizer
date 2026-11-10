package kubernetes

import (
	"context"
	"sort"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
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

// LifecycleStep is one stage of a node's way out of the cluster, merged
// from the Node events of one kind: when it was first and last seen, how
// many times (events are aggregated, and Karpenter logs one FailedDraining
// per attempt) and the latest message.
type LifecycleStep struct {
	Kind    string    // see lifecycleKind
	At      time.Time // first seen
	Last    time.Time // last seen
	Count   int
	Message string
}

// lifecycleKind maps a Node event to a lifecycle step kind, or "" when the
// event says nothing about the node going away. DisruptionBlocked is left
// out: on a node already going it only repeats "Node is deleting or marked
// for deletion".
func lifecycleKind(component, reason string) string {
	switch reason {
	case "DisruptionTerminating":
		return "disrupted"
	case "SpotInterrupted":
		return "spot-interrupted"
	case "InstanceUnhealthy":
		return "unhealthy"
	case "FailedDraining":
		return "drain-failed"
	case "AwaitingVolumeDetachment":
		return "awaiting-volumes"
	case "InstanceStopping":
		return "instance-stopping"
	case "InstanceTerminating":
		return "instance-terminating"
	case "NodeNotReady":
		return "not-ready"
	case "RemovingNode", "DeletingNode":
		// node-controller / cloud-node-lifecycle-controller: the Node
		// object is going away, the closest thing to "gone" an event says.
		if strings.Contains(component, "node") {
			return "removed"
		}
	}
	return ""
}

// NodeEvents is what one list of Node events says about each node.
type NodeEvents struct {
	// Reasons is the Karpenter disruption reason per node: the most telling
	// reason seen (reasonRank), the latest among equals. A consolidated node
	// logs "Disrupting Node: Underutilized" and, minutes later, "Instance is
	// terminating"; the first is the reason.
	Reasons map[string]string
	// Lifecycles are the steps per node (lifecycleKind), oldest first.
	Lifecycles map[string][]LifecycleStep
}

// NodeDisruptionReasons returns NodeEvents.Reasons. See NodeEventSummary.
func (c *Client) NodeDisruptionReasons(ctx context.Context) (map[string]string, error) {
	ev, err := c.NodeEventSummary(ctx)
	if err != nil {
		return nil, err
	}
	return ev.Reasons, nil
}

// NodeEventSummary reads the Node events once (events only live about an
// hour) and returns each node's disruption reason and lifecycle steps. The
// placement-history sampler calls it every tick, so a node's reason and
// how it went ("disrupted: Underutilized → drain failed ×2 → removed") are
// kept after the events expire.
func (c *Client) NodeEventSummary(ctx context.Context) (NodeEvents, error) {
	events, err := c.clientset.CoreV1().Events("").List(ctx, metav1.ListOptions{
		FieldSelector: "involvedObject.kind=Node",
	})
	if err != nil {
		return NodeEvents{}, err
	}
	out := NodeEvents{Reasons: map[string]string{}, Lifecycles: map[string][]LifecycleStep{}}
	latest := map[string]metav1.Time{}
	rank := map[string]int{}
	steps := map[string]map[string]*LifecycleStep{}
	for _, e := range events.Items {
		name := e.InvolvedObject.Name
		if name == "" {
			continue
		}
		first, last := eventTimes(e)
		if kind := lifecycleKind(e.Source.Component+" "+e.ReportingController, e.Reason); kind != "" {
			if steps[name] == nil {
				steps[name] = map[string]*LifecycleStep{}
			}
			st := steps[name][kind]
			if st == nil {
				st = &LifecycleStep{Kind: kind, At: first, Last: last}
				steps[name][kind] = st
			}
			if first.Before(st.At) {
				st.At = first
			}
			if !last.Before(st.Last) {
				st.Last = last
				st.Message = e.Message
			}
			st.Count += eventCount(e)
		}

		reason := karpenterDisruptionReason(e.Source.Component, e.ReportingController, e.Reason, e.Message)
		if reason == "" {
			continue
		}
		at := metav1.NewTime(last)
		r := reasonRank(reason)
		if prev, ok := latest[name]; ok && (r < rank[name] || (r == rank[name] && at.Before(&prev))) {
			continue
		}
		latest[name] = at
		rank[name] = r
		out.Reasons[name] = reason
	}
	for name, byKind := range steps {
		list := make([]LifecycleStep, 0, len(byKind))
		for _, st := range byKind {
			if st.Kind == "disrupted" {
				// "Disrupting Node: Underutilized" → "Underutilized".
				if r := karpenterDisruptionReason("karpenter", "", "DisruptionTerminating", st.Message); r != "" {
					st.Message = r
				}
			}
			list = append(list, *st)
		}
		sort.Slice(list, func(i, j int) bool {
			if !list[i].At.Equal(list[j].At) {
				return list[i].At.Before(list[j].At)
			}
			return list[i].Kind < list[j].Kind
		})
		out.Lifecycles[name] = list
	}
	return out, nil
}

// eventTimes returns when an event was first and last seen, falling back to
// EventTime for events written with the newer events API.
func eventTimes(e corev1.Event) (first, last time.Time) {
	first, last = e.FirstTimestamp.Time, e.LastTimestamp.Time
	if last.IsZero() {
		last = e.EventTime.Time
		if e.Series != nil && !e.Series.LastObservedTime.IsZero() {
			last = e.Series.LastObservedTime.Time
		}
	}
	if first.IsZero() {
		first = e.EventTime.Time
	}
	if first.IsZero() || last.Before(first) {
		first = last
	}
	return first, last
}

func eventCount(e corev1.Event) int {
	n := int(e.Count)
	if e.Series != nil && int(e.Series.Count) > n {
		n = int(e.Series.Count)
	}
	if n < 1 {
		n = 1
	}
	return n
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
