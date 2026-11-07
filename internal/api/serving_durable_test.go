package api

import (
	"testing"
	"time"

	"github.com/karpenter-optimizer/internal/servingdurable"
	"github.com/karpenter-optimizer/internal/servinghistory"
	"github.com/stretchr/testify/assert"
)

func TestParseServingHistoryWindowInMemoryCappedAt24h(t *testing.T) {
	assert.Equal(t, 6*time.Hour, parseServingHistoryWindow("", false))
	assert.Equal(t, time.Hour, parseServingHistoryWindow("1h", false))
	assert.Equal(t, 24*time.Hour, parseServingHistoryWindow("48h", false))
	assert.Equal(t, 24*time.Hour, parseServingHistoryWindow("7d", false))
	assert.Equal(t, 6*time.Hour, parseServingHistoryWindow("garbage", false))
}

func TestParseServingHistoryWindowDurableAllows7d(t *testing.T) {
	assert.Equal(t, 24*time.Hour, parseServingHistoryWindow("24h", true))
	assert.Equal(t, 7*24*time.Hour, parseServingHistoryWindow("7d", true))
	assert.Equal(t, 7*24*time.Hour, parseServingHistoryWindow("14d", true))
	assert.Equal(t, 72*time.Hour, parseServingHistoryWindow("72h", true))
}

func TestMergeServingHistoryCombinesAndDedups(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	durable := []servingdurable.Point{
		{PodKey: "ai/vllm-0", T: now.Add(-72 * time.Hour), Online: true, Running: 3},
		{PodKey: "ai/vllm-0", T: now.Add(-70 * time.Hour), Online: false},
		{PodKey: "ai/vllm-0", T: now.Add(-10 * time.Hour), Online: true, KVCachePercent: floatPtr(87)},
	}
	mem := []servinghistory.Point{
		// Overlaps the durable -10h sample: in-memory wins (dropped from durable).
		{Unix: now.Add(-10 * time.Hour).Unix(), Online: true, KVCachePercent: floatPtr(90)},
		{Unix: now.Add(-1 * time.Hour).Unix(), Online: true},
	}
	since := now.Add(-96 * time.Hour)
	got := mergeServingHistory(durable, mem, since)

	// 3 durable (one overlapped) + 2 mem (one new) = 4 unique points.
	assert.Len(t, got, 4)
	assert.Equal(t, now.Add(-72*time.Hour).Unix(), got[0].Unix)
	assert.Equal(t, now.Add(-1*time.Hour).Unix(), got[len(got)-1].Unix)
	// Oldest first.
	for i := 1; i < len(got); i++ {
		assert.LessOrEqual(t, got[i-1].Unix, got[i].Unix)
	}
	// In-memory value won for the overlapping timestamp.
	var kv *float64
	for _, p := range got {
		if p.Unix == now.Add(-10*time.Hour).Unix() {
			kv = p.KVCachePercent
		}
	}
	requireNotNil(t, kv)
	assert.Equal(t, 90.0, *kv)
}

func TestMergeServingHistoryInMemoryOnly(t *testing.T) {
	mem := []servinghistory.Point{{Unix: 100, Online: true}, {Unix: 200, Online: false}}
	got := mergeServingHistory(nil, mem, time.Unix(0, 0))
	assert.Len(t, got, 2)
}

func TestLastIssueFromSeries(t *testing.T) {
	pts := []servinghistory.Point{
		{Unix: 10, Online: true, Waiting: 2},
		{Unix: 20, Online: false},
		{Unix: 30, Online: true, KVCachePercent: floatPtr(90)},
		{Unix: 40, Online: true},
	}
	assert.Equal(t, int64(30), servinghistory.LastIssueIn(pts, 85))
	assert.Equal(t, int64(0), servinghistory.LastIssueIn([]servinghistory.Point{{Unix: 1, Online: true}}, 85))
}

func TestAppendServingDurableNoopWithoutStore(t *testing.T) {
	server := setupTestServer()
	// No durable store configured: must not panic.
	server.appendServingDurable(nil)
}

func requireNotNil(t *testing.T, p *float64) {
	t.Helper()
	assert.NotNil(t, p)
}
