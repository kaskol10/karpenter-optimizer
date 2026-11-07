package placementdurable

import (
	"context"
	"testing"
	"time"
)

func TestNewPostgresRejectsUnreachableDSN(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := NewPostgres(ctx, "postgres://user:pass@127.0.0.1:1/db?sslmode=disable", 24*time.Hour); err == nil {
		t.Fatal("want an error for an unreachable database")
	}
}

var _ Store = (*PostgresStore)(nil)
