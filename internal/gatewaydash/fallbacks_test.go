package gatewaydash

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func fb(from, to, class, status string, v float64) Sample {
	return Sample{Metric: map[string]string{"requested_model": from, "fallback_model": to, "exception_class": class, "exception_status": status}, Value: v}
}

func TestFallbacks(t *testing.T) {
	p := &fakeProm{instant: []rule{
		{contains: "litellm_deployment_successful_fallbacks", samples: []Sample{
			fb("acme/small", "together/small", "Hosted_vllm.InternalServerError", "500", 102),
			fb("acme/small", "together/small", "Hosted_vllm.BadGatewayError", "502", 52),
			fb("acme/large", "together/small", "Hosted_vllm.ContextWindowExceededError", "400", 36),
			fb("acme/large", "together/small", "Hosted_vllm.Timeout", "408", 0.2), // extrapolation noise
			fb("", "together/small", "x", "500", 9),
		}},
		{contains: "litellm_deployment_failed_fallbacks", samples: []Sample{
			fb("acme/small", "together/small", "Hosted_vllm.InternalServerError", "500", 3),
			fb("acme/embed", "together/small", "Hosted_vllm.APIConnectionError", "500", 4),
		}},
	}}
	got, w, err := Fallbacks(context.Background(), p, Filter{Team: "search"}, now)
	if err != nil {
		t.Fatal(err)
	}
	if w.Seconds() != 7*24*3600 {
		t.Errorf("default window %v", w)
	}
	for _, q := range p.seen {
		if !strings.Contains(q, `team_alias="search"`) || !strings.Contains(q, "[604800s]") ||
			!strings.Contains(q, "by (requested_model, fallback_model, exception_class, exception_status)") {
			t.Errorf("query %s", q)
		}
	}
	if len(got) != 3 {
		t.Fatalf("%+v", got)
	}
	small := got[0]
	if small.From != "acme/small" || small.To != "together/small" || small.Succeeded != 154 || small.Failed != 3 {
		t.Errorf("busiest %+v", small)
	}
	if len(small.Reasons) != 2 || small.Reasons[0] != (FallbackReason{Reason: "Hosted_vllm.InternalServerError", Status: "500", Succeeded: 102, Failed: 3}) {
		t.Errorf("reasons %+v", small.Reasons)
	}
	if got[1].From != "acme/large" || len(got[1].Reasons) != 1 || got[2].From != "acme/embed" || got[2].Failed != 4 || got[2].Succeeded != 0 {
		t.Errorf("rest %+v", got[1:])
	}
}

func TestFallbacksErrors(t *testing.T) {
	if _, _, err := Fallbacks(context.Background(), &fakeProm{}, Filter{Range: "1y"}, now); !errors.Is(err, ErrBadRange) {
		t.Errorf("bad range: %v", err)
	}
	boom := errors.New("boom")
	for _, metric := range []string{"successful_fallbacks", "failed_fallbacks"} {
		p := &fakeProm{instant: []rule{{contains: metric, err: boom}}}
		if _, _, err := Fallbacks(context.Background(), p, Filter{Range: "24h"}, now); !errors.Is(err, boom) {
			t.Errorf("%s: %v", metric, err)
		}
	}
	got, _, err := Fallbacks(context.Background(), &fakeProm{}, Filter{}, now)
	if err != nil || got == nil || len(got) != 0 {
		t.Errorf("none: %+v %v", got, err)
	}
}

func TestRequestsByModel(t *testing.T) {
	p := &fakeProm{instant: []rule{{contains: "litellm_proxy_total_requests_metric", samples: by(LabelModel, "acme/small", 900.0, "acme/idle", 0.1)}}}
	got, err := RequestsByModel(context.Background(), p, Filter{}, now)
	if err != nil || len(got) != 1 || got["acme/small"] != 900 {
		t.Errorf("%+v %v", got, err)
	}
	if !strings.Contains(p.seen[0], "sum by (requested_model)") || !strings.Contains(p.seen[0], "[604800s]") {
		t.Errorf("query %s", p.seen[0])
	}
	if _, err := RequestsByModel(context.Background(), p, Filter{Range: "1y"}, now); !errors.Is(err, ErrBadRange) {
		t.Errorf("bad range: %v", err)
	}
	boom := errors.New("boom")
	if _, err := RequestsByModel(context.Background(), &fakeProm{instant: []rule{{contains: "requests", err: boom}}}, Filter{}, now); !errors.Is(err, boom) {
		t.Errorf("error: %v", err)
	}
}
