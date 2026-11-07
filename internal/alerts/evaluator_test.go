package alerts

import (
	"path/filepath"
	"testing"
	"time"
)

// clock is a controllable clock for the state machine tests.
type clock struct{ t time.Time }

func (c *clock) now() time.Time          { return c.t }
func (c *clock) advance(d time.Duration) { c.t = c.t.Add(d) }

// costCfg returns a config with only the cost-spike condition enabled and a
// 2m `for` window.
func costCfg() Config {
	cfg := defaultConfig()
	cfg.Enabled = true
	cfg.CostSpike = ConditionConfig{Enabled: true, For: "2m", CostSpikePct: 50}
	return cfg
}

// costSnap builds a cost-spike snapshot (baseline 10, current 15 = +50%).
func costSnap(current, baseline float64) Snapshot {
	return Snapshot{
		CostPerHour:     current,
		Cost24hAverage:  baseline,
		HasCostBaseline: baseline > 0,
	}
}

func byStatus(transitions []Transition) map[string]int {
	out := map[string]int{}
	for _, t := range transitions {
		out[t.Status]++
	}
	return out
}

func TestEvaluator_CostSpikeLifecycle(t *testing.T) {
	clk := &clock{t: time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)}
	e := NewEvaluator(clk.now)
	cfg := costCfg()

	cases := []struct {
		name      string
		advance   time.Duration
		snap      Snapshot
		want      map[string]int
		wantTotal int
	}{
		{"below threshold, nothing", 0, costSnap(11, 10), nil, 0},
		{"first breach goes pending, no fire yet", 60 * time.Second, costSnap(16, 10), nil, 0},
		{"held under for-window, still no fire", 60 * time.Second, costSnap(16, 10), nil, 0},
		{"held for full for-window -> fires", 60 * time.Second, costSnap(17, 10), map[string]int{StatusFiring: 1}, 1},
		{"still breaching, no duplicate fire", 60 * time.Second, costSnap(18, 10), nil, 0},
		{"drops below -> clearing (no resolve yet)", 60 * time.Second, costSnap(11, 10), nil, 0},
		{"brief blip back up -> back to firing, no new fire", 60 * time.Second, costSnap(16, 10), nil, 0},
		{"clears again -> clearing (held-clear starts)", 60 * time.Second, costSnap(11, 10), nil, 0},
		{"held clear for full for-window -> resolves", 180 * time.Second, costSnap(11, 10), map[string]int{StatusResolved: 1}, 1},
		{"clear, nothing further", 120 * time.Second, costSnap(11, 10), nil, 0},
		{"breaches again -> pending (no fire this tick)", 60 * time.Second, costSnap(16, 10), nil, 0},
		{"held for for-window -> fires again", 180 * time.Second, costSnap(16, 10), map[string]int{StatusFiring: 1}, 1},
	}

	for i, tc := range cases {
		if tc.advance > 0 {
			clk.advance(tc.advance)
		}
		got := e.Evaluate(cfg, tc.snap)
		gotMap := byStatus(got)
		if len(got) != tc.wantTotal {
			t.Fatalf("step %d (%s): got %d transitions, want %d (map=%v)", i, tc.name, len(got), tc.wantTotal, gotMap)
		}
		for status, n := range tc.want {
			if gotMap[status] != n {
				t.Fatalf("step %d (%s): status %s = %d, want %d (map=%v)", i, tc.name, status, gotMap[status], n, gotMap)
			}
		}
	}
}

func TestEvaluator_MinForFloor(t *testing.T) {
	clk := &clock{t: time.Now()}
	e := NewEvaluator(clk.now)
	cfg := costCfg()
	cfg.CostSpike.For = "5s" // below the 30s floor -> should be floored to 30s

	e.Evaluate(cfg, costSnap(16, 10))
	clk.advance(10 * time.Second)
	if got := e.Evaluate(cfg, costSnap(16, 10)); len(got) != 0 {
		t.Fatalf("condition fired before the 30s minimum held: %v", got)
	}
	clk.advance(25 * time.Second)
	if got := e.Evaluate(cfg, costSnap(16, 10)); len(got) != 1 || got[0].Status != StatusFiring {
		t.Fatalf("expected exactly one firing at 35s, got %v", got)
	}
}

func TestEvaluator_DisabledConditionIgnored(t *testing.T) {
	clk := &clock{t: time.Now()}
	e := NewEvaluator(clk.now)
	cfg := costCfg()
	cfg.CostSpike.Enabled = false

	clk.advance(time.Hour)
	if got := e.Evaluate(cfg, costSnap(100, 10)); len(got) != 0 {
		t.Fatalf("disabled condition produced transitions: %v", got)
	}
}

func TestEvaluator_GatewayCondition(t *testing.T) {
	clk := &clock{t: time.Now()}
	e := NewEvaluator(clk.now)
	cfg := defaultConfig()
	cfg.Enabled = true
	cfg.Gateway = ConditionConfig{Enabled: true, For: "1m", GatewayErrorRatePct: 5, GatewayRejected: 100}

	snap := Snapshot{GatewayOnline: true, GatewayErrorRatePct: 12.5}
	e.Evaluate(cfg, snap) // pending
	clk.advance(30 * time.Second)
	e.Evaluate(cfg, snap)         // still pending
	clk.advance(45 * time.Second) // >1m total
	got := e.Evaluate(cfg, snap)
	if len(got) != 1 || got[0].Status != StatusFiring || got[0].Severity != SeverityCritical {
		t.Fatalf("gateway condition did not fire: %v", got)
	}
}

func TestEvaluator_RestartSafety(t *testing.T) {
	clk := &clock{t: time.Now()}
	e := NewEvaluator(clk.now)
	cfg := costCfg()

	// Fire an alert.
	e.Evaluate(cfg, costSnap(16, 10))
	clk.advance(time.Minute)
	e.Evaluate(cfg, costSnap(16, 10))
	clk.advance(time.Minute)
	if got := e.Evaluate(cfg, costSnap(16, 10)); len(got) != 1 || got[0].Status != StatusFiring {
		t.Fatalf("setup: expected a firing, got %v", got)
	}

	// Simulate a restart: load the persisted state into a fresh evaluator.
	e2 := NewEvaluator(clk.now)
	e2.Load(e.StateMap())

	// Immediately after restart the alert must NOT re-fire.
	if got := e2.Evaluate(cfg, costSnap(15, 10)); len(got) != 0 {
		t.Fatalf("restart caused a duplicate fire: %v", got)
	}
}

func TestEvaluator_Firing(t *testing.T) {
	clk := &clock{t: time.Now()}
	e := NewEvaluator(clk.now)
	cfg := costCfg()
	if got := e.Firing(); len(got) != 0 {
		t.Fatalf("nothing should fire yet: %v", got)
	}
	e.Evaluate(cfg, costSnap(16, 10)) // pending
	if got := e.Firing(); len(got) != 0 {
		t.Fatalf("pending is not firing: %v", got)
	}
	clk.advance(10 * time.Minute)
	e.Evaluate(cfg, costSnap(16, 10))
	got := e.Firing()
	if len(got) != 1 || got[0].ID == "" || got[0].Title == "" || !got[0].Since.Equal(clk.t) {
		t.Fatalf("want one firing alert stamped now, got %+v", got)
	}
	// Recovering but inside the held-clear window still counts as firing.
	clk.advance(time.Minute)
	e.Evaluate(cfg, costSnap(11, 10))
	if got := e.Firing(); len(got) != 1 {
		t.Fatalf("clearing should still count: %+v", got)
	}
	clk.advance(time.Hour)
	e.Evaluate(cfg, costSnap(11, 10))
	if got := e.Firing(); len(got) != 0 {
		t.Fatalf("cleared should not count: %+v", got)
	}
}

func TestManager_Status(t *testing.T) {
	m := NewManager(filepath.Join(t.TempDir(), "alerts.json"))
	if enabled, firing := m.Status(); enabled || len(firing) != 0 {
		t.Fatalf("default config should be disabled, got %v %v", enabled, firing)
	}
	cfg := costCfg()
	cfg.Channels = []ChannelConfig{{Type: "webhook", URL: "https://example.com/hook"}}
	if err := m.UpdateConfig(cfg); err != nil {
		t.Fatal(err)
	}
	if enabled, firing := m.Status(); !enabled || firing == nil || len(firing) != 0 {
		t.Fatalf("enabled with nothing firing, got %v %v", enabled, firing)
	}
}
