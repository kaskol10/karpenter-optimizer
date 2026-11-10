package placementhistory

import (
	"encoding/json"
	"fmt"
	"sort"
	"time"
)

// Record is one stored entry encoded for a durable store: a full keyframe
// or a delta from the entry before it, as JSON. A durable store keeps the
// records Add returns and hands them back to Load after a restart.
type Record struct {
	At       time.Time
	Keyframe bool
	Body     []byte
}

type wireSnapshot struct {
	Nodes []Node            `json:"nodes"`
	Pods  []Pod             `json:"pods"`
	Gone  map[string]string `json:"gone,omitempty"`
	// Lifecycles and Departed: every tracked one (see entry.lc).
	Lifecycles map[string][]LifecycleStep `json:"lc,omitempty"`
	Departed   map[string]time.Time       `json:"departed,omitempty"`
}

type wireDelta struct {
	NodesSet []Node            `json:"nodesSet,omitempty"`
	NodesDel []string          `json:"nodesDel,omitempty"`
	PodsSet  []Pod             `json:"podsSet,omitempty"`
	PodsDel  []string          `json:"podsDel,omitempty"`
	Gone     map[string]string `json:"gone,omitempty"`
	// Lifecycles: the ones changed at this sample (see entry.lc).
	Lifecycles map[string][]LifecycleStep `json:"lc,omitempty"`
}

func nodeList(m map[string]Node) []Node {
	out := make([]Node, 0, len(m))
	for _, k := range sortedKeys(m) {
		out = append(out, m[k])
	}
	return out
}

func podList(m map[string]Pod) []Pod {
	out := make([]Pod, 0, len(m))
	for _, k := range sortedKeys(m) {
		out = append(out, m[k])
	}
	return out
}

// encodeEntry cannot fail: every field is a plain value.
func encodeEntry(e entry) Record {
	var v any
	if e.key != nil {
		v = wireSnapshot{Nodes: nodeList(e.key.Nodes), Pods: podList(e.key.Pods), Gone: e.key.Gone, Lifecycles: e.lc, Departed: e.departed}
	} else {
		v = wireDelta{NodesSet: nodeList(e.d.nodesSet), NodesDel: e.d.nodesDel, PodsSet: podList(e.d.podsSet), PodsDel: e.d.podsDel, Gone: e.d.gone, Lifecycles: e.lc}
	}
	body, _ := json.Marshal(v)
	return Record{At: e.at, Keyframe: e.key != nil, Body: body}
}

func decodeRecord(r Record) (entry, error) {
	if r.Keyframe {
		var w wireSnapshot
		if err := json.Unmarshal(r.Body, &w); err != nil {
			return entry{}, fmt.Errorf("placementhistory: keyframe at %s: %w", r.At, err)
		}
		snap := &Snapshot{At: r.At, Nodes: make(map[string]Node, len(w.Nodes)), Pods: make(map[string]Pod, len(w.Pods)), Gone: w.Gone}
		for _, n := range w.Nodes {
			snap.Nodes[n.Name] = n
		}
		for _, p := range w.Pods {
			snap.Pods[p.Key()] = p
		}
		return entry{at: r.At, key: snap, lc: w.Lifecycles, departed: w.Departed}, nil
	}
	var w wireDelta
	if err := json.Unmarshal(r.Body, &w); err != nil {
		return entry{}, fmt.Errorf("placementhistory: delta at %s: %w", r.At, err)
	}
	d := &delta{nodesSet: make(map[string]Node, len(w.NodesSet)), nodesDel: w.NodesDel, podsSet: make(map[string]Pod, len(w.PodsSet)), podsDel: w.PodsDel, gone: w.Gone}
	for _, n := range w.NodesSet {
		d.nodesSet[n.Name] = n
	}
	for _, p := range w.PodsSet {
		d.podsSet[p.Key()] = p
	}
	return entry{at: r.At, d: d, lc: w.Lifecycles}, nil
}

// Load restores records saved before a restart into an empty store, oldest
// first. Deltas before the first keyframe cannot be rebuilt and are skipped,
// as are unreadable records and everything when even the newest record is
// past the retention (now - retention). It returns how many entries were
// restored. New samples then continue from the last restored state; the
// first one is diffed against it, so changes during the downtime show up as
// events at the first sample after the restart.
func (s *Store) Load(records []Record, now time.Time) int {
	sort.SliceStable(records, func(i, j int) bool { return records[i].At.Before(records[j].At) })
	if len(records) == 0 || !records[len(records)-1].At.After(now.Add(-s.retention)) {
		return 0
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.entries) > 0 {
		return 0
	}
	var state *Snapshot
	for _, r := range records {
		e, err := decodeRecord(r)
		if err != nil || (state == nil && e.key == nil) || (state != nil && !e.at.After(state.At)) {
			continue
		}
		if e.key != nil {
			state = e.key.clone()
			s.sinceKey = 0
			// A keyframe holds every departure and lifecycle still tracked.
			s.departed = copyDeparted(e.departed)
			s.lifecycles = copyLifecycles(e.lc)
		} else {
			e.d.departures(s, e.at, state)
			e.d.apply(state)
			state.At = e.at
			s.sinceKey++
			for name, steps := range e.lc {
				if s.lifecycles == nil {
					s.lifecycles = map[string][]LifecycleStep{}
				}
				s.lifecycles[name] = steps
			}
		}
		s.entries = append(s.entries, e)
	}
	if state == nil {
		return 0
	}
	s.last = state
	s.prune(now)
	s.pruneLifecycles(now.Add(-s.retention))
	return len(s.entries)
}
