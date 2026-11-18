// Package gatewaydash builds the Gateway page's team dashboard from the
// LiteLLM metrics in Prometheus: spend and budget, requests and errors,
// spend and tokens per day, one row per API key, and latency per model,
// for one team, model alias and API key (each optional) over a window.
//
// Every panel is its own query; a panel whose query fails or whose metric
// this LiteLLM version does not export is left empty and named in Errors or
// simply absent, so the page always renders what it can.
package gatewaydash

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"time"
)

// Summary is the top row.
type Summary struct {
	Spend            *float64 `json:"spend"`
	Requests         *float64 `json:"requests"`
	Failed           *float64 `json:"failed"`
	ErrorRatePct     *float64 `json:"errorRatePct"`
	ActiveDevelopers *float64 `json:"activeDevelopers"`
	Throttled        *float64 `json:"throttled"` // HTTP 429s
	ZeroCost         *float64 `json:"zeroCost"`  // requests LiteLLM priced at $0
}

// Budget is a team's LiteLLM budget (only when a team is picked).
type Budget struct {
	Remaining      *float64 `json:"remaining"`
	Max            *float64 `json:"max"`
	RemainingShare *float64 `json:"remainingShare"` // 0..1
	HoursToReset   *float64 `json:"hoursToReset"`
}

// DayValue is one model's spend on one UTC day.
type DayValue struct {
	Day   string  `json:"day"` // YYYY-MM-DD
	Model string  `json:"model"`
	Value float64 `json:"value"`
}

// TokenDay is one UTC day's tokens (nil when the metric is not exported).
type TokenDay struct {
	Day    string   `json:"day"`
	Input  *float64 `json:"input"`
	Cached *float64 `json:"cached"`
	Output *float64 `json:"output"`
}

// Developer is one API key's row.
type Developer struct {
	Key             string   `json:"key"`
	Spend           *float64 `json:"spend"`
	Tokens          *float64 `json:"tokens"`
	Requests        *float64 `json:"requests"`
	Failed          *float64 `json:"failed"`
	BudgetRemaining *float64 `json:"budgetRemaining"`
	TTFTP95Seconds  *float64 `json:"ttftP95Seconds"`
}

// ModelStat is one model alias's latency and volume.
type ModelStat struct {
	Model          string   `json:"model"`
	Requests       *float64 `json:"requests"`
	Spend          *float64 `json:"spend"`
	TTFTP50Seconds *float64 `json:"ttftP50Seconds"`
	TTFTP95Seconds *float64 `json:"ttftP95Seconds"`
	// Fallbacks LiteLLM took for requests to this alias in the window,
	// and the ones that failed too.
	Fallbacks       *float64 `json:"fallbacks"`
	FailedFallbacks *float64 `json:"failedFallbacks"`
}

// Deployment is one LiteLLM deployment (a backend behind a model alias)
// and its state now: 0 healthy, 1 partial outage, 2 complete outage.
// LiteLLM labels it by backend only, so it covers every team.
type Deployment struct {
	Model    string  `json:"model"` // litellm_model_name, e.g. hosted_vllm/meta-llama/Llama-3.3-70B-Instruct
	APIBase  string  `json:"apiBase"`
	Provider string  `json:"provider"`
	State    float64 `json:"state"`
}

// ModelSpeed is a model group's output speed. LiteLLM labels it by model
// group only, so it covers every team.
type ModelSpeed struct {
	ModelGroup      string  `json:"modelGroup"`
	TokensPerSecond float64 `json:"tokensPerSecond"`
}

// Options lists what the filters can pick in the window: every team, the
// models the team used and the keys under the team and model.
type Options struct {
	Teams  []string `json:"teams"`
	Models []string `json:"models"`
	Keys   []string `json:"keys"`
}

// Dashboard is the whole page.
type Dashboard struct {
	Team        string            `json:"team"`
	Model       string            `json:"model"`
	Key         string            `json:"key"`
	Range       string            `json:"range"`
	From        time.Time         `json:"from"`
	To          time.Time         `json:"to"`
	Summary     Summary           `json:"summary"`
	Budget      *Budget           `json:"budget"`
	SpendByDay  []DayValue        `json:"spendByDay"`
	TokensByDay []TokenDay        `json:"tokensByDay"`
	Developers  []Developer       `json:"developers"`
	Models      []ModelStat       `json:"models"`
	OutputSpeed []ModelSpeed      `json:"outputSpeed"`
	Deployments []Deployment      `json:"deployments"`
	Options     Options           `json:"options"`
	Errors      map[string]string `json:"errors,omitempty"`
}

// Querier is the part of Prom the dashboard uses.
type Querier interface {
	Query(ctx context.Context, q string, at time.Time) ([]Sample, error)
	QueryRange(ctx context.Context, q string, start, end time.Time, step time.Duration) ([]Series, error)
}

const (
	day         = 24 * time.Hour
	parallelism = 6
)

func ptr(v float64) *float64 { return &v }

// scalar is the single value of a one-series result (nil when empty).
func scalar(s []Sample) *float64 {
	if len(s) == 0 {
		return nil
	}
	return ptr(s[0].Value)
}

// byLabel maps a label's values to their sample value.
func byLabel(s []Sample, label string) map[string]float64 {
	out := make(map[string]float64, len(s))
	for _, x := range s {
		if v := x.Metric[label]; v != "" {
			out[v] = x.Value
		}
	}
	return out
}

func lookup(m map[string]float64, k string) *float64 {
	if v, ok := m[k]; ok {
		return ptr(v)
	}
	return nil
}

func sortedKeys(maps ...map[string]float64) []string {
	set := map[string]bool{}
	for _, m := range maps {
		for k := range m {
			set[k] = true
		}
	}
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// Build runs every panel's query and assembles the dashboard at now.
func Build(ctx context.Context, q Querier, f Filter, now time.Time) (*Dashboard, error) {
	if err := f.Validate(); err != nil {
		return nil, err
	}
	if f.Range == "" {
		f.Range = "month"
	}
	w := f.Resolve(now)
	b := &builder{q: q, f: f, w: w, results: map[string][]Sample{}, ranges: map[string][]Series{}, errs: map[string]string{}}
	b.plan()
	b.run(ctx)
	return b.assemble(), nil
}

type builder struct {
	q       Querier
	f       Filter
	w       Window
	instant []namedQuery
	ranged  []namedQuery
	mu      sync.Mutex
	results map[string][]Sample
	ranges  map[string][]Series
	errs    map[string]string
}

type namedQuery struct {
	name, panel, query string
	at                 time.Time
}

func (b *builder) add(name, panel, query string) {
	b.instant = append(b.instant, namedQuery{name: name, panel: panel, query: query, at: b.w.To})
}

// plan writes every query. inc is increase() over the window.
func (b *builder) plan() {
	f, w := b.f, b.w
	all := f.matchers(nil)
	rng := fmt.Sprintf("[%ds]", w.Seconds())
	inc := func(metric, m string) string { return fmt.Sprintf("increase(%s%s)", counter(metric, m), rng) }

	// Summary.
	b.add("spend", "summary", "sum("+inc("litellm_spend_metric", all)+")")
	b.add("requests", "summary", "sum("+inc("litellm_proxy_total_requests_metric", all)+")")
	b.add("failed", "summary", "sum("+inc("litellm_proxy_failed_requests_metric", all)+")")
	b.add("active", "summary", fmt.Sprintf("count(sum by (%s) (%s) > 0)", LabelKey, inc("litellm_proxy_total_requests_metric", all)))
	b.add("throttled", "summary", "sum("+inc("litellm_proxy_total_requests_metric", f.matchers(nil, `status_code="429"`))+")")
	b.add("zeroCost", "summary", "sum("+inc("litellm_zero_cost_requests", all)+")")

	// Budget: team-level gauges, labelled by team only.
	if f.Team != "" {
		team := Filter{Team: f.Team}.matchers(nil)
		b.add("budgetRemaining", "budget", "max(litellm_remaining_team_budget_metric"+team+")")
		b.add("budgetMax", "budget", "max(litellm_team_max_budget_metric"+team+")")
		b.add("budgetHours", "budget", "max(litellm_team_budget_remaining_hours_metric"+team+")")
	}

	// Today so far (closed days come from the range queries).
	today := fmt.Sprintf("[%ds]", maxInt64(60, int64(w.To.Sub(midnight(w.To)).Seconds())))
	b.add("spendToday", "spendByDay", fmt.Sprintf("sum by (%s) (increase(%s%s))", LabelModel, counter("litellm_spend_metric", all), today))
	for _, t := range tokenMetrics {
		b.add("tokensToday:"+t.kind, "tokensByDay", fmt.Sprintf("sum(increase(%s%s))", counter(t.metric, all), today))
	}

	// One row per API key.
	byKey := func(metric string) string {
		return fmt.Sprintf("sum by (%s) (%s)", LabelKey, inc(metric, all))
	}
	b.add("devSpend", "developers", byKey("litellm_spend_metric"))
	b.add("devTokens", "developers", byKey("litellm_total_tokens_metric"))
	b.add("devRequests", "developers", byKey("litellm_proxy_total_requests_metric"))
	b.add("devFailed", "developers", byKey("litellm_proxy_failed_requests_metric"))
	b.add("devBudget", "developers", fmt.Sprintf("max by (%s) (litellm_remaining_api_key_budget_metric%s)", LabelKey, f.matchers(map[string]bool{LabelModel: true})))
	b.add("devTTFT", "developers", quantile(0.95, LabelKey, all, rng))

	// Per model alias.
	byModel := func(metric string) string {
		return fmt.Sprintf("sum by (%s) (%s)", LabelModel, inc(metric, all))
	}
	b.add("modelRequests", "models", byModel("litellm_proxy_total_requests_metric"))
	b.add("modelSpend", "models", byModel("litellm_spend_metric"))
	b.add("modelTTFT50", "models", quantile(0.5, LabelModel, all, rng))
	b.add("modelTTFT95", "models", quantile(0.95, LabelModel, all, rng))
	b.add("modelFallbacks", "models", fmt.Sprintf("sum by (%s) (%s)", LabelModel, inc("litellm_deployment_successful_fallbacks", all)))
	b.add("modelFailedFallbacks", "models", fmt.Sprintf("sum by (%s) (%s)", LabelModel, inc("litellm_deployment_failed_fallbacks", all)))

	// Deployment state now: labelled by backend only, so not filtered.
	b.add("deployments", "deployments", "max by (litellm_model_name, api_base, api_provider) (litellm_deployment_state)")

	// Output speed: labelled by model group only, so not filtered.
	b.add("speed", "outputSpeed", fmt.Sprintf(
		"sum by (model_group) (rate(litellm_deployment_latency_per_output_token_sum%[1]s)) / sum by (model_group) (rate(litellm_deployment_latency_per_output_token_count%[1]s))", rng))

	// Filter options.
	b.add("optTeams", "options", fmt.Sprintf("sum by (%s) (%s) > 0", LabelTeam, inc("litellm_proxy_total_requests_metric", "")))
	b.add("optModels", "options", fmt.Sprintf("sum by (%s) (%s) > 0", LabelModel, inc("litellm_proxy_total_requests_metric", Filter{Team: f.Team}.matchers(nil))))
	b.add("optKeys", "options", fmt.Sprintf("sum by (%s) (%s) > 0", LabelKey, inc("litellm_proxy_total_requests_metric", Filter{Team: f.Team, Model: f.Model}.matchers(nil))))

	// Closed UTC days in the window, each evaluated at the following midnight.
	b.ranged = append(b.ranged,
		namedQuery{name: "spendDays", panel: "spendByDay", query: fmt.Sprintf("sum by (%s) (increase(%s[1d]))", LabelModel, counter("litellm_spend_metric", all))})
	for _, t := range tokenMetrics {
		b.ranged = append(b.ranged, namedQuery{name: "tokenDays:" + t.kind, panel: "tokensByDay", query: fmt.Sprintf("sum(increase(%s[1d]))", counter(t.metric, all))})
	}
}

var tokenMetrics = []struct{ kind, metric string }{
	{"input", "litellm_input_tokens_metric"},
	{"cached", "litellm_input_cached_tokens_metric"},
	{"output", "litellm_output_tokens_metric"},
}

// counter selects a LiteLLM counter with or without the _total suffix
// (LiteLLM's Prometheus client exports litellm_spend_metric as
// litellm_spend_metric_total), adding the name matcher to the matchers m
// ("" or "{a=\"b\",…}" from Filter.matchers).
func counter(name, m string) string {
	sel := fmt.Sprintf(`__name__=~"%s(_total)?"`, name)
	if m == "" || m == "{}" {
		return "{" + sel + "}"
	}
	return "{" + sel + "," + m[1:]
}

func quantile(q float64, by, m, rng string) string {
	return fmt.Sprintf("histogram_quantile(%g, sum by (le, %s) (rate(litellm_llm_api_time_to_first_token_metric_bucket%s%s)))", q, by, m, rng)
}

func midnight(t time.Time) time.Time {
	t = t.UTC()
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.UTC)
}

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

// dayRange is the first and last midnight that close a day in the window.
func (b *builder) dayRange() (start, end time.Time, ok bool) {
	start = midnight(b.w.From).Add(day)
	end = midnight(b.w.To)
	return start, end, !end.Before(start)
}

func (b *builder) fail(panel string, err error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, seen := b.errs[panel]; !seen {
		b.errs[panel] = err.Error()
	}
}

func (b *builder) run(ctx context.Context) {
	sem := make(chan struct{}, parallelism)
	var wg sync.WaitGroup
	for _, nq := range b.instant {
		wg.Add(1)
		go func(nq namedQuery) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			s, err := b.q.Query(ctx, nq.query, nq.at)
			if err != nil {
				b.fail(nq.panel, err)
				return
			}
			b.mu.Lock()
			b.results[nq.name] = s
			b.mu.Unlock()
		}(nq)
	}
	if start, end, ok := b.dayRange(); ok {
		for _, nq := range b.ranged {
			wg.Add(1)
			go func(nq namedQuery) {
				defer wg.Done()
				sem <- struct{}{}
				defer func() { <-sem }()
				s, err := b.q.QueryRange(ctx, nq.query, start, end, day)
				if err != nil {
					b.fail(nq.panel, err)
					return
				}
				b.mu.Lock()
				b.ranges[nq.name] = s
				b.mu.Unlock()
			}(nq)
		}
	}
	wg.Wait()
}

// dayOf names the UTC day a value evaluated at t covers (the day before t).
func dayOf(t time.Time) string { return t.Add(-day).UTC().Format("2006-01-02") }

func (b *builder) assemble() *Dashboard {
	r := b.results
	d := &Dashboard{Team: b.f.Team, Model: b.f.Model, Key: b.f.Key, Range: b.f.Range, From: b.w.From, To: b.w.To}

	d.Summary = Summary{
		Spend: scalar(r["spend"]), Requests: scalar(r["requests"]), Failed: scalar(r["failed"]),
		ActiveDevelopers: scalar(r["active"]), Throttled: scalar(r["throttled"]), ZeroCost: scalar(r["zeroCost"]),
	}
	// Prometheus returns no series for count() of nothing: zero developers.
	if d.Summary.ActiveDevelopers == nil && d.Summary.Requests != nil {
		d.Summary.ActiveDevelopers = ptr(0)
	}
	if d.Summary.Requests != nil && *d.Summary.Requests > 0 {
		failed := 0.0
		if d.Summary.Failed != nil {
			failed = *d.Summary.Failed
		}
		d.Summary.ErrorRatePct = ptr(failed / *d.Summary.Requests * 100)
	}

	if b.f.Team != "" {
		bu := &Budget{Remaining: scalar(r["budgetRemaining"]), Max: scalar(r["budgetMax"]), HoursToReset: scalar(r["budgetHours"])}
		if bu.Remaining != nil && bu.Max != nil && *bu.Max > 0 {
			bu.RemainingShare = ptr(*bu.Remaining / *bu.Max)
		}
		if bu.Remaining != nil || bu.Max != nil || bu.HoursToReset != nil {
			d.Budget = bu
		}
	}

	// Spend per day: closed days, then today so far.
	d.SpendByDay = []DayValue{}
	for _, s := range b.ranges["spendDays"] {
		for _, p := range s.Points {
			if p.V > 0 {
				d.SpendByDay = append(d.SpendByDay, DayValue{Day: dayOf(p.T), Model: s.Metric[LabelModel], Value: p.V})
			}
		}
	}
	todayName := midnight(b.w.To).Format("2006-01-02")
	for _, s := range r["spendToday"] {
		if s.Value > 0 {
			d.SpendByDay = append(d.SpendByDay, DayValue{Day: todayName, Model: s.Metric[LabelModel], Value: s.Value})
		}
	}
	sort.Slice(d.SpendByDay, func(i, j int) bool {
		a, c := d.SpendByDay[i], d.SpendByDay[j]
		if a.Day != c.Day {
			return a.Day < c.Day
		}
		return a.Model < c.Model
	})

	// Tokens per day by kind.
	days := map[string]*TokenDay{}
	at := func(name string) *TokenDay {
		if days[name] == nil {
			days[name] = &TokenDay{Day: name}
		}
		return days[name]
	}
	set := func(td *TokenDay, kind string, v float64) {
		switch kind {
		case "input":
			td.Input = ptr(v)
		case "cached":
			td.Cached = ptr(v)
		case "output":
			td.Output = ptr(v)
		}
	}
	for _, t := range tokenMetrics {
		for _, s := range b.ranges["tokenDays:"+t.kind] {
			for _, p := range s.Points {
				set(at(dayOf(p.T)), t.kind, p.V)
			}
		}
		if v := scalar(r["tokensToday:"+t.kind]); v != nil {
			set(at(todayName), t.kind, *v)
		}
	}
	d.TokensByDay = make([]TokenDay, 0, len(days))
	for _, td := range days {
		d.TokensByDay = append(d.TokensByDay, *td)
	}
	sort.Slice(d.TokensByDay, func(i, j int) bool { return d.TokensByDay[i].Day < d.TokensByDay[j].Day })

	// Developers, biggest spend first.
	spend, tokens, reqs, failed := byLabel(r["devSpend"], LabelKey), byLabel(r["devTokens"], LabelKey), byLabel(r["devRequests"], LabelKey), byLabel(r["devFailed"], LabelKey)
	budget, ttft := byLabel(r["devBudget"], LabelKey), byLabel(r["devTTFT"], LabelKey)
	d.Developers = []Developer{}
	for _, k := range sortedKeys(spend, tokens, reqs) {
		d.Developers = append(d.Developers, Developer{
			Key: k, Spend: lookup(spend, k), Tokens: lookup(tokens, k), Requests: lookup(reqs, k), Failed: lookup(failed, k),
			BudgetRemaining: lookup(budget, k), TTFTP95Seconds: lookup(ttft, k),
		})
	}
	sort.SliceStable(d.Developers, func(i, j int) bool { return val(d.Developers[i].Spend) > val(d.Developers[j].Spend) })

	// Models, most requests first.
	mReq, mSpend := byLabel(r["modelRequests"], LabelModel), byLabel(r["modelSpend"], LabelModel)
	m50, m95 := byLabel(r["modelTTFT50"], LabelModel), byLabel(r["modelTTFT95"], LabelModel)
	mFb, mFbFail := byLabel(r["modelFallbacks"], LabelModel), byLabel(r["modelFailedFallbacks"], LabelModel)
	d.Models = []ModelStat{}
	for _, m := range sortedKeys(mReq, mSpend) {
		d.Models = append(d.Models, ModelStat{
			Model: m, Requests: lookup(mReq, m), Spend: lookup(mSpend, m), TTFTP50Seconds: lookup(m50, m), TTFTP95Seconds: lookup(m95, m),
			Fallbacks: lookup(mFb, m), FailedFallbacks: lookup(mFbFail, m),
		})
	}
	sort.SliceStable(d.Models, func(i, j int) bool { return val(d.Models[i].Requests) > val(d.Models[j].Requests) })

	// Output speed: seconds per token, inverted.
	d.OutputSpeed = []ModelSpeed{}
	for _, s := range r["speed"] {
		if g := s.Metric["model_group"]; g != "" && s.Value > 0 {
			d.OutputSpeed = append(d.OutputSpeed, ModelSpeed{ModelGroup: g, TokensPerSecond: 1 / s.Value})
		}
	}
	sort.Slice(d.OutputSpeed, func(i, j int) bool { return d.OutputSpeed[i].ModelGroup < d.OutputSpeed[j].ModelGroup })

	// Deployments, worst state first.
	d.Deployments = []Deployment{}
	for _, s := range r["deployments"] {
		if m := s.Metric["litellm_model_name"]; m != "" {
			d.Deployments = append(d.Deployments, Deployment{Model: m, APIBase: s.Metric["api_base"], Provider: s.Metric["api_provider"], State: s.Value})
		}
	}
	sort.Slice(d.Deployments, func(i, j int) bool {
		a, c := d.Deployments[i], d.Deployments[j]
		if a.State != c.State {
			return a.State > c.State
		}
		if a.Model != c.Model {
			return a.Model < c.Model
		}
		return a.APIBase < c.APIBase
	})

	d.Options = Options{
		Teams:  sortedKeys(byLabel(r["optTeams"], LabelTeam)),
		Models: sortedKeys(byLabel(r["optModels"], LabelModel)),
		Keys:   sortedKeys(byLabel(r["optKeys"], LabelKey)),
	}
	if len(b.errs) > 0 {
		d.Errors = b.errs
	}
	return d
}

func val(p *float64) float64 {
	if p == nil {
		return 0
	}
	return *p
}
