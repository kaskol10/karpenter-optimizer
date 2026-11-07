// Package placementdurable keeps Topology time travel across restarts: a
// Postgres table of the placement-history records (keyframes and deltas)
// that the in-memory placementhistory.Store produces, read back into it on
// startup. Same pattern and database as servingdurable.
package placementdurable

import (
	"time"

	"github.com/karpenter-optimizer/internal/placementhistory"
)

// Store persists placement-history records. Implementations must be safe
// for concurrent use. Callers log and degrade: the in-memory store keeps
// working when the database does not.
type Store interface {
	// Add stores one record (idempotent on its time).
	Add(rec placementhistory.Record) error
	// Load returns the records needed to rebuild the last retention: every
	// record from the latest keyframe at or before now-retention onward,
	// oldest first.
	Load(now time.Time, retention time.Duration) ([]placementhistory.Record, error)
	// Close releases resources.
	Close() error
}
