package placementdurable

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/karpenter-optimizer/internal/placementhistory"
)

// PostgresStore is a Store in Postgres (e.g. the chart's CNPG instance).
type PostgresStore struct {
	pool      *pgxpool.Pool
	retention time.Duration
	now       func() time.Time
}

const schema = `
CREATE TABLE IF NOT EXISTS placement_history (
    t TIMESTAMPTZ PRIMARY KEY,
    keyframe BOOLEAN NOT NULL,
    body JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_placement_history_keyframe ON placement_history (t) WHERE keyframe;
`

// keepFrom is the earliest time a rebuild of [cutoff, now] needs: the
// latest keyframe at or before cutoff, else cutoff itself.
const keepFrom = `COALESCE((SELECT max(t) FROM placement_history WHERE keyframe AND t <= $1), $1)`

// NewPostgres connects, checks the connection and creates the table. It
// returns an error when the database is unreachable, so the caller keeps
// history in memory only.
func NewPostgres(ctx context.Context, dsn string, retention time.Duration) (*PostgresStore, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, fmt.Errorf("placementdurable: new pool: %w", err)
	}
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("placementdurable: ping: %w", err)
	}
	schemaCtx, sCancel := context.WithTimeout(ctx, 10*time.Second)
	defer sCancel()
	if _, err := pool.Exec(schemaCtx, schema); err != nil {
		pool.Close()
		return nil, fmt.Errorf("placementdurable: schema: %w", err)
	}
	return &PostgresStore{pool: pool, retention: retention, now: time.Now}, nil
}

// Add stores a record and purges what no rebuild needs any more (every row
// before the keyframe that starts the retention window). The purge is
// best-effort.
func (p *PostgresStore) Add(rec placementhistory.Record) error {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if _, err := p.pool.Exec(ctx,
		`INSERT INTO placement_history (t, keyframe, body) VALUES ($1, $2, $3) ON CONFLICT (t) DO NOTHING`,
		rec.At, rec.Keyframe, rec.Body); err != nil {
		return err
	}
	cutoff := p.now().Add(-p.retention)
	_, _ = p.pool.Exec(ctx, `DELETE FROM placement_history WHERE t < `+keepFrom, cutoff)
	return nil
}

// Load returns the records from the keyframe that starts the window onward.
func (p *PostgresStore) Load(now time.Time, retention time.Duration) ([]placementhistory.Record, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	rows, err := p.pool.Query(ctx,
		`SELECT t, keyframe, body FROM placement_history WHERE t >= `+keepFrom+` ORDER BY t`,
		now.Add(-retention))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []placementhistory.Record
	for rows.Next() {
		var r placementhistory.Record
		if err := rows.Scan(&r.At, &r.Keyframe, &r.Body); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// Close closes the pool.
func (p *PostgresStore) Close() error {
	p.pool.Close()
	return nil
}
