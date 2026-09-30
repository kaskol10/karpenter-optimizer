// Package history keeps an in-memory, time-bounded series of cluster
// summary samples so the UI can render trend sparklines (CPU, memory, GPU
// memory, cost) without any external storage.
package history

import (
	"sync"
	"time"
)

// Point is a single cluster-wide sample. All memory values are in the same
// units as /api/v1/cluster/summary (MiB for GPU memory).
type Point struct {
	T                 string  `json:"t"` // RFC3339 timestamp
	Unix              int64   `json:"unix"`
	CPUUsed           float64 `json:"cpuUsed"`
	CPUAllocatable    float64 `json:"cpuAllocatable"`
	MemoryUsed        float64 `json:"memoryUsed"`
	MemoryAllocatable float64 `json:"memoryAllocatable"`
	GPUMemUsedMiB     float64 `json:"gpuMemUsedMiB"`
	GPUMemTotalMiB    float64 `json:"gpuMemTotalMiB"`
	GPUCapacity       float64 `json:"gpuCapacity"`
	GPUAllocated      float64 `json:"gpuAllocated"`
	Nodes             int     `json:"nodes"`
	Pods              int     `json:"pods"`
	CostUSDPerHour    float64 `json:"costUSDPerHour"`
}

// Store is a thread-safe append-only ring buffer of cluster samples.
type Store struct {
	mu        sync.RWMutex
	points    []Point
	retention time.Duration
}

// New creates a Store that retains samples for at least window.
func New(window time.Duration) *Store {
	if window <= 0 {
		window = 6 * time.Hour
	}
	return &Store{retention: window}
}

// Add appends a sample and prunes anything older than the retention window.
func (s *Store) Add(p Point) {
	if p.Unix == 0 {
		p.Unix = time.Now().Unix()
	}
	if p.T == "" {
		p.T = time.Unix(p.Unix, 0).Format(time.RFC3339)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.points = append(s.points, p)
	s.pruneLocked(time.Unix(p.Unix, 0))
}

// SetWindow updates the retention window (and prunes immediately).
func (s *Store) SetWindow(window time.Duration) {
	if window <= 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.retention = window
	s.pruneLocked(time.Now())
}

// Prune drops samples older than the retention window (used to keep pruning
// even while the sampler is stalled).
func (s *Store) Prune() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneLocked(time.Now())
}

// Series returns the samples within the requested window, oldest first.
func (s *Store) Series(window time.Duration) []Point {
	if window <= 0 {
		window = 6 * time.Hour
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	since := time.Now().Add(-window)
	out := make([]Point, 0, len(s.points))
	for _, p := range s.points {
		if time.Unix(p.Unix, 0).After(since) {
			out = append(out, p)
		}
	}
	return out
}

func (s *Store) pruneLocked(now time.Time) {
	cutoff := now.Add(-s.retention)
	n := 0
	for i, p := range s.points {
		if time.Unix(p.Unix, 0).Before(cutoff) {
			continue
		}
		if n != i {
			s.points[n] = p
		}
		n++
	}
	s.points = s.points[:n]
}
