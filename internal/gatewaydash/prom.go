package gatewaydash

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Prom is a minimal Prometheus HTTP API client: instant and range queries.
type Prom struct {
	URL    string
	Client *http.Client
	// Tenant, when set, is sent as X-Scope-OrgID on every query (Grafana
	// Mimir, Cortex and Loki-style multi-tenant Prometheus APIs).
	Tenant string
}

// NewProm returns a client for the Prometheus at baseURL.
func NewProm(baseURL string) *Prom {
	return &Prom{URL: strings.TrimRight(baseURL, "/"), Client: &http.Client{Timeout: 20 * time.Second}}
}

// Sample is one series of an instant vector.
type Sample struct {
	Metric map[string]string
	Value  float64
}

// Series is one series of a range matrix.
type Series struct {
	Metric map[string]string
	Points []Point
}

// Point is one value of a range series.
type Point struct {
	T time.Time
	V float64
}

type apiResponse struct {
	Status string `json:"status"`
	Error  string `json:"error"`
	Data   struct {
		ResultType string `json:"resultType"`
		Result     []struct {
			Metric map[string]string `json:"metric"`
			Value  [2]any            `json:"value"`
			Values [][2]any          `json:"values"`
		} `json:"result"`
	} `json:"data"`
}

func (p *Prom) get(ctx context.Context, path string, params url.Values) (*apiResponse, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.URL+path+"?"+params.Encode(), nil)
	if err != nil {
		return nil, err
	}
	if p.Tenant != "" {
		req.Header.Set("X-Scope-OrgID", p.Tenant)
	}
	resp, err := p.Client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("prometheus: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	var body apiResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<20)).Decode(&body); err != nil {
		return nil, fmt.Errorf("prometheus: HTTP %d: decode: %w", resp.StatusCode, err)
	}
	if body.Status != "success" {
		return nil, fmt.Errorf("prometheus: HTTP %d: %s", resp.StatusCode, body.Error)
	}
	return &body, nil
}

func parseValue(raw any) (float64, bool) {
	s, ok := raw.(string)
	if !ok {
		return 0, false
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil || math.IsNaN(v) || math.IsInf(v, 0) {
		return 0, false
	}
	return v, true
}

func parseTime(raw any) (time.Time, bool) {
	f, ok := raw.(float64)
	if !ok {
		return time.Time{}, false
	}
	sec, frac := math.Modf(f)
	return time.Unix(int64(sec), int64(frac*1e9)).UTC(), true
}

// Query runs an instant query at time at.
func (p *Prom) Query(ctx context.Context, q string, at time.Time) ([]Sample, error) {
	body, err := p.get(ctx, "/api/v1/query", url.Values{"query": {q}, "time": {strconv.FormatInt(at.Unix(), 10)}})
	if err != nil {
		return nil, err
	}
	if body.Data.ResultType != "vector" {
		return nil, fmt.Errorf("prometheus: want a vector, got %q", body.Data.ResultType)
	}
	out := make([]Sample, 0, len(body.Data.Result))
	for _, r := range body.Data.Result {
		if v, ok := parseValue(r.Value[1]); ok {
			out = append(out, Sample{Metric: r.Metric, Value: v})
		}
	}
	return out, nil
}

// QueryRange runs a range query from start to end every step.
func (p *Prom) QueryRange(ctx context.Context, q string, start, end time.Time, step time.Duration) ([]Series, error) {
	body, err := p.get(ctx, "/api/v1/query_range", url.Values{
		"query": {q},
		"start": {strconv.FormatInt(start.Unix(), 10)},
		"end":   {strconv.FormatInt(end.Unix(), 10)},
		"step":  {strconv.FormatInt(int64(step.Seconds()), 10)},
	})
	if err != nil {
		return nil, err
	}
	if body.Data.ResultType != "matrix" {
		return nil, fmt.Errorf("prometheus: want a matrix, got %q", body.Data.ResultType)
	}
	out := make([]Series, 0, len(body.Data.Result))
	for _, r := range body.Data.Result {
		s := Series{Metric: r.Metric}
		for _, pt := range r.Values {
			t, okT := parseTime(pt[0])
			v, okV := parseValue(pt[1])
			if okT && okV {
				s.Points = append(s.Points, Point{T: t, V: v})
			}
		}
		out = append(out, s)
	}
	return out, nil
}
