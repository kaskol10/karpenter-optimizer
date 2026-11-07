package placementhistory

import (
	"encoding/json"
	"testing"
	"time"
)

// sample builds four snapshots that exercise node and pod adds, moves,
// deletes and GPU devices.
func sampleSnapshots() []*Snapshot {
	a := Node{Name: "a", NodePool: "gpu", GPUCapacity: 4, GPUMemTotalMiB: 184320, HamiDetected: true}
	b := Node{Name: "b", NodePool: "gpu", CapacityType: "spot"}
	gpuPod := pod("vllm-0", "a")
	gpuPod.GPUDevices = []GPUDevice{{UUID: "GPU-1", Model: "L40S", Index: 0, MemoryMiB: 45000}}
	moved := gpuPod
	moved.Node = "b"
	moved.GPUDevices = nil
	aGone := a
	aGone.DisruptionReason = "Drifted"
	return []*Snapshot{
		snap(0, []Node{a}, []Pod{gpuPod, pod("web-0", "a")}),
		snap(1, []Node{aGone, b}, []Pod{gpuPod, pod("web-0", "a")}),
		snap(2, []Node{b}, []Pod{moved}),
		snap(3, []Node{b}, []Pod{moved, pod("web-1", "b")}),
	}
}

func TestRecordsRestoreTheSameHistory(t *testing.T) {
	orig := New(24*time.Hour, 3)
	var recs []Record
	for _, s := range sampleSnapshots() {
		r, ok := orig.Add(s)
		if !ok {
			t.Fatal("sample rejected")
		}
		recs = append(recs, r)
	}
	if !recs[0].Keyframe || recs[1].Keyframe || recs[2].Keyframe || !recs[3].Keyframe {
		t.Fatalf("keyframe pattern: %v %v %v %v", recs[0].Keyframe, recs[1].Keyframe, recs[2].Keyframe, recs[3].Keyframe)
	}
	if _, ok := orig.Add(snap(3, nil, nil)); ok {
		t.Fatal("a sample not after the last should be rejected")
	}

	// Shuffled, as a database might return them.
	shuffled := []Record{recs[2], recs[0], recs[3], recs[1]}
	restored := New(24*time.Hour, 3)
	if n := restored.Load(shuffled, t0.Add(5*time.Minute)); n != 4 {
		t.Fatalf("restored %d entries, want 4", n)
	}
	for m := 0; m <= 3; m++ {
		at := t0.Add(time.Duration(m) * time.Minute)
		want, _ := orig.At(at)
		got, ok := restored.At(at)
		if !ok {
			t.Fatalf("min %d missing after restore", m)
		}
		wb, _ := json.Marshal(wireSnapshot{nodeList(want.Nodes), podList(want.Pods)})
		gb, _ := json.Marshal(wireSnapshot{nodeList(got.Nodes), podList(got.Pods)})
		if string(wb) != string(gb) {
			t.Fatalf("min %d differs:\nwant %s\ngot  %s", m, wb, gb)
		}
	}
	if len(restored.Events(time.Time{})) != len(orig.Events(time.Time{})) {
		t.Fatal("events differ after restore")
	}

	// Sampling continues from the restored state: next is a delta (one
	// sample since the keyframe at min 3, keyEvery 3).
	r, ok := restored.Add(snap(4, []Node{{Name: "b", NodePool: "gpu", CapacityType: "spot"}}, nil))
	if !ok || r.Keyframe {
		t.Fatalf("want a delta after restore, got keyframe=%v ok=%v", r.Keyframe, ok)
	}
}

func TestLoadSkipsWhatItCannotRebuild(t *testing.T) {
	orig := New(24*time.Hour, 10)
	var recs []Record
	for _, s := range sampleSnapshots() {
		r, _ := orig.Add(s)
		recs = append(recs, r)
	}
	now := t0.Add(5 * time.Minute)

	// Leading deltas without their keyframe: nothing to rebuild from.
	if n := New(24*time.Hour, 10).Load(recs[1:], now); n != 0 {
		t.Fatalf("deltas alone restored %d", n)
	}
	// A corrupt record and a duplicate time are skipped.
	bad := Record{At: recs[1].At.Add(time.Second), Body: []byte("{")}
	dup := recs[1]
	st := New(24*time.Hour, 10)
	if n := st.Load([]Record{recs[0], recs[1], dup, bad, {At: t0.Add(30 * time.Second), Keyframe: true, Body: []byte("[")}}, now); n != 2 {
		t.Fatalf("restored %d, want 2", n)
	}
	// Everything older than the retention: nothing.
	if n := New(time.Minute, 10).Load(recs, t0.Add(time.Hour)); n != 0 {
		t.Fatalf("stale records restored %d", n)
	}
	// Empty input, or a store that already has samples.
	if n := New(time.Hour, 10).Load(nil, now); n != 0 {
		t.Fatal("empty load")
	}
	busy := New(time.Hour, 10)
	busy.Add(snap(9, nil, nil))
	if n := busy.Load(recs, now); n != 0 {
		t.Fatal("load into a used store")
	}
}

func TestForceKeyframe(t *testing.T) {
	st := New(time.Hour, 100)
	st.Add(snap(0, []Node{{Name: "a"}}, nil))
	if r, _ := st.Add(snap(1, []Node{{Name: "a"}}, nil)); r.Keyframe {
		t.Fatal("second sample should be a delta")
	}
	st.ForceKeyframe()
	if r, _ := st.Add(snap(2, []Node{{Name: "a"}}, nil)); !r.Keyframe {
		t.Fatal("forced sample should be a keyframe")
	}
	if r, _ := st.Add(snap(3, []Node{{Name: "a"}}, nil)); r.Keyframe {
		t.Fatal("force applies once")
	}
}
