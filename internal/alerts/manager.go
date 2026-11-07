package alerts

import (
	"context"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Manager owns the alerting lifecycle: it loads/saves the persisted
// configuration and condition state, evaluates conditions each tick from a
// snapshot, fans transitions out to every configured channel, and exposes a
// test-send path. All mutating operations are serialized on mu.
type Manager struct {
	mu   sync.Mutex
	path string // config + state file
	cfg  Config
	eval *Evaluator
	now  func() time.Time
}

// NewManager creates a Manager persisting to path (config + state in one
// JSON file). If the file does not exist, a default (disabled) config is used.
func NewManager(path string) *Manager {
	m := &Manager{
		path: path,
		cfg:  defaultConfig(),
		eval: NewEvaluator(time.Now),
		now:  time.Now,
	}
	if err := m.load(); err != nil {
		// A missing/corrupt file is not fatal: start from defaults.
		_ = err
	}
	return m
}

type fileRecord struct {
	Config Config                    `json:"config"`
	State  map[string]persistedState `json:"state,omitempty"`
}

func (m *Manager) load() error {
	data, err := os.ReadFile(m.path)
	if err != nil {
		return err
	}
	var rec fileRecord
	if jerr := json.Unmarshal(data, &rec); jerr != nil {
		return jerr
	}
	m.cfg = rec.Config
	if rec.State != nil {
		m.eval.Load(rec.State)
	}
	return nil
}

// save persists the current config plus the condition machine.
func (m *Manager) save() error {
	rec := fileRecord{Config: m.cfg, State: m.eval.StateMap()}
	data, err := json.MarshalIndent(rec, "", "  ")
	if err != nil {
		return err
	}
	if dir := filepath.Dir(m.path); dir != "" {
		if werr := os.MkdirAll(dir, 0o755); werr != nil {
			return werr
		}
	}
	return os.WriteFile(m.path, data, 0o600)
}

// Config returns a copy of the current config.
func (m *Manager) Config() Config {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.cfg
}

// UpdateConfig replaces the config and persists it. The machine is left intact
// so a config change does not re-fire alerts.
func (m *Manager) UpdateConfig(cfg Config) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.cfg = cfg
	return m.save()
}

// Tick evaluates all conditions against the snapshot and delivers any new
// transitions to every channel. It is safe to call on every sampler tick.
// It returns the transitions that were sent (for logging/testing).
func (m *Manager) Tick(ctx context.Context, snap Snapshot) []Transition {
	m.mu.Lock()
	cfg := m.cfg
	m.mu.Unlock()

	if !cfg.Enabled || len(cfg.Channels) == 0 {
		return nil
	}

	m.mu.Lock()
	transitions := m.eval.Evaluate(cfg, snap)
	if err := m.save(); err != nil {
		// Persisting state is best-effort; a failure should not block delivery.
		_ = err
	}
	m.mu.Unlock()

	if len(transitions) == 0 {
		return nil
	}

	// One payload per transition, fanned out to every channel.
	for _, tr := range transitions {
		payload := WebhookPayload{
			Source:   "karpenter-optimizer",
			Status:   tr.Status,
			Severity: string(tr.Severity),
			Title:    tr.Title,
			Alerts:   tr.Alerts,
		}
		for _, ch := range cfg.Channels {
			sender, serr := NewSender(ch)
			if serr != nil {
				continue // skip channels that fail SSRF validation
			}
			if sendErr := sender.Send(ctx, ch, payload); sendErr != nil {
				// Delivery failures are non-fatal; we do not retry within a tick.
				_ = sendErr
			}
		}
	}
	return transitions
}

// Status reports whether alerting is on and which conditions are firing.
// Disabled alerting reports nothing firing, whatever state was persisted.
func (m *Manager) Status() (enabled bool, firing []FiringAlert) {
	m.mu.Lock()
	defer m.mu.Unlock()
	enabled = m.cfg.Enabled && len(m.cfg.Channels) > 0
	if !enabled {
		return false, []FiringAlert{}
	}
	return true, m.eval.Firing()
}

// SendTest sends a test message to a single channel (used by the test endpoint
// and to validate a channel before saving). It does not touch the machine.
func (m *Manager) SendTest(ctx context.Context, ch ChannelConfig) error {
	sender, err := NewSender(ch)
	if err != nil {
		return err
	}
	payload := WebhookPayload{
		Source:   "karpenter-optimizer",
		Status:   StatusTest,
		Severity: string(SeverityWarning),
		Title:    "Test alert",
		Alerts:   []Alert{{ID: "test", Title: "Test", Message: "Karpenter Optimizer alerting channel test", Severity: SeverityWarning}},
	}
	return sender.Send(ctx, ch, payload)
}

// MaskedURLs returns the configured channels with URLs masked (host kept,
// path/query redacted) for safe display in GET /alerts/config.
func (m *Manager) MaskedURLs() []MaskedChannel {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]MaskedChannel, 0, len(m.cfg.Channels))
	for _, ch := range m.cfg.Channels {
		out = append(out, MaskedChannel{
			Type:     ch.Type,
			Priority: ch.Priority,
			Tags:     ch.Tags,
			URL:      maskURL(ch.URL),
		})
	}
	return out
}

// MaskedChannel is a channel with its URL masked for display.
type MaskedChannel struct {
	Type     string `json:"type"`
	Priority int    `json:"priority,omitempty"`
	Tags     string `json:"tags,omitempty"`
	URL      string `json:"url"`
}

// MaskURL keeps the scheme + host and replaces the path/query with the "/*"
// sentinel so the URL is recognizable but not usable, and can be detected (and
// the real URL restored by index) on a subsequent PUT.
func MaskURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return "***"
	}
	if u.Host == "" {
		return "***"
	}
	// Always end with the sentinel so the restore-by-index logic is unambiguous.
	return u.Scheme + "://" + u.Host + "/*"
}

// maskURL is the unexported alias used internally.
func maskURL(raw string) string { return MaskURL(raw) }
