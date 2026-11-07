// Package placementhistory keeps where every pod ran over the last day, so
// the Topology tab can replay it ("what changed at 03:00?") and compare two
// moments.
//
// Each sample is a Snapshot of nodes and pods. To keep memory flat, the
// store saves a full keyframe every KeyEvery samples and only the changes
// (delta) in between; a cluster where little moves costs little. A moment is
// rebuilt from the keyframe before it plus the deltas up to it. Node
// launches, terminations and pod moves are derived by diffing consecutive
// samples, so they need no extra API calls.
package placementhistory

import (
	"sort"
	"sync"
	"time"
)

// GPUDevice is one physical GPU slice placed on a pod (HAMi placement).
type GPUDevice struct {
	UUID      string `json:"uuid,omitempty"`
	Model     string `json:"model,omitempty"`
	Index     int    `json:"index"`
	MemoryMiB int    `json:"memoryMiB,omitempty"`
}

// Pod is a pod's placement and requests at one moment.
type Pod struct {
	Namespace    string      `json:"namespace"`
	Name         string      `json:"name"`
	Node         string      `json:"node"`
	WorkloadName string      `json:"workloadName,omitempty"`
	WorkloadType string      `json:"workloadType,omitempty"`
	QOSClass     string      `json:"qosClass,omitempty"`
	CPUCores     float64     `json:"cpuCores"`
	MemoryGiB    float64     `json:"memoryGiB"`
	GPU          float64     `json:"gpu,omitempty"`
	GPUMemMiB    float64     `json:"gpuMemMiB,omitempty"`
	GPUDevices   []GPUDevice `json:"gpuDevices,omitempty"`
}

// Key is the pod's "namespace/name".
func (p Pod) Key() string { return p.Namespace + "/" + p.Name }

// Node is a node's identity, capacity and requested totals at one moment.
// DisruptionReason is the latest Karpenter disruption event seen on it (e.g.
// "Underutilized"), carried into its termination event.
type Node struct {
	Name               string  `json:"name,omitempty"`
	NodePool           string  `json:"nodePool,omitempty"`
	Zone               string  `json:"zone,omitempty"`
	InstanceType       string  `json:"instanceType,omitempty"`
	CapacityType       string  `json:"capacityType,omitempty"`
	Architecture       string  `json:"arch,omitempty"`
	CreationTime       string  `json:"created,omitempty"`
	CPUUsed            float64 `json:"cpuUsed,omitempty"` // requested cores
	CPUCapacity        float64 `json:"cpuCap,omitempty"`
	CPUAllocatable     float64 `json:"cpuAlloc,omitempty"`
	CPUPercent         float64 `json:"cpuPct,omitempty"`
	MemUsed            float64 `json:"memUsed,omitempty"` // requested GiB
	MemCapacity        float64 `json:"memCap,omitempty"`
	MemAllocatable     float64 `json:"memAlloc,omitempty"`
	MemPercent         float64 `json:"memPct,omitempty"`
	PodCount           int     `json:"pods,omitempty"`
	GPUCapacity        float64 `json:"gpuCap,omitempty"`
	GPUAllocated       float64 `json:"gpuAlloc,omitempty"`
	GPUModel           string  `json:"gpuModel,omitempty"`
	GPUMemTotalMiB     float64 `json:"gpuMemTotal,omitempty"`
	GPUMemAllocatedMiB float64 `json:"gpuMemAlloc,omitempty"`
	GPUPods            int     `json:"gpuPods,omitempty"`
	HamiDetected       bool    `json:"hami,omitempty"`
	DisruptionReason   string  `json:"reason,omitempty"`
}

// Snapshot is the cluster's placement at one moment.
type Snapshot struct {
	At    time.Time
	Nodes map[string]Node // by name
	Pods  map[string]Pod  // by namespace/name
}

func (s *Snapshot) clone() *Snapshot {
	c := &Snapshot{At: s.At, Nodes: make(map[string]Node, len(s.Nodes)), Pods: make(map[string]Pod, len(s.Pods))}
	for k, v := range s.Nodes {
		c.Nodes[k] = v
	}
	for k, v := range s.Pods {
		c.Pods[k] = v
	}
	return c
}

type delta struct {
	nodesSet map[string]Node
	nodesDel []string
	podsSet  map[string]Pod
	podsDel  []string
}

type entry struct {
	at  time.Time
	key *Snapshot // a keyframe, or nil for a delta
	d   *delta
}

// Store is a concurrency-safe, delta-encoded ring of snapshots.
type Store struct {
	mu        sync.RWMutex
	retention time.Duration
	keyEvery  int
	entries   []entry
	last      *Snapshot
	sinceKey  int
	forceKey  bool
}

// New returns a store keeping retention of history, with a full keyframe
// every keyEvery samples (at least 1).
func New(retention time.Duration, keyEvery int) *Store {
	if keyEvery < 1 {
		keyEvery = 1
	}
	return &Store{retention: retention, keyEvery: keyEvery}
}

// Add records a snapshot and returns the entry it stored, encoded for a
// durable store (a keyframe or a delta). Snapshots must arrive in time
// order; one not after the last is ignored (ok false).
func (s *Store) Add(snap *Snapshot) (rec Record, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.last != nil && !snap.At.After(s.last.At) {
		return Record{}, false
	}
	c := snap.clone()
	if s.last == nil || s.forceKey || s.sinceKey+1 >= s.keyEvery {
		s.forceKey = false
		s.entries = append(s.entries, entry{at: c.At, key: c})
		s.sinceKey = 0
	} else {
		s.entries = append(s.entries, entry{at: c.At, d: diff(s.last, c)})
		s.sinceKey++
	}
	s.last = c
	s.prune(c.At)
	return encodeEntry(s.entries[len(s.entries)-1]), true
}

// ForceKeyframe makes the next Add store a full keyframe. A durable store
// calls it after a failed write, so a lost delta never corrupts the states
// rebuilt after a restart.
func (s *Store) ForceKeyframe() {
	s.mu.Lock()
	s.forceKey = true
	s.mu.Unlock()
}

// prune drops whole segments (a keyframe and its deltas) that end before the
// retention cutoff, so the oldest entry is always a keyframe.
func (s *Store) prune(now time.Time) {
	cutoff := now.Add(-s.retention)
	drop := 0
	for i := 1; i < len(s.entries); i++ {
		if s.entries[i].key != nil && !s.entries[i].at.After(cutoff) {
			drop = i
		}
	}
	if drop > 0 {
		s.entries = append([]entry(nil), s.entries[drop:]...)
	}
}

func diff(prev, next *Snapshot) *delta {
	d := &delta{nodesSet: map[string]Node{}, podsSet: map[string]Pod{}}
	for k, n := range next.Nodes {
		if old, ok := prev.Nodes[k]; !ok || old != n {
			d.nodesSet[k] = n
		}
	}
	for k := range prev.Nodes {
		if _, ok := next.Nodes[k]; !ok {
			d.nodesDel = append(d.nodesDel, k)
		}
	}
	for k, p := range next.Pods {
		if old, ok := prev.Pods[k]; !ok || !podEqual(old, p) {
			d.podsSet[k] = p
		}
	}
	for k := range prev.Pods {
		if _, ok := next.Pods[k]; !ok {
			d.podsDel = append(d.podsDel, k)
		}
	}
	return d
}

func podEqual(a, b Pod) bool {
	if a.Namespace != b.Namespace || a.Name != b.Name || a.Node != b.Node || a.WorkloadName != b.WorkloadName ||
		a.WorkloadType != b.WorkloadType || a.QOSClass != b.QOSClass || a.CPUCores != b.CPUCores || a.MemoryGiB != b.MemoryGiB ||
		a.GPU != b.GPU || a.GPUMemMiB != b.GPUMemMiB || len(a.GPUDevices) != len(b.GPUDevices) {
		return false
	}
	for i := range a.GPUDevices {
		if a.GPUDevices[i] != b.GPUDevices[i] {
			return false
		}
	}
	return true
}

func (d *delta) apply(s *Snapshot) {
	for k, n := range d.nodesSet {
		s.Nodes[k] = n
	}
	for _, k := range d.nodesDel {
		delete(s.Nodes, k)
	}
	for k, p := range d.podsSet {
		s.Pods[k] = p
	}
	for _, k := range d.podsDel {
		delete(s.Pods, k)
	}
}

// At rebuilds the latest snapshot taken at or before t. ok is false when the
// store is empty or t is before the first sample.
func (s *Store) At(t time.Time) (*Snapshot, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	idx := sort.Search(len(s.entries), func(i int) bool { return s.entries[i].at.After(t) }) - 1
	if idx < 0 {
		return nil, false
	}
	k := idx
	for s.entries[k].key == nil {
		k--
	}
	snap := s.entries[k].key.clone()
	for i := k + 1; i <= idx; i++ {
		s.entries[i].d.apply(snap)
	}
	snap.At = s.entries[idx].at
	return snap, true
}

// Range returns the first and last sample times and the sample count.
func (s *Store) Range() (first, last time.Time, count int) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if len(s.entries) == 0 {
		return time.Time{}, time.Time{}, 0
	}
	return s.entries[0].at, s.entries[len(s.entries)-1].at, len(s.entries)
}

// Event is a change between two consecutive samples.
type Event struct {
	At           time.Time `json:"at"`
	Type         string    `json:"type"` // node-added, node-removed, pod-moved
	Node         string    `json:"node,omitempty"`
	NodePool     string    `json:"nodePool,omitempty"`
	InstanceType string    `json:"instanceType,omitempty"`
	CapacityType string    `json:"capacityType,omitempty"`
	Reason       string    `json:"reason,omitempty"` // last Karpenter disruption reason seen (node-removed)
	Pods         int       `json:"pods,omitempty"`   // pods on the node when it went (node-removed)
	Pod          string    `json:"pod,omitempty"`    // pod-moved
	From         string    `json:"from,omitempty"`
	To           string    `json:"to,omitempty"`
}

// Events lists node launches and terminations and pod moves (same pod name
// on a different node, e.g. a StatefulSet replica rescheduled) after since,
// oldest first.
func (s *Store) Events(since time.Time) []Event {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []Event
	var state *Snapshot
	for _, e := range s.entries {
		var next *Snapshot
		if e.key != nil {
			next = e.key.clone()
		} else {
			next = state.clone()
			e.d.apply(next)
		}
		next.At = e.at
		if state != nil && e.at.After(since) {
			out = append(out, changes(state, next)...)
		}
		state = next
	}
	return out
}

func changes(prev, next *Snapshot) []Event {
	var out []Event
	podsOn := map[string]int{}
	for _, p := range prev.Pods {
		podsOn[p.Node]++
	}
	for _, name := range sortedKeys(next.Nodes) {
		if _, ok := prev.Nodes[name]; !ok {
			n := next.Nodes[name]
			out = append(out, Event{At: next.At, Type: "node-added", Node: name, NodePool: n.NodePool, InstanceType: n.InstanceType, CapacityType: n.CapacityType})
		}
	}
	for _, name := range sortedKeys(prev.Nodes) {
		if _, ok := next.Nodes[name]; !ok {
			n := prev.Nodes[name]
			out = append(out, Event{At: next.At, Type: "node-removed", Node: name, NodePool: n.NodePool, InstanceType: n.InstanceType,
				CapacityType: n.CapacityType, Reason: n.DisruptionReason, Pods: podsOn[name]})
		}
	}
	for _, key := range sortedKeys(next.Pods) {
		p := next.Pods[key]
		if old, ok := prev.Pods[key]; ok && old.Node != p.Node && old.Node != "" && p.Node != "" {
			out = append(out, Event{At: next.At, Type: "pod-moved", Pod: key, From: old.Node, To: p.Node})
		}
	}
	return out
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
