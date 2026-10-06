package servinghistory

import (
	"testing"
	"time"
)

func TestSeriesFiltersByWindowAndIsolatesPods(t *testing.T) {
	t.Parallel()

	store := New(24 * time.Hour) // #given: generous retention so adds don't prune
	now := time.Now()
	a := []string{"ns", "pod-a"}
	b := []string{"ns", "pod-b"}

	store.Add(a[0], a[1], Point{Unix: now.Add(-2 * time.Hour).Unix()})
	store.Add(a[0], a[1], Point{Unix: now.Add(-30 * time.Minute).Unix()})
	store.Add(b[0], b[1], Point{Unix: now.Add(-1 * time.Minute).Unix()})

	// #when
	recentA := store.Series(a[0], a[1], 1*time.Hour)
	allA := store.Series(a[0], a[1], 24*time.Hour)
	allB := store.Series(b[0], b[1], 24*time.Hour)

	// #then
	if len(recentA) != 1 {
		t.Fatalf("expected 1 point for pod-a in 1h window, got %d", len(recentA))
	}
	if len(allA) != 2 {
		t.Fatalf("expected 2 points for pod-a in 24h window, got %d", len(allA))
	}
	if len(allB) != 1 {
		t.Fatalf("expected 1 point for pod-b (isolated from pod-a), got %d", len(allB))
	}
	if allA[0].Unix > allA[1].Unix {
		t.Fatalf("expected oldest-first order, got %v", allA)
	}
}

func TestAddPrunesOldPointsPerPod(t *testing.T) {
	t.Parallel()

	store := New(10 * time.Minute)
	now := time.Now()

	store.Add("ns", "pod", Point{Unix: now.Add(-1 * time.Hour).Unix()})
	store.Add("ns", "pod", Point{Unix: now.Add(-30 * time.Minute).Unix()})

	// #when: adding a fresh point prunes anything older than 10m
	store.Add("ns", "pod", Point{Unix: now.Unix()})

	// #then
	points := store.Series("ns", "pod", 24*time.Hour)
	if len(points) != 1 {
		t.Fatalf("expected only the fresh point to remain, got %d", len(points))
	}
	if points[0].Unix != now.Unix() {
		t.Fatalf("expected the fresh point, got unix %d", points[0].Unix)
	}
}

func TestAddFillsTimestamp(t *testing.T) {
	t.Parallel()

	store := New(time.Hour)
	store.Add("ns", "pod", Point{}) // #when: zero-value point

	points := store.Series("ns", "pod", time.Hour)
	if len(points) != 1 {
		t.Fatalf("expected 1 point, got %d", len(points))
	}
	if points[0].T == "" || points[0].Unix == 0 {
		t.Fatalf("expected Add to fill T and Unix, got %+v", points[0])
	}
}

func TestPodsListsKeysWithSamples(t *testing.T) {
	t.Parallel()

	store := New(time.Hour)
	store.Add("ns", "a", Point{Unix: time.Now().Unix()})
	store.Add("ns", "b", Point{Unix: time.Now().Unix()})

	// #when
	pods := store.Pods()

	// #then
	if len(pods) != 2 {
		t.Fatalf("expected 2 pod keys, got %d: %v", len(pods), pods)
	}
}

func TestLastIssueDetectsUnhealthySamples(t *testing.T) {
	t.Parallel()

	store := New(time.Hour)
	now := time.Now()

	healthy := func(u int64) Point {
		kv := 20.0
		return Point{Unix: u, Online: true, KVCachePercent: &kv}
	}
	// #given: a healthy sample, then a waiting (busy) sample, then healthy
	store.Add("ns", "pod", healthy(now.Add(-20*time.Minute).Unix()))
	bad := healthy(now.Add(-10 * time.Minute).Unix())
	bad.Waiting = 3
	store.Add("ns", "pod", bad)
	store.Add("ns", "pod", healthy(now.Unix()))

	// #when
	last := store.LastIssue("ns", "pod", time.Hour, 85)

	// #then
	if last != now.Add(-10*time.Minute).Unix() {
		t.Fatalf("expected last issue at -10m, got unix %d", last)
	}
}

func TestLastIssueReturnsZeroWhenHealthy(t *testing.T) {
	t.Parallel()

	store := New(time.Hour)
	now := time.Now()
	kv := 50.0
	store.Add("ns", "pod", Point{Unix: now.Add(-5 * time.Minute).Unix(), Online: true, KVCachePercent: &kv})
	store.Add("ns", "pod", Point{Unix: now.Unix(), Online: true, KVCachePercent: &kv})

	// #when: nothing unhealthy
	last := store.LastIssue("ns", "pod", time.Hour, 85)

	// #then
	if last != 0 {
		t.Fatalf("expected no issue (0), got unix %d", last)
	}
}

func TestLastIssueDetectsOffline(t *testing.T) {
	t.Parallel()

	store := New(time.Hour)
	now := time.Now()
	store.Add("ns", "pod", Point{Unix: now.Add(-5 * time.Minute).Unix(), Online: false})

	// #when
	last := store.LastIssue("ns", "pod", time.Hour, 85)

	// #then
	if last != now.Add(-5*time.Minute).Unix() {
		t.Fatalf("expected offline flagged as issue, got unix %d", last)
	}
}
