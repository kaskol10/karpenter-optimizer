package gatewaydash

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeProm answers by the first rule whose substring the query contains.
type fakeProm struct {
	instant []rule
	ranged  []rangeRule
	mu      sync.Mutex
	seen    []string
}

func (f *fakeProm) record(q string) {
	f.mu.Lock()
	f.seen = append(f.seen, q)
	f.mu.Unlock()
}

type rule struct {
	contains string
	samples  []Sample
	err      error
}

type rangeRule struct {
	contains string
	series   []Series
	err      error
}

func (f *fakeProm) Query(_ context.Context, q string, _ time.Time) ([]Sample, error) {
	f.record(q)
	for _, r := range f.instant {
		if strings.Contains(q, r.contains) {
			return r.samples, r.err
		}
	}
	return nil, nil
}

func (f *fakeProm) QueryRange(_ context.Context, q string, _, _ time.Time, _ time.Duration) ([]Series, error) {
	f.record(q)
	for _, r := range f.ranged {
		if strings.Contains(q, r.contains) {
			return r.series, r.err
		}
	}
	return nil, nil
}

func one(v float64) []Sample { return []Sample{{Metric: map[string]string{}, Value: v}} }

func by(label string, kv ...any) []Sample {
	var out []Sample
	for i := 0; i < len(kv); i += 2 {
		out = append(out, Sample{Metric: map[string]string{label: kv[i].(string)}, Value: kv[i+1].(float64)})
	}
	return out
}

var now = time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)

func TestBuildDashboard(t *testing.T) {
	nov2 := time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC)
	nov3 := time.Date(2026, 11, 3, 0, 0, 0, 0, time.UTC)
	f := &fakeProm{
		instant: []rule{
			// Order matters: more specific substrings first.
			{contains: `status_code="429"`, samples: one(4)},
			{contains: "count(sum by (api_key_alias)", samples: one(2)},
			{contains: "litellm_remaining_team_budget_metric", samples: one(250)},
			{contains: "litellm_team_max_budget_metric", samples: one(1000)},
			{contains: "litellm_team_budget_remaining_hours_metric", samples: one(36)},
			{contains: "sum by (requested_model) (increase(litellm_spend_metric{team_alias=\"search\"}[43200s]))", samples: by(LabelModel, "llama", 5.0, "qwen", 0.0)},
			{contains: "litellm_input_tokens_metric{team_alias=\"search\"}[43200s]", samples: one(1000)},
			{contains: "litellm_output_tokens_metric{team_alias=\"search\"}[43200s]", samples: one(300)},
			{contains: "sum by (api_key_alias) (increase(litellm_spend_metric", samples: by(LabelKey, "dev-a", 3.0, "dev-b", 9.0)},
			{contains: "sum by (api_key_alias) (increase(litellm_total_tokens_metric", samples: by(LabelKey, "dev-a", 100.0, "dev-b", 900.0)},
			{contains: "sum by (api_key_alias) (increase(litellm_proxy_total_requests_metric", samples: by(LabelKey, "dev-a", 10.0, "dev-b", 30.0, "dev-c", 1.0)},
			{contains: "sum by (api_key_alias) (increase(litellm_proxy_failed_requests_metric", samples: by(LabelKey, "dev-b", 2.0)},
			{contains: "litellm_remaining_api_key_budget_metric", samples: by(LabelKey, "dev-a", 40.0)},
			{contains: "histogram_quantile(0.95, sum by (le, api_key_alias)", samples: by(LabelKey, "dev-b", 0.8)},
			{contains: "sum by (requested_model) (increase(litellm_proxy_total_requests_metric", samples: by(LabelModel, "llama", 30.0, "qwen", 11.0)},
			{contains: "sum by (requested_model) (increase(litellm_spend_metric", samples: by(LabelModel, "llama", 10.0, "qwen", 2.0)},
			{contains: "histogram_quantile(0.5, sum by (le, requested_model)", samples: by(LabelModel, "llama", 0.2)},
			{contains: "histogram_quantile(0.95, sum by (le, requested_model)", samples: by(LabelModel, "llama", 0.9)},
			{contains: "litellm_deployment_latency_per_output_token", samples: []Sample{
				{Metric: map[string]string{"model_group": "llama"}, Value: 0.02},
				{Metric: map[string]string{"model_group": ""}, Value: 0.01},
				{Metric: map[string]string{"model_group": "idle"}, Value: 0}}},
			{contains: "sum by (team_alias)", samples: by(LabelTeam, "search", 41.0, "core", 3.0)},
			{contains: "litellm_spend_metric", samples: one(12)},
			{contains: "litellm_proxy_failed_requests_metric", samples: one(2)},
			{contains: "litellm_proxy_total_requests_metric", samples: one(41)},
		},
		ranged: []rangeRule{
			{contains: "litellm_spend_metric", series: []Series{
				{Metric: map[string]string{LabelModel: "llama"}, Points: []Point{{T: nov2, V: 4}, {T: nov3, V: 0}}},
				{Metric: map[string]string{LabelModel: "qwen"}, Points: []Point{{T: nov3, V: 1}}}}},
			{contains: "litellm_input_tokens_metric", series: []Series{{Points: []Point{{T: nov2, V: 500}, {T: nov3, V: 700}}}}},
			{contains: "litellm_input_cached_tokens_metric", err: errors.New("boom")},
		},
	}
	d, err := Build(context.Background(), f, Filter{Team: "search"}, now)
	if err != nil {
		t.Fatal(err)
	}
	if d.Range != "month" || !d.From.Equal(time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)) || !d.To.Equal(now) {
		t.Fatalf("window: %s %v %v", d.Range, d.From, d.To)
	}
	s := d.Summary
	if *s.Spend != 12 || *s.Requests != 41 || *s.Failed != 2 || *s.ActiveDevelopers != 2 || *s.Throttled != 4 {
		t.Fatalf("summary: %+v", s)
	}
	if got := *s.ErrorRatePct; got < 4.87 || got > 4.88 {
		t.Fatalf("error rate %v", got)
	}
	if d.Budget == nil || *d.Budget.RemainingShare != 0.25 || *d.Budget.HoursToReset != 36 {
		t.Fatalf("budget: %+v", d.Budget)
	}

	// Closed days from the range query (zeros dropped), today from the instant.
	wantDays := []DayValue{
		{Day: "2026-11-01", Model: "llama", Value: 4},
		{Day: "2026-11-02", Model: "qwen", Value: 1},
		{Day: "2026-11-03", Model: "llama", Value: 5},
	}
	if len(d.SpendByDay) != len(wantDays) {
		t.Fatalf("spend days: %+v", d.SpendByDay)
	}
	for i, w := range wantDays {
		if d.SpendByDay[i] != w {
			t.Errorf("day %d: %+v, want %+v", i, d.SpendByDay[i], w)
		}
	}
	if len(d.TokensByDay) != 3 || *d.TokensByDay[0].Input != 500 || d.TokensByDay[0].Cached != nil ||
		*d.TokensByDay[2].Input != 1000 || *d.TokensByDay[2].Output != 300 {
		t.Fatalf("tokens: %+v", d.TokensByDay)
	}

	if len(d.Developers) != 3 || d.Developers[0].Key != "dev-b" || *d.Developers[0].Failed != 2 || *d.Developers[0].TTFTP95Seconds != 0.8 ||
		*d.Developers[1].BudgetRemaining != 40 || d.Developers[2].Key != "dev-c" || d.Developers[2].Spend != nil {
		t.Fatalf("developers: %+v", d.Developers)
	}
	if len(d.Models) != 2 || d.Models[0].Model != "llama" || *d.Models[0].TTFTP95Seconds != 0.9 || d.Models[1].TTFTP50Seconds != nil {
		t.Fatalf("models: %+v", d.Models)
	}
	if len(d.OutputSpeed) != 1 || d.OutputSpeed[0].TokensPerSecond != 50 {
		t.Fatalf("speed: %+v", d.OutputSpeed)
	}
	if strings.Join(d.Options.Teams, ",") != "core,search" || strings.Join(d.Options.Models, ",") != "llama,qwen" || len(d.Options.Keys) != 3 {
		t.Fatalf("options: %+v", d.Options)
	}
	if d.Errors["tokensByDay"] != "boom" {
		t.Fatalf("errors: %v", d.Errors)
	}

	// Every filter value reaches the queries escaped, never raw.
	for _, q := range f.seen {
		if strings.Contains(q, "team_alias") && !strings.Contains(q, `team_alias="search"`) && !strings.Contains(q, "by (team_alias)") {
			t.Errorf("query without the team filter: %s", q)
		}
	}
}

func TestBuildWithoutTeamOrData(t *testing.T) {
	f := &fakeProm{instant: []rule{{contains: "litellm_proxy_total_requests_metric", samples: one(0)}}}
	d, err := Build(context.Background(), f, Filter{Range: "24h"}, now)
	if err != nil {
		t.Fatal(err)
	}
	if d.Budget != nil {
		t.Error("budget needs a team")
	}
	if d.Summary.ErrorRatePct != nil || *d.Summary.ActiveDevelopers != 0 {
		t.Errorf("summary: %+v", d.Summary)
	}
	for _, q := range f.seen {
		if strings.Contains(q, "budget_metric{") && strings.Contains(q, "team_budget") {
			t.Errorf("team budget queried without a team: %s", q)
		}
	}
	if d.SpendByDay == nil || d.Developers == nil || d.Models == nil || d.OutputSpeed == nil || d.Errors != nil {
		t.Errorf("empty panels should be empty lists: %+v", d)
	}

	// A team with no budget metrics has no budget block; a zero budget has
	// no share.
	f2 := &fakeProm{instant: []rule{{contains: "litellm_team_max_budget_metric", samples: one(0)}}}
	d2, _ := Build(context.Background(), f2, Filter{Team: "x", Range: "7d"}, now)
	if d2.Budget == nil || d2.Budget.RemainingShare != nil {
		t.Errorf("zero budget: %+v", d2.Budget)
	}
	d3, _ := Build(context.Background(), &fakeProm{}, Filter{Team: "x", Range: "7d"}, now)
	if d3.Budget != nil {
		t.Errorf("no budget metrics: %+v", d3.Budget)
	}
	if _, err := Build(context.Background(), f, Filter{Range: "1y"}, now); err != ErrBadRange {
		t.Errorf("bad range: %v", err)
	}
}

func TestBuildSameDayWindowSkipsRangeQueries(t *testing.T) {
	f := &fakeProm{}
	early := time.Date(2026, 11, 1, 0, 30, 0, 0, time.UTC)
	if _, err := Build(context.Background(), f, Filter{}, early); err != nil {
		t.Fatal(err)
	}
	for _, q := range f.seen {
		if strings.Contains(q, "[1d]") {
			t.Fatalf("range query on the month's first day: %s", q)
		}
	}
}

func TestBuildRecordsFirstErrorPerPanel(t *testing.T) {
	f := &fakeProm{instant: []rule{{contains: "", err: errors.New("down")}}}
	d, err := Build(context.Background(), f, Filter{Range: "24h"}, now)
	if err != nil {
		t.Fatal(err)
	}
	if d.Errors["summary"] != "down" || d.Errors["options"] != "down" {
		t.Fatalf("errors: %v", d.Errors)
	}
}

func TestBuildOperatorPanels(t *testing.T) {
	dep := func(model, base string, state float64) Sample {
		return Sample{Metric: map[string]string{"litellm_model_name": model, "api_base": base, "api_provider": "hosted_vllm"}, Value: state}
	}
	f := &fakeProm{instant: []rule{
		{contains: "litellm_deployment_successful_fallbacks", samples: by(LabelModel, "llama", 7.0)},
		{contains: "litellm_deployment_failed_fallbacks", samples: by(LabelModel, "llama", 1.0)},
		{contains: "litellm_zero_cost_requests", samples: one(3)},
		{contains: "litellm_deployment_state", samples: []Sample{
			dep("hosted_vllm/b", "http://b", 0), dep("hosted_vllm/a", "http://a2", 2), dep("hosted_vllm/a", "http://a1", 2),
			{Metric: map[string]string{}, Value: 1}}},
		{contains: "sum by (requested_model) (increase(litellm_proxy_total_requests_metric", samples: by(LabelModel, "llama", 70.0, "qwen", 5.0)},
	}}
	d, err := Build(context.Background(), f, Filter{Model: "llama", Range: "24h"}, now)
	if err != nil {
		t.Fatal(err)
	}
	if *d.Summary.ZeroCost != 3 {
		t.Errorf("zero cost: %+v", d.Summary.ZeroCost)
	}
	if *d.Models[0].Fallbacks != 7 || *d.Models[0].FailedFallbacks != 1 || d.Models[1].Fallbacks != nil {
		t.Errorf("fallbacks: %+v", d.Models)
	}
	want := []Deployment{
		{Model: "hosted_vllm/a", APIBase: "http://a1", Provider: "hosted_vllm", State: 2},
		{Model: "hosted_vllm/a", APIBase: "http://a2", Provider: "hosted_vllm", State: 2},
		{Model: "hosted_vllm/b", APIBase: "http://b", Provider: "hosted_vllm", State: 0},
	}
	if len(d.Deployments) != len(want) {
		t.Fatalf("deployments: %+v", d.Deployments)
	}
	for i := range want {
		if d.Deployments[i] != want[i] {
			t.Errorf("deployment %d: %+v, want %+v", i, d.Deployments[i], want[i])
		}
	}
	for _, q := range f.seen {
		switch {
		case strings.Contains(q, "fallbacks"):
			if !strings.Contains(q, `{__name__=~"litellm_deployment_`) || !strings.Contains(q, `(_total)?",requested_model="llama"}`) {
				t.Errorf("fallback query: %s", q)
			}
		case strings.Contains(q, "litellm_deployment_state"):
			if strings.Contains(q, "llama") {
				t.Errorf("deployment state is not filterable: %s", q)
			}
		}
	}
}
