package api

import (
	"context"
	"testing"
	"time"

	"github.com/karpenter-optimizer/internal/history"
)

// newCostSnapshotServer builds a Server with only what buildAlertSnapshot
// needs: a cluster history store. No k8s client (serving/gateway sections are
// skipped), no serving store.
func newCostSnapshotServer(points ...history.Point) *Server {
	s := &Server{historyStore: history.New(24 * time.Hour)}
	for _, p := range points {
		s.historyStore.Add(p)
	}
	return s
}

// costPointAt builds a cluster sample `minsAgo` minutes in the past.
func costPointAt(minsAgo int, cost float64, unknown bool) history.Point {
	now := time.Now()
	return history.Point{
		T:           now.Add(-time.Duration(minsAgo) * time.Minute).Format(time.RFC3339),
		Unix:        now.Add(-time.Duration(minsAgo) * time.Minute).Unix(),
		CostPerHour: cost,
		CostUnknown: unknown,
	}
}

// TestAlertSnapshotCostBaselineUnknownLatest verifies that a latest sample
// whose cost is unknown (an unpriceable node counted as $0) is treated as
// no-data: the cost-spike baseline must not be computed from a partial sum,
// or a transient pricing blip would fire a fake spike.
func TestAlertSnapshotCostBaselineUnknownLatest(t *testing.T) {
	// #given — a stable priced baseline, but the latest sample is unknown.
	var points []history.Point
	for i := 20; i >= 2; i-- {
		points = append(points, costPointAt(i*30, 100, false))
	}
	points = append(points, costPointAt(0, 30, true)) // latest: partial sum (unpriced node = $0)

	s := newCostSnapshotServer(points...)

	// #when
	snap := s.buildAlertSnapshot(context.Background(), nil)

	// #then — no baseline, so no cost-spike evaluation this tick.
	if snap.HasCostBaseline {
		t.Fatal("expected no cost baseline when the latest cost sample is unknown")
	}
	if snap.CostPerHour != 0 {
		t.Fatalf("CostPerHour = %v, want 0 when the latest sample is unknown", snap.CostPerHour)
	}
}

// TestAlertSnapshotCostBaselinePriced verifies the happy path still works:
// 12+ fully-priced samples produce a baseline.
func TestAlertSnapshotCostBaselinePriced(t *testing.T) {
	// #given
	var points []history.Point
	for i := 20; i >= 2; i-- {
		points = append(points, costPointAt(i*30, 100, false))
	}
	points = append(points, costPointAt(0, 100, false))

	s := newCostSnapshotServer(points...)

	// #when
	snap := s.buildAlertSnapshot(context.Background(), nil)

	// #then
	if !snap.HasCostBaseline {
		t.Fatal("expected a cost baseline from 12+ priced samples")
	}
	if snap.CostPerHour != 100 {
		t.Fatalf("CostPerHour = %v, want 100", snap.CostPerHour)
	}
	if snap.Cost24hAverage < 99.9 || snap.Cost24hAverage > 100.1 {
		t.Fatalf("Cost24hAverage = %v, want ~100", snap.Cost24hAverage)
	}
}

// TestAlertSnapshotCostBaselineSkipsUnknownPoints verifies unknown samples
// mid-window are excluded from the baseline (they understate cost and would
// bias the average low).
func TestAlertSnapshotCostBaselineSkipsUnknownPoints(t *testing.T) {
	// #given — 19 priced points at 100, one unknown point at a bogus 10.
	var points []history.Point
	for i := 20; i >= 1; i-- {
		if i == 5 {
			points = append(points, costPointAt(i*30, 10, true)) // unknown, low partial sum
			continue
		}
		points = append(points, costPointAt(i*30, 100, false))
	}
	points = append(points, costPointAt(0, 100, false))

	s := newCostSnapshotServer(points...)

	// #when
	snap := s.buildAlertSnapshot(context.Background(), nil)

	// #then — baseline must reflect only the 19 priced points.
	if !snap.HasCostBaseline {
		t.Fatal("expected a cost baseline")
	}
	if snap.Cost24hAverage < 99.9 || snap.Cost24hAverage > 100.1 {
		t.Fatalf("Cost24hAverage = %v, want ~100 (unknown point must be excluded)", snap.Cost24hAverage)
	}
}
