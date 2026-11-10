package placementhistory

import (
	"sort"
	"time"
)

// LifecycleStep is one stage of a node's way out of the cluster, merged from
// its Node events of one kind: "disrupted" (Message holds the reason),
// "spot-interrupted", "unhealthy", "drain-failed", "awaiting-volumes",
// "instance-stopping", "instance-terminating", "not-ready" and "removed"
// (the Node object was deleted: the node is really gone).
type LifecycleStep struct {
	Kind    string    `json:"kind"`
	At      time.Time `json:"at"`             // first seen
	Last    time.Time `json:"last,omitempty"` // last seen
	Count   int       `json:"count,omitempty"`
	Message string    `json:"message,omitempty"`
}

// Lifecycles are tracked only for nodes that left the samples. Karpenter
// marks a node for deletion when it decides to disrupt it, and a node
// marked for deletion is not listed, so the node leaves the samples as soon
// as it starts draining; the rest of its way out (failed drains, the
// instance terminating, the Node object going) happens afterwards and only
// shows in its events. The sampler passes the steps it read every tick
// (Snapshot.Lifecycles); the store merges them so they outlive the events
// (about an hour), and saves the changed ones with the sample so a restart
// keeps them.

// mergeSteps folds fresh steps into known ones, by kind: the earliest first
// time, the latest last time and message, and the highest count (an expired
// event lowers the fresh count; it must not lower the known one). Oldest
// first.
func mergeSteps(known, fresh []LifecycleStep) []LifecycleStep {
	byKind := make(map[string]LifecycleStep, len(known)+len(fresh))
	for _, st := range known {
		byKind[st.Kind] = st
	}
	for _, st := range fresh {
		old, ok := byKind[st.Kind]
		if !ok {
			byKind[st.Kind] = st
			continue
		}
		if st.At.Before(old.At) {
			old.At = st.At
		}
		if !st.Last.Before(old.Last) {
			old.Last = st.Last
			if st.Message != "" {
				old.Message = st.Message
			}
		}
		if st.Count > old.Count {
			old.Count = st.Count
		}
		byKind[st.Kind] = old
	}
	out := make([]LifecycleStep, 0, len(byKind))
	for _, st := range byKind {
		out = append(out, st)
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].At.Equal(out[j].At) {
			return out[i].At.Before(out[j].At)
		}
		return out[i].Kind < out[j].Kind
	})
	return out
}

func stepsEqual(a, b []LifecycleStep) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Kind != b[i].Kind || !a[i].At.Equal(b[i].At) || !a[i].Last.Equal(b[i].Last) ||
			a[i].Count != b[i].Count || a[i].Message != b[i].Message {
			return false
		}
	}
	return true
}

// lastSeen is the latest time in a lifecycle, for pruning.
func lastSeen(steps []LifecycleStep) time.Time {
	var t time.Time
	for _, st := range steps {
		if st.Last.After(t) {
			t = st.Last
		}
		if st.At.After(t) {
			t = st.At
		}
	}
	return t
}

// trackDepartures records the nodes that left between prev and next, and
// forgets the departure and lifecycle of a node listed again (a new node
// under a reused name). Called with s.mu held, by Add and Load.
func (s *Store) trackDepartures(prev, next *Snapshot) {
	for name := range next.Nodes {
		delete(s.departed, name)
		delete(s.lifecycles, name)
	}
	if prev == nil {
		return
	}
	for name := range prev.Nodes {
		if _, still := next.Nodes[name]; !still {
			if s.departed == nil {
				s.departed = map[string]time.Time{}
			}
			s.departed[name] = next.At
		}
	}
}

// mergeLifecycles folds the steps passed with a sample into the store and
// returns the ones that changed, to save with it (nil when none did). Only
// nodes that left (trackDepartures) are kept: steps of live nodes (a
// blocked consolidation, say) and of nodes this history never saw are
// dropped. Called with s.mu held, after trackDepartures.
func (s *Store) mergeLifecycles(fresh map[string][]LifecycleStep) map[string][]LifecycleStep {
	var changed map[string][]LifecycleStep
	for name, steps := range fresh {
		if _, left := s.departed[name]; !left || len(steps) == 0 {
			continue
		}
		known, tracked := s.lifecycles[name]
		merged := mergeSteps(known, steps)
		if tracked && stepsEqual(known, merged) {
			continue
		}
		if s.lifecycles == nil {
			s.lifecycles = map[string][]LifecycleStep{}
		}
		s.lifecycles[name] = merged
		if changed == nil {
			changed = map[string][]LifecycleStep{}
		}
		changed[name] = merged
	}
	return changed
}

// pruneLifecycles forgets departures and lifecycles older than the cutoff.
func (s *Store) pruneLifecycles(cutoff time.Time) {
	for name, at := range s.departed {
		if at.Before(cutoff) {
			delete(s.departed, name)
		}
	}
	for name, steps := range s.lifecycles {
		if _, left := s.departed[name]; !left && lastSeen(steps).Before(cutoff) {
			delete(s.lifecycles, name)
		}
	}
}

func copyLifecycles(m map[string][]LifecycleStep) map[string][]LifecycleStep {
	if len(m) == 0 {
		return nil
	}
	out := make(map[string][]LifecycleStep, len(m))
	for k, v := range m {
		out[k] = append([]LifecycleStep(nil), v...)
	}
	return out
}

func copyDeparted(m map[string]time.Time) map[string]time.Time {
	if len(m) == 0 {
		return nil
	}
	out := make(map[string]time.Time, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// departures is trackDepartures for a delta about to be applied to state,
// without rebuilding the next snapshot: the deleted nodes left, the set ones
// that were not in state are new (or a reused name).
func (d *delta) departures(s *Store, at time.Time, state *Snapshot) {
	for name := range d.nodesSet {
		if _, was := state.Nodes[name]; !was {
			delete(s.departed, name)
			delete(s.lifecycles, name)
		}
	}
	for _, name := range d.nodesDel {
		if s.departed == nil {
			s.departed = map[string]time.Time{}
		}
		s.departed[name] = at
	}
}
