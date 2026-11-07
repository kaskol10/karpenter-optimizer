package alerts

import (
	"sort"
	"time"
)

// state is one condition's position in the machine.
type state string

const (
	statePending  state = "pending"  // condition true, held less than For
	stateFiring   state = "firing"   // fired, held true
	stateClearing state = "clearing" // was firing, condition false; awaiting held-clear window
	stateCleared  state = "cleared"  // default / condition false long enough
)

const minFor = 30 * time.Second

// conditionState is the persisted, per-condition bookkeeping. It is serialized
// to disk so a restart does not re-fire (or re-clear) alerts.
type conditionState struct {
	state      state
	since      time.Time // when the current state began
	pendingAt  time.Time // when the condition last became true (for the "for" window)
	firedAt    time.Time // when it fired
	clearSince time.Time // when the condition first went false while firing (held-clear)
	lastRemind time.Time // last reminder sent while firing
}

type conditionDef struct {
	id        string
	title     string
	severity  Severity
	enabled   func(cfg Config) bool
	threshold func(cfg Config) time.Duration
	// predicate reports whether the raw condition holds right now.
	predicate func(cfg Config, snap Snapshot) (holds bool, detail string)
	// message renders the human message from the detail the predicate captured.
	message func(id string, detail string) string
}

// Evaluator holds condition state and produces the set of transitions to send.
type Evaluator struct {
	now    func() time.Time
	conds  []conditionDef
	states map[string]*conditionState
}

// Transition is one outbound event produced by an Evaluate call.
type Transition struct {
	Status   string // StatusFiring | StatusResolved | StatusReminder
	Severity Severity
	Title    string
	Alerts   []Alert
}

// NewEvaluator builds an Evaluator. now is injectable for tests.
func NewEvaluator(now func() time.Time) *Evaluator {
	if now == nil {
		now = time.Now
	}
	return &Evaluator{
		now:    now,
		conds:  conditions(),
		states: make(map[string]*conditionState),
	}
}

func (e *Evaluator) st(id string) *conditionState {
	cs := e.states[id]
	if cs == nil {
		cs = &conditionState{state: stateCleared, since: e.now()}
		e.states[id] = cs
	}
	return cs
}

// Evaluate walks every enabled condition against the snapshot and returns the
// transitions (new firings, resolutions, reminders) that occurred this tick.
func (e *Evaluator) Evaluate(cfg Config, snap Snapshot) []Transition {
	var out []Transition
	for _, def := range e.conds {
		if !def.enabled(cfg) {
			continue
		}
		forDur := def.threshold(cfg)
		if forDur < minFor {
			forDur = minFor
		}
		holds, detail := def.predicate(cfg, snap)
		cs := e.st(def.id)
		now := e.now()
		remind := remindDuration(cfg.RemindWhileFiring)

		switch cs.state {
		case stateCleared:
			if holds {
				cs.state = statePending
				cs.since = now
				cs.pendingAt = now
			}
		case statePending:
			if !holds {
				e.clear(cs, now)
			} else if now.Sub(cs.pendingAt) >= forDur {
				cs.state = stateFiring
				cs.since = now
				cs.firedAt = now
				cs.lastRemind = now
				out = append(out, Transition{
					Status:   StatusFiring,
					Severity: def.severity,
					Title:    def.title,
					Alerts:   []Alert{{ID: def.id, Title: def.title, Message: def.message(def.id, detail), Severity: def.severity, FiredAt: now.Format(time.RFC3339)}},
				})
			}
		case stateFiring:
			if !holds {
				// Held-clear: stay latched until the condition has been false
				// for the same `for` duration (prevents flapping on 1-tick
				// blips).
				cs.state = stateClearing
				cs.since = now
				cs.clearSince = now
			} else if remind > 0 && now.Sub(cs.lastRemind) >= remind {
				cs.lastRemind = now
				out = append(out, Transition{
					Status:   StatusReminder,
					Severity: def.severity,
					Title:    def.title,
					Alerts:   []Alert{{ID: def.id, Title: def.title, Message: def.message(def.id, detail) + " (still firing)", Severity: def.severity, FiredAt: cs.firedAt.Format(time.RFC3339)}},
				})
			}
		case stateClearing:
			if holds {
				// Condition re-asserted before the held-clear window elapsed:
				// back to firing (no new fire event; it never cleared).
				cs.state = stateFiring
				cs.since = now
				cs.lastRemind = now
			} else if now.Sub(cs.clearSince) >= forDur {
				cs.state = stateCleared
				cs.since = now
				out = append(out, Transition{
					Status:   StatusResolved,
					Severity: def.severity,
					Title:    def.title,
					Alerts:   []Alert{{ID: def.id, Title: def.title, Message: def.message(def.id, "resolved"), Severity: def.severity}},
				})
			}
		}
	}
	return out
}

func (e *Evaluator) clear(cs *conditionState, now time.Time) {
	cs.state = stateCleared
	cs.since = now
	cs.lastRemind = time.Time{}
	cs.clearSince = time.Time{}
}

// StateMap returns a serializable copy of the current machine for persistence.
func (e *Evaluator) StateMap() map[string]persistedState {
	out := make(map[string]persistedState, len(e.states))
	for id, cs := range e.states {
		out[id] = persistedState{
			State:      string(cs.state),
			Since:      cs.since,
			PendingAt:  cs.pendingAt,
			FiredAt:    cs.firedAt,
			ClearSince: cs.clearSince,
			LastRemind: cs.lastRemind,
		}
	}
	return out
}

// persistedState is the JSON shape of one condition's machine on disk.
type persistedState struct {
	State      string    `json:"state"`
	Since      time.Time `json:"since"`
	PendingAt  time.Time `json:"pendingAt"`
	FiredAt    time.Time `json:"firedAt"`
	ClearSince time.Time `json:"clearSince"`
	LastRemind time.Time `json:"lastRemind"`
}

// Load restores the evaluator machine from persisted state.
func (e *Evaluator) Load(m map[string]persistedState) {
	for id, ps := range m {
		cs := &conditionState{
			state:      state(ps.State),
			since:      ps.Since,
			pendingAt:  ps.PendingAt,
			firedAt:    ps.FiredAt,
			clearSince: ps.ClearSince,
			lastRemind: ps.LastRemind,
		}
		// Only known latched/pending states survive a restart; anything else
		// (including a corrupt value) resets to cleared.
		if cs.state != statePending && cs.state != stateFiring && cs.state != stateClearing {
			cs.state = stateCleared
		}
		e.states[id] = cs
	}
}

func remindDuration(s string) time.Duration {
	if s == "" {
		return 0
	}
	d, err := time.ParseDuration(s)
	if err != nil || d < 0 {
		return 0
	}
	return d
}

// FiringAlert is a condition that has fired and not yet cleared, for the
// UI's status strip.
type FiringAlert struct {
	ID       string    `json:"id"`
	Title    string    `json:"title"`
	Severity Severity  `json:"severity"`
	Since    time.Time `json:"since"`
}

// Firing lists conditions that are firing (including those waiting out their
// held-clear window, which still count until they clear), oldest first.
func (e *Evaluator) Firing() []FiringAlert {
	out := []FiringAlert{}
	for _, def := range e.conds {
		cs, ok := e.states[def.id]
		if !ok || (cs.state != stateFiring && cs.state != stateClearing) {
			continue
		}
		out = append(out, FiringAlert{ID: def.id, Title: def.title, Severity: def.severity, Since: cs.firedAt})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Since.Before(out[j].Since) })
	return out
}
