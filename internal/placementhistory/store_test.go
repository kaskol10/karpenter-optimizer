package placementhistory

import (
	"sync"
	"testing"
	"time"
)

var t0 = time.Date(2026, 11, 7, 3, 0, 0, 0, time.UTC)

func snap(min int, nodes []Node, pods []Pod) *Snapshot {
	s := &Snapshot{At: t0.Add(time.Duration(min) * time.Minute), Nodes: map[string]Node{}, Pods: map[string]Pod{}}
	for _, n := range nodes {
		s.Nodes[n.Name] = n
	}
	for _, p := range pods {
		s.Pods[p.Key()] = p
	}
	return s
}

func pod(name, node string) Pod {
	return Pod{Namespace: "default", Name: name, Node: node, CPUCores: 1, MemoryGiB: 2}
}

func TestAtRebuildsFromKeyframeAndDeltas(t *testing.T) {
	st := New(24*time.Hour, 3)
	a := Node{Name: "a", NodePool: "gpu"}
	b := Node{Name: "b", NodePool: "gpu"}
	st.Add(snap(0, []Node{a}, []Pod{pod("p1", "a")}))
	st.Add(snap(1, []Node{a, b}, []Pod{pod("p1", "a"), pod("p2", "b")}))
	st.Add(snap(2, []Node{b}, []Pod{pod("p1", "b"), pod("p2", "b")})) // delta (keyEvery=3)
	st.Add(snap(3, []Node{b}, []Pod{pod("p2", "b")}))                 // keyframe

	cases := []struct {
		min       int
		nodes     int
		pods      int
		p1Node    string
		wantFound bool
	}{
		{-1, 0, 0, "", false},
		{0, 1, 1, "a", true},
		{1, 2, 2, "a", true},
		{2, 1, 2, "b", true},
		{3, 1, 1, "", true},
		{90, 1, 1, "", true}, // after the last sample: latest
	}
	for _, c := range cases {
		got, ok := st.At(t0.Add(time.Duration(c.min) * time.Minute))
		if ok != c.wantFound {
			t.Fatalf("min %d: found=%v", c.min, ok)
		}
		if !ok {
			continue
		}
		if len(got.Nodes) != c.nodes || len(got.Pods) != c.pods {
			t.Errorf("min %d: %d nodes %d pods, want %d/%d", c.min, len(got.Nodes), len(got.Pods), c.nodes, c.pods)
		}
		if got.Pods["default/p1"].Node != c.p1Node {
			t.Errorf("min %d: p1 on %q, want %q", c.min, got.Pods["default/p1"].Node, c.p1Node)
		}
	}
	// Rebuilding must not mutate the stored keyframe.
	again, _ := st.At(t0)
	if len(again.Nodes) != 1 || again.Pods["default/p1"].Node != "a" {
		t.Fatalf("keyframe mutated: %+v", again)
	}
	if got, _ := st.At(t0.Add(90 * time.Minute)); !got.At.Equal(t0.Add(3 * time.Minute)) {
		t.Errorf("At reports sample time %v", got.At)
	}
}

func TestAddIgnoresOutOfOrderAndCopiesInput(t *testing.T) {
	st := New(time.Hour, 5)
	s := snap(5, []Node{{Name: "a"}}, nil)
	st.Add(s)
	st.Add(snap(4, []Node{{Name: "z"}}, nil))
	st.Add(snap(5, []Node{{Name: "z"}}, nil))
	s.Nodes["mutated"] = Node{Name: "mutated"}
	if _, _, n := st.Range(); n != 1 {
		t.Fatalf("count %d, want 1", n)
	}
	got, _ := st.At(t0.Add(time.Hour))
	if _, ok := got.Nodes["mutated"]; ok || len(got.Nodes) != 1 {
		t.Fatalf("store aliased caller map: %+v", got.Nodes)
	}
}

func TestPruneKeepsKeyframeAtHead(t *testing.T) {
	st := New(10*time.Minute, 4)
	for i := 0; i <= 30; i++ {
		st.Add(snap(i, []Node{{Name: "a"}}, []Pod{pod("p", "a")}))
	}
	first, last, n := st.Range()
	if !last.Equal(t0.Add(30 * time.Minute)) {
		t.Fatalf("last %v", last)
	}
	if first.Before(t0.Add(16*time.Minute)) || first.After(t0.Add(20*time.Minute)) {
		t.Fatalf("first %v not near the cutoff (n=%d)", first, n)
	}
	if st.entries[0].key == nil {
		t.Fatal("oldest entry is not a keyframe")
	}
	if got, ok := st.At(first); !ok || len(got.Pods) != 1 {
		t.Fatalf("cannot rebuild the oldest sample: %v %+v", ok, got)
	}
}

func TestRangeEmpty(t *testing.T) {
	first, last, n := New(time.Hour, 0).Range()
	if !first.IsZero() || !last.IsZero() || n != 0 {
		t.Fatal("empty store should report zero range")
	}
}

func TestDeltaOnlyStoresChanges(t *testing.T) {
	st := New(time.Hour, 10)
	nodes := []Node{{Name: "a"}, {Name: "b"}}
	pods := []Pod{pod("p1", "a"), pod("p2", "b")}
	st.Add(snap(0, nodes, pods))
	st.Add(snap(1, nodes, pods))
	d := st.entries[1].d
	if len(d.nodesSet)+len(d.nodesDel)+len(d.podsSet)+len(d.podsDel) != 0 {
		t.Fatalf("unchanged sample stored changes: %+v", d)
	}
	moved := []Pod{pod("p1", "b"), pod("p2", "b")}
	moved[0].GPUDevices = []GPUDevice{{UUID: "GPU-1", MemoryMiB: 1000}}
	st.Add(snap(2, nodes, moved))
	if d := st.entries[2].d; len(d.podsSet) != 1 {
		t.Fatalf("want one changed pod, got %+v", d.podsSet)
	}
}

func TestPodEqual(t *testing.T) {
	a := pod("p", "n")
	a.GPUDevices = []GPUDevice{{UUID: "x", MemoryMiB: 1}}
	b := a
	b.GPUDevices = []GPUDevice{{UUID: "x", MemoryMiB: 1}}
	if !podEqual(a, b) {
		t.Fatal("equal pods differ")
	}
	b.GPUDevices = []GPUDevice{{UUID: "y", MemoryMiB: 1}}
	if podEqual(a, b) {
		t.Fatal("different device uuid compared equal")
	}
	b.GPUDevices = nil
	if podEqual(a, b) {
		t.Fatal("different device count compared equal")
	}
	c := a
	c.CPUCores = 3
	if podEqual(a, c) {
		t.Fatal("different cpu compared equal")
	}
}

func TestEvents(t *testing.T) {
	st := New(24*time.Hour, 2)
	a := Node{Name: "a", NodePool: "gpu", InstanceType: "g6e.xlarge", CapacityType: "spot"}
	b := Node{Name: "b", NodePool: "gpu", InstanceType: "g6e.2xlarge", CapacityType: "on-demand"}
	aMarked := a
	aMarked.DisruptionReason = "Underutilized"
	st.Add(snap(0, []Node{a}, []Pod{pod("web-0", "a"), pod("web-1", "a")}))
	st.Add(snap(1, []Node{aMarked, b}, []Pod{pod("web-0", "a"), pod("web-1", "a")}))
	st.Add(snap(2, []Node{b}, []Pod{pod("web-0", "b"), {Namespace: "default", Name: "web-1"}}))
	st.Add(snap(3, []Node{b}, []Pod{pod("web-0", "b"), pod("web-1", "b")}))

	ev := st.Events(time.Time{})
	if len(ev) != 3 {
		t.Fatalf("want 3 events, got %d: %+v", len(ev), ev)
	}
	if ev[0].Type != "node-added" || ev[0].Node != "b" || ev[0].InstanceType != "g6e.2xlarge" || !ev[0].At.Equal(t0.Add(time.Minute)) {
		t.Errorf("launch event %+v", ev[0])
	}
	if ev[1].Type != "node-removed" || ev[1].Node != "a" || ev[1].Reason != "Underutilized" || ev[1].Pods != 2 || ev[1].CapacityType != "spot" {
		t.Errorf("termination event %+v", ev[1])
	}
	if ev[2].Type != "pod-moved" || ev[2].Pod != "default/web-0" || ev[2].From != "a" || ev[2].To != "b" {
		t.Errorf("move event %+v", ev[2])
	}
	// Pending (empty node) pods are not moves: web-1 went a → "" → b.
	if late := st.Events(t0.Add(time.Minute)); len(late) != 2 {
		t.Errorf("since filter: got %+v", late)
	}
	if none := st.Events(t0.Add(time.Hour)); len(none) != 0 {
		t.Errorf("want no events after the last sample, got %+v", none)
	}
}

func TestConcurrentAccess(t *testing.T) {
	st := New(time.Hour, 3)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := 0; i < 200; i++ {
			st.Add(snap(i, []Node{{Name: "a"}}, []Pod{pod("p", "a")}))
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < 200; i++ {
			st.At(t0.Add(time.Duration(i) * time.Minute))
			st.Events(t0)
			st.Range()
		}
	}()
	wg.Wait()
}
