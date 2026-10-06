// Package servinghistory keeps an in-memory, time-bounded series of per-pod
// inference samples so the Serving UI can render trend sparklines and answer
// "when was the last time this model had an issue?" without any external
// storage. It mirrors the cluster-level history.Store but is keyed per
// serving pod (namespace/name).
package servinghistory

import (
	"sync"
	"time"
)

// Point is a single sample of one serving pod's inference health at a
// timestamp. Pointer fields mirror llmhealth.PodHealth: nil means "unknown /
// not emitted by this vLLM version".
type Point struct {
	T              string   `json:"t"` // RFC3339 timestamp
	Unix           int64    `json:"unix"`
	Online         bool     `json:"online"`
	KVCachePercent *float64 `json:"kvCachePercent,omitempty"` // 0-100
	Running        int      `json:"running"`
	Waiting        int      `json:"waiting"`
	Preemptions    int64    `json:"preemptions"`
	TTFTSeconds    *float64 `json:"ttftSeconds,omitempty"`
	TTFTP95Seconds *float64 `json:"ttftP95Seconds,omitempty"`
	E2ESeconds     *float64 `json:"e2eSeconds,omitempty"`
	E2EP95Seconds  *float64 `json:"e2eP95Seconds,omitempty"`
	TokensPerSec   *float64 `json:"tokensPerSec,omitempty"`
	RequestsPerSec *float64 `json:"requestsPerSec,omitempty"`
}

// key is the per-pod identifier used to partition the store.
func key(namespace, name string) string { return namespace + "/" + name }

// Store is a thread-safe append-only ring buffer of per-pod serving samples.
type Store struct {
	mu        sync.RWMutex
	points    map[string][]Point
	retention time.Duration
}

// New creates a Store that retains samples for at least window.
func New(window time.Duration) *Store {
	if window <= 0 {
		window = 6 * time.Hour
	}
	return &Store{
		points:    make(map[string][]Point),
		retention: window,
	}
}

// Add appends a sample for one pod and prunes anything older than the
// retention window across all pods.
func (s *Store) Add(namespace, name string, p Point) {
	k := key(namespace, name)
	if p.Unix == 0 {
		p.Unix = time.Now().Unix()
	}
	if p.T == "" {
		p.T = time.Unix(p.Unix, 0).Format(time.RFC3339)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.points[k] = append(s.points[k], p)
	now := time.Unix(p.Unix, 0)
	for pk, pts := range s.points {
		s.points[pk] = s.pruneLocked(pts, now)
	}
}

// SetWindow updates the retention window (and prunes immediately).
func (s *Store) SetWindow(window time.Duration) {
	if window <= 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.retention = window
	now := time.Now()
	for pk, pts := range s.points {
		s.points[pk] = s.pruneLocked(pts, now)
	}
}

// Prune drops samples older than the retention window (used to keep pruning
// even while the sampler is stalled).
func (s *Store) Prune() {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	for pk, pts := range s.points {
		s.points[pk] = s.pruneLocked(pts, now)
	}
}

// Series returns the samples for one pod within the requested window, oldest
// first. Returns nil when the pod has no samples.
func (s *Store) Series(namespace, name string, window time.Duration) []Point {
	k := key(namespace, name)
	if window <= 0 {
		window = 6 * time.Hour
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	pts := s.points[k]
	if len(pts) == 0 {
		return nil
	}
	since := time.Now().Add(-window)
	out := make([]Point, 0, len(pts))
	for _, p := range pts {
		if time.Unix(p.Unix, 0).After(since) {
			out = append(out, p)
		}
	}
	return out
}

// Pods returns the set of pod keys that currently have at least one sample.
func (s *Store) Pods() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]string, 0, len(s.points))
	for k, pts := range s.points {
		if len(pts) > 0 {
			out = append(out, k)
		}
	}
	return out
}

// LastIssue returns the timestamp (Unix) of the most recent sample for a pod
// that was "unhealthy" within the window, or 0 if none. Unhealthy means: the
// pod was offline, had waiting requests, had preemptions, or had KV cache
// above the given threshold.
func (s *Store) LastIssue(namespace, name string, window time.Duration, kvThresholdPct float64) int64 {
	if window <= 0 {
		window = 6 * time.Hour
	}
	var last int64
	for _, p := range s.Series(namespace, name, window) {
		unhealthy := !p.Online || p.Waiting > 0 || p.Preemptions > 0
		if !unhealthy && p.KVCachePercent != nil && *p.KVCachePercent >= kvThresholdPct {
			unhealthy = true
		}
		if unhealthy && p.Unix > last {
			last = p.Unix
		}
	}
	return last
}

func (s *Store) pruneLocked(pts []Point, now time.Time) []Point {
	cutoff := now.Add(-s.retention)
	n := 0
	for i, p := range pts {
		if time.Unix(p.Unix, 0).Before(cutoff) {
			continue
		}
		if n != i {
			pts[n] = p
		}
		n++
	}
	if n == 0 {
		return nil
	}
	return pts[:n]
}
