package gatewaydash

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

// LiteLLM label names the dashboard filters and groups by. requested_model is
// the alias a caller asked for (LiteLLM v1.81+).
const (
	LabelTeam  = "team_alias"
	LabelModel = "requested_model"
	LabelKey   = "api_key_alias"
)

// Filter is what the dashboard shows: one team, model alias and API key
// (each optional) over a time window.
type Filter struct {
	Team, Model, Key string
	Range            string // 24h | 7d | 30d | month
}

// Window is the resolved time span of a Filter.
type Window struct {
	From, To time.Time
}

// Seconds is the window length in whole seconds, at least one minute, for
// PromQL range selectors ([Ns]).
func (w Window) Seconds() int64 {
	s := int64(w.To.Sub(w.From).Seconds())
	if s < 60 {
		return 60
	}
	return s
}

// ErrBadRange is returned for an unknown range.
var ErrBadRange = errors.New("range must be 24h, 7d, 30d or month")

const maxLabelValue = 256

// Validate checks the filter's range and value lengths.
func (f Filter) Validate() error {
	switch f.Range {
	case "", "24h", "7d", "30d", "month":
	default:
		return ErrBadRange
	}
	for _, v := range []string{f.Team, f.Model, f.Key} {
		if len(v) > maxLabelValue {
			return fmt.Errorf("filter values are limited to %d characters", maxLabelValue)
		}
	}
	return nil
}

// Resolve turns the range into a window ending at now. "month" starts at
// 00:00 UTC on the first of the current month; the default is "month".
func (f Filter) Resolve(now time.Time) Window {
	now = now.UTC()
	switch f.Range {
	case "24h":
		return Window{From: now.Add(-24 * time.Hour), To: now}
	case "7d":
		return Window{From: now.Add(-7 * 24 * time.Hour), To: now}
	case "30d":
		return Window{From: now.Add(-30 * 24 * time.Hour), To: now}
	default:
		return Window{From: time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC), To: now}
	}
}

// escape quotes a string as a PromQL double-quoted literal body, so a filter
// value can never end the matcher and inject query text.
func escape(v string) string {
	r := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`)
	return r.Replace(v)
}

// matchers returns the label matchers for the filter, plus extra ones
// ("status_code=\"429\""), as "{a=\"x\",b=\"y\"}" ("" when there are none).
// skip drops filters a metric does not carry.
func (f Filter) matchers(skip map[string]bool, extra ...string) string {
	var parts []string
	for _, kv := range [][2]string{{LabelTeam, f.Team}, {LabelModel, f.Model}, {LabelKey, f.Key}} {
		if kv[1] != "" && !skip[kv[0]] {
			parts = append(parts, fmt.Sprintf(`%s="%s"`, kv[0], escape(kv[1])))
		}
	}
	parts = append(parts, extra...)
	if len(parts) == 0 {
		return ""
	}
	sort.Strings(parts)
	return "{" + strings.Join(parts, ",") + "}"
}

// CacheKey is a stable cache key for the filter.
func (f Filter) CacheKey() string {
	return strings.Join([]string{f.Team, f.Model, f.Key, f.Range}, "\x00")
}
