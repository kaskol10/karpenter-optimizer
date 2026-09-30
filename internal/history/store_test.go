package history

import (
	"testing"
	"time"
)

func TestSeriesFiltersByWindow(t *testing.T) {
	t.Parallel()

	store := New(24 * time.Hour) // #given: generous retention so adds don't prune
	now := time.Now()

	store.Add(Point{Unix: now.Add(-2 * time.Hour).Unix()})
	store.Add(Point{Unix: now.Add(-30 * time.Minute).Unix()})
	store.Add(Point{Unix: now.Add(-1 * time.Minute).Unix()})

	// #when
	recent := store.Series(1 * time.Hour)
	all := store.Series(24 * time.Hour)

	// #then
	if len(recent) != 2 {
		t.Fatalf("expected 2 points in 1h window, got %d", len(recent))
	}
	if len(all) != 3 {
		t.Fatalf("expected 3 points in 24h window, got %d", len(all))
	}
	if all[0].Unix > all[1].Unix || all[1].Unix > all[2].Unix {
		t.Fatalf("expected oldest-first order, got %v", all)
	}
}

func TestAddPrunesOldPoints(t *testing.T) {
	t.Parallel()

	store := New(10 * time.Minute)
	now := time.Now()

	store.Add(Point{Unix: now.Add(-1 * time.Hour).Unix()})
	store.Add(Point{Unix: now.Add(-30 * time.Minute).Unix()})

	// #when: adding a fresh point prunes anything older than 10m
	store.Add(Point{Unix: now.Unix()})

	// #then
	points := store.Series(24 * time.Hour)
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
	store.Add(Point{}) // #when: zero-value point

	points := store.Series(time.Hour)
	if len(points) != 1 {
		t.Fatalf("expected 1 point, got %d", len(points))
	}
	if points[0].T == "" || points[0].Unix == 0 {
		t.Fatalf("expected Add to fill T and Unix, got %+v", points[0])
	}
}
