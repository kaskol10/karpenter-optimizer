package gatewaydash

import (
	"strings"
	"testing"
	"time"
)

func TestFilterMatchersEscapeValues(t *testing.T) {
	f := Filter{Team: `a"b\c` + "\nd", Model: "llama", Key: "k1"}
	got := f.matchers(nil, `status_code="429"`)
	want := `{api_key_alias="k1",requested_model="llama",status_code="429",team_alias="a\"b\\c\nd"}`
	if got != want {
		t.Fatalf("got %s\nwant %s", got, want)
	}
	if got := f.matchers(map[string]bool{LabelModel: true, LabelKey: true}); got != `{team_alias="a\"b\\c\nd"}` {
		t.Fatalf("skip: %s", got)
	}
	if got := (Filter{}).matchers(nil); got != "" {
		t.Fatalf("empty: %q", got)
	}
}

func TestFilterValidateAndResolve(t *testing.T) {
	for _, r := range []string{"", "24h", "7d", "30d", "month"} {
		if err := (Filter{Range: r}).Validate(); err != nil {
			t.Errorf("%q: %v", r, err)
		}
	}
	if err := (Filter{Range: "1y"}).Validate(); err != ErrBadRange {
		t.Errorf("1y: %v", err)
	}
	if err := (Filter{Team: strings.Repeat("x", 300)}).Validate(); err == nil {
		t.Error("long value accepted")
	}

	now := time.Date(2026, 11, 17, 15, 30, 0, 0, time.UTC)
	cases := map[string]time.Duration{"24h": 24 * time.Hour, "7d": 7 * 24 * time.Hour, "30d": 30 * 24 * time.Hour}
	for r, span := range cases {
		w := Filter{Range: r}.Resolve(now)
		if w.To != now || w.To.Sub(w.From) != span {
			t.Errorf("%s: %v", r, w)
		}
	}
	w := Filter{}.Resolve(now.In(time.FixedZone("x", 3600)))
	if !w.From.Equal(time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)) {
		t.Errorf("month starts at %v", w.From)
	}
	if (Window{From: now, To: now}).Seconds() != 60 {
		t.Error("windows are at least a minute")
	}
	if (Filter{Team: "a", Range: "7d"}).CacheKey() == (Filter{Team: "a", Range: "30d"}).CacheKey() {
		t.Error("cache key ignores range")
	}
}
