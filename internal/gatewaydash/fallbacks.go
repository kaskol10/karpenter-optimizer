package gatewaydash

import (
	"context"
	"fmt"
	"sort"
	"time"
)

// FallbackReason is why requests left one model group for another: the
// exception LiteLLM got from the primary ("Hosted_vllm.InternalServerError",
// "…ContextWindowExceededError") and its HTTP status.
type FallbackReason struct {
	Reason    string  `json:"reason"`
	Status    string  `json:"status,omitempty"`
	Succeeded float64 `json:"succeeded"`
	Failed    float64 `json:"failed"`
}

// FallbackStat is the fallbacks LiteLLM took from one model group to
// another over a window: how many the fallback then served, how many failed
// there too, and why they happened, most frequent first.
type FallbackStat struct {
	From      string           `json:"from"` // requested_model
	To        string           `json:"to"`   // fallback_model
	Succeeded float64          `json:"succeeded"`
	Failed    float64          `json:"failed"`
	Reasons   []FallbackReason `json:"reasons"`
}

const fallbackLabels = "requested_model, fallback_model, exception_class, exception_status"

// RequestsByModel returns the requests per requested model over the
// filter's window (default 7d): what a fallback count is a share of.
func RequestsByModel(ctx context.Context, q Querier, f Filter, now time.Time) (map[string]float64, error) {
	if err := f.Validate(); err != nil {
		return nil, err
	}
	if f.Range == "" {
		f.Range = "7d"
	}
	w := f.Resolve(now)
	samples, err := q.Query(ctx, fmt.Sprintf("sum by (%s) (increase(%s[%ds]))", LabelModel, counter("litellm_proxy_total_requests_metric", f.matchers(nil)), w.Seconds()), w.To)
	if err != nil {
		return nil, err
	}
	out := byLabel(samples, LabelModel)
	for k, v := range out {
		if v < 0.5 {
			delete(out, k)
		}
	}
	return out, nil
}

// Fallbacks returns the fallbacks taken in the filter's window, busiest
// first, from litellm_deployment_successful_fallbacks / _failed_fallbacks
// (which carry both ends and the exception on one series). The default
// range is 7d.
func Fallbacks(ctx context.Context, q Querier, f Filter, now time.Time) ([]FallbackStat, Window, error) {
	if err := f.Validate(); err != nil {
		return nil, Window{}, err
	}
	if f.Range == "" {
		f.Range = "7d"
	}
	w := f.Resolve(now)
	query := func(metric string) ([]Sample, error) {
		return q.Query(ctx, fmt.Sprintf("sum by (%s) (increase(%s[%ds]))", fallbackLabels, counter(metric, f.matchers(nil)), w.Seconds()), w.To)
	}
	ok, err := query("litellm_deployment_successful_fallbacks")
	if err != nil {
		return nil, w, err
	}
	failed, err := query("litellm_deployment_failed_fallbacks")
	if err != nil {
		return nil, w, err
	}

	type pair struct{ from, to string }
	stats := map[pair]*FallbackStat{}
	reasons := map[pair]map[[2]string]*FallbackReason{}
	add := func(samples []Sample, failed bool) {
		for _, s := range samples {
			// increase() extrapolates: under half a request is none.
			if s.Value < 0.5 {
				continue
			}
			k := pair{s.Metric["requested_model"], s.Metric["fallback_model"]}
			if k.from == "" || k.to == "" {
				continue
			}
			st := stats[k]
			if st == nil {
				st = &FallbackStat{From: k.from, To: k.to}
				stats[k] = st
				reasons[k] = map[[2]string]*FallbackReason{}
			}
			rk := [2]string{s.Metric["exception_class"], s.Metric["exception_status"]}
			r := reasons[k][rk]
			if r == nil {
				r = &FallbackReason{Reason: rk[0], Status: rk[1]}
				reasons[k][rk] = r
			}
			if failed {
				st.Failed += s.Value
				r.Failed += s.Value
			} else {
				st.Succeeded += s.Value
				r.Succeeded += s.Value
			}
		}
	}
	add(ok, false)
	add(failed, true)

	out := make([]FallbackStat, 0, len(stats))
	for k, st := range stats {
		for _, r := range reasons[k] {
			st.Reasons = append(st.Reasons, *r)
		}
		sort.Slice(st.Reasons, func(i, j int) bool {
			a, b := st.Reasons[i], st.Reasons[j]
			if a.Succeeded+a.Failed != b.Succeeded+b.Failed {
				return a.Succeeded+a.Failed > b.Succeeded+b.Failed
			}
			return a.Reason+a.Status < b.Reason+b.Status
		})
		out = append(out, *st)
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Succeeded+a.Failed != b.Succeeded+b.Failed {
			return a.Succeeded+a.Failed > b.Succeeded+b.Failed
		}
		return a.From+"\x00"+a.To < b.From+"\x00"+b.To
	})
	return out, w, nil
}
