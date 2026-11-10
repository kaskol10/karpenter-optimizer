package placementhistory

import (
	"testing"
	"time"
)

func step(kind string, at, last int, count int, msg string) LifecycleStep {
	return LifecycleStep{Kind: kind, At: t0.Add(time.Duration(at) * time.Minute), Last: t0.Add(time.Duration(last) * time.Minute), Count: count, Message: msg}
}

func TestMergeStepsKeepsTheWidestView(t *testing.T) {
	known := []LifecycleStep{step("disrupted", 1, 1, 1, "Underutilized"), step("drain-failed", 1, 3, 3, "10 pods")}
	// The first FailedDraining event expired: a later first time, a lower count.
	fresh := []LifecycleStep{step("drain-failed", 2, 5, 2, "1 pods"), step("removed", 6, 6, 1, "")}
	got := mergeSteps(known, fresh)
	if len(got) != 3 || got[0].Kind != "disrupted" || got[2].Kind != "removed" {
		t.Fatalf("%+v", got)
	}
	d := got[1]
	if !d.At.Equal(t0.Add(time.Minute)) || !d.Last.Equal(t0.Add(5*time.Minute)) || d.Count != 3 || d.Message != "1 pods" {
		t.Errorf("drain step %+v", d)
	}
}

func TestLifecycleOfANodeThatLeft(t *testing.T) {
	for _, keyEvery := range []int{1, 3, 10} {
		a := Node{Name: "a", NodePool: "arm"}
		b := Node{Name: "b", NodePool: "arm"}
		samples := func() []*Snapshot {
			s1 := snap(0, []Node{a, b}, nil)
			// Steps of a live node (b) and of a node never seen are dropped.
			s1.Lifecycles = map[string][]LifecycleStep{"b": {step("drain-failed", 0, 0, 1, "")}}
			s2 := snap(2, []Node{b}, nil) // a was marked for deletion and left
			s2.Gone = map[string]string{"a": "Underutilized"}
			s2.Lifecycles = map[string][]LifecycleStep{
				"a":     {step("disrupted", 1, 1, 1, "Underutilized"), step("drain-failed", 1, 1, 1, "10 pods")},
				"other": {step("removed", 1, 1, 1, "")},
			}
			s3 := snap(4, []Node{b}, nil) // it is still draining
			s3.Lifecycles = map[string][]LifecycleStep{"a": {step("disrupted", 1, 1, 1, "Underutilized"), step("drain-failed", 1, 3, 3, "1 pods")}}
			s4 := snap(6, []Node{b}, nil) // it is gone; the first events expired
			s4.Lifecycles = map[string][]LifecycleStep{"a": {step("drain-failed", 2, 3, 2, "1 pods"), step("removed", 6, 6, 1, "")}}
			s5 := snap(8, []Node{b}, nil) // nothing new
			s5.Lifecycles = s4.Lifecycles
			return []*Snapshot{s1, s2, s3, s4, s5}
		}

		st := New(24*time.Hour, keyEvery)
		var recs []Record
		for _, s := range samples() {
			r, _ := st.Add(s)
			recs = append(recs, r)
		}
		if keyEvery == 10 && len(recs[4].Body) > len(recs[3].Body) {
			t.Errorf("an unchanged lifecycle should not be saved again")
		}
		check := func(label string, st *Store) {
			t.Helper()
			ev := st.Events(time.Time{})
			if len(ev) != 1 || ev[0].Node != "a" || ev[0].Reason != "Underutilized" {
				t.Fatalf("%s keyEvery=%d: %+v", label, keyEvery, ev)
			}
			lc := ev[0].Lifecycle
			if len(lc) != 3 || lc[0].Kind != "disrupted" || lc[1].Kind != "drain-failed" || lc[1].Count != 3 || lc[2].Kind != "removed" {
				t.Fatalf("%s keyEvery=%d lifecycle: %+v", label, keyEvery, lc)
			}
			if ev[0].GoneAt == nil || !ev[0].GoneAt.Equal(t0.Add(6*time.Minute)) || !ev[0].At.Equal(t0.Add(2*time.Minute)) {
				t.Errorf("%s keyEvery=%d left at %v, gone at %v", label, keyEvery, ev[0].At, ev[0].GoneAt)
			}
			if _, ok := st.lifecycles["b"]; ok {
				t.Errorf("%s: a live node's steps were kept", label)
			}
			if _, ok := st.lifecycles["other"]; ok {
				t.Errorf("%s: an unknown node's steps were kept", label)
			}
		}
		check("live", st)
		restored := New(24*time.Hour, keyEvery)
		restored.Load(recs, t0.Add(10*time.Minute))
		check("restored", restored)
	}
}

func TestLifecycleForgottenWhenTheNameComesBackOrExpires(t *testing.T) {
	a := Node{Name: "a"}
	st := New(time.Hour, 100)
	st.Add(snap(0, []Node{a}, nil))
	gone := snap(1, nil, nil)
	gone.Lifecycles = map[string][]LifecycleStep{"a": {step("removed", 1, 1, 1, "")}}
	st.Add(gone)
	if len(st.lifecycles) != 1 {
		t.Fatal("lifecycle not tracked")
	}
	st.Add(snap(2, []Node{a}, nil)) // a new node under the same name
	if len(st.lifecycles) != 0 {
		t.Error("a reused name kept the old lifecycle")
	}

	st.Add(snap(3, nil, nil)) // it leaves with no event yet (deleted by hand)
	later := snap(5, nil, nil)
	later.Lifecycles = map[string][]LifecycleStep{"a": {step("removed", 4, 4, 1, "")}}
	st.Add(later)
	if steps := st.lifecycles["a"]; len(steps) != 1 || steps[0].Kind != "removed" {
		t.Fatalf("steps logged after the node left were dropped: %+v", st.lifecycles)
	}
	st.Add(snap(3*60, nil, nil)) // past the hour of retention
	if len(st.lifecycles) != 0 || len(st.departed) != 0 {
		t.Errorf("an expired lifecycle was kept: %+v %+v", st.lifecycles, st.departed)
	}
}

// After a restart whose oldest record is a keyframe taken after the node
// left, its later steps are still accepted.
func TestLifecycleRestoredFromALaterKeyframe(t *testing.T) {
	a := Node{Name: "a"}
	st := New(24*time.Hour, 2)
	var recs []Record
	add := func(s *Snapshot) {
		r, _ := st.Add(s)
		recs = append(recs, r)
	}
	add(snap(0, []Node{a}, nil)) // keyframe
	add(snap(1, nil, nil))       // delta: a left
	add(snap(2, nil, nil))       // keyframe
	if !recs[2].Keyframe {
		t.Fatal("want a keyframe")
	}
	restored := New(24*time.Hour, 2)
	restored.Load(recs[2:], t0.Add(3*time.Minute))
	next := snap(3, nil, nil)
	next.Lifecycles = map[string][]LifecycleStep{"a": {step("removed", 3, 3, 1, "")}}
	restored.Add(next)
	if len(restored.lifecycles["a"]) != 1 {
		t.Errorf("departure lost across the restart: %+v", restored.departed)
	}
}
