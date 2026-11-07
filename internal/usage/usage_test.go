package usage

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func near(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

func TestParseQuantity(t *testing.T) {
	t.Parallel()
	cases := map[string]float64{
		"250m": 0.25, "2": 2, "1500000n": 0.0015, "750u": 0.00075,
		"512Mi": 512 << 20, "2Gi": 2 << 30, "100Ki": 100 << 10, "1Ti": 1 << 40,
		"3k": 3000, "2M": 2e6, "1G": 1e9, "1T": 1e12, " 4 ": 4,
	}
	for in, want := range cases {
		got, err := ParseQuantity(in)
		if err != nil || !near(got, want) {
			t.Errorf("ParseQuantity(%q) = %v, %v; want %v", in, got, err, want)
		}
	}
	for _, bad := range []string{"", "abc", "xMi", "1.2.3m"} {
		if _, err := ParseQuantity(bad); err == nil {
			t.Errorf("ParseQuantity(%q) succeeded", bad)
		}
	}
}

func TestMetricsServerFetch(t *testing.T) {
	t.Parallel()
	body := `{"items":[
	  {"metadata":{"name":"web-1","namespace":"prod"},"containers":[{"usage":{"cpu":"250m","memory":"512Mi"}},{"usage":{"cpu":"50m","memory":"512Mi"}}]},
	  {"metadata":{"name":"odd","namespace":"prod"},"containers":[{"usage":{"cpu":"lots","memory":""}}]}
	]}`
	var gotPath string
	m := &MetricsServer{Get: func(ctx context.Context, p string) ([]byte, error) { gotPath = p; return []byte(body), nil }}
	snap, err := m.Fetch(context.Background())
	if err != nil {
		t.Fatalf("Fetch() error = %v", err)
	}
	if gotPath != MetricsServerPath || m.Name() != "metrics-server" {
		t.Errorf("path %q name %q", gotPath, m.Name())
	}
	if snap.Source != "metrics-server" || snap.Window != "live" {
		t.Errorf("snapshot meta = %q %q", snap.Source, snap.Window)
	}
	if u := snap.Pods["prod/web-1"]; !near(u.CPUCores, 0.3) || !near(u.MemoryGiB, 1) {
		t.Errorf("web-1 = %+v, want 0.3 cores, 1 GiB", u)
	}
	if u := snap.Pods["prod/odd"]; u.CPUCores != 0 || u.MemoryGiB != 0 {
		t.Errorf("unparseable usage must count as 0, got %+v", u)
	}

	bad := &MetricsServer{Get: func(context.Context, string) ([]byte, error) { return []byte("{"), nil }}
	if _, err := bad.Fetch(context.Background()); err == nil {
		t.Error("bad JSON accepted")
	}
	down := &MetricsServer{Get: func(context.Context, string) ([]byte, error) { return nil, errors.New("404") }}
	if _, err := down.Fetch(context.Background()); err == nil {
		t.Error("API error swallowed")
	}
}

// promServer answers each query with the given body (by substring match).
func promServer(t *testing.T, answers map[string]string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/query" {
			http.NotFound(w, r)
			return
		}
		q := r.URL.Query().Get("query")
		for k, v := range answers {
			if strings.Contains(q, k) {
				if v == "500" {
					w.WriteHeader(http.StatusInternalServerError)
					return
				}
				_, _ = w.Write([]byte(v))
				return
			}
		}
		_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"vector","result":[]}}`))
	}))
}

func vector(samples ...string) string {
	return `{"status":"success","data":{"resultType":"vector","result":[` + strings.Join(samples, ",") + `]}}`
}

func sample(labels string, v string) string {
	return fmt.Sprintf(`{"metric":{%s},"value":[1700000000,%q]}`, labels, v)
}

func TestPrometheusFetch(t *testing.T) {
	t.Parallel()
	srv := promServer(t, map[string]string{
		"container_cpu_usage_seconds_total": vector(
			sample(`"namespace":"prod","pod":"web-1"`, "0.42"),
			sample(`"namespace":"prod"`, "9"),
			sample(`"namespace":"prod","pod":"nan"`, "NaN"),
		),
		"container_memory_working_set_bytes": vector(sample(`"namespace":"prod","pod":"web-1"`, "2147483648")),
		"DCGM_FI_DEV_FB_USED":                vector(sample(`"UUID":"GPU-aaa"`, "31000"), sample(`"gpu":"0"`, "5")),
	})
	defer srv.Close()

	p := NewPrometheus(srv.URL + "/")
	snap, err := p.Fetch(context.Background())
	if err != nil {
		t.Fatalf("Fetch() error = %v", err)
	}
	if p.Name() != "prometheus" || snap.Source != "prometheus" || snap.Window != "p95 over 24h" {
		t.Errorf("meta = %q %q %q", p.Name(), snap.Source, snap.Window)
	}
	if u := snap.Pods["prod/web-1"]; !near(u.CPUCores, 0.42) || !near(u.MemoryGiB, 2) {
		t.Errorf("web-1 = %+v", u)
	}
	if len(snap.Pods) != 1 {
		t.Errorf("series without a pod label or with NaN must be skipped, got %v", snap.Pods)
	}
	if snap.GPUs["GPU-aaa"] != 31000 || len(snap.GPUs) != 1 {
		t.Errorf("GPUs = %v", snap.GPUs)
	}
}

func TestPrometheusFailures(t *testing.T) {
	t.Parallel()
	cases := map[string]map[string]string{
		"cpu HTTP 500":  {"container_cpu": "500"},
		"memory fails":  {"container_memory": "500"},
		"not success":   {"container_cpu": `{"status":"error","error":"bad query"}`},
		"matrix result": {"container_cpu": `{"status":"success","data":{"resultType":"matrix","result":[]}}`},
		"bad JSON":      {"container_cpu": `{`},
	}
	for name, answers := range cases {
		srv := promServer(t, answers)
		if _, err := NewPrometheus(srv.URL).Fetch(context.Background()); err == nil {
			t.Errorf("%s: Fetch succeeded", name)
		}
		srv.Close()
	}

	// The DCGM query is optional.
	srv := promServer(t, map[string]string{"DCGM": "500"})
	defer srv.Close()
	snap, err := NewPrometheus(srv.URL).Fetch(context.Background())
	if err != nil || len(snap.GPUs) != 0 {
		t.Errorf("missing DCGM must not fail the fetch: %v %v", snap, err)
	}

	if _, err := NewPrometheus("http://127.0.0.1:0").Fetch(context.Background()); err == nil {
		t.Error("unreachable Prometheus succeeded")
	}
	if _, err := NewPrometheus("://bad").Fetch(context.Background()); err == nil {
		t.Error("bad URL succeeded")
	}
	// A non-string sample value is skipped, not fatal.
	odd := promServer(t, map[string]string{"container_cpu": `{"status":"success","data":{"resultType":"vector","result":[{"metric":{"namespace":"a","pod":"b"},"value":[1,2]}]}}`})
	defer odd.Close()
	if snap, err := NewPrometheus(odd.URL).Fetch(context.Background()); err != nil || snap.Pods["a/b"].CPUCores != 0 {
		t.Errorf("odd sample: %v %v", snap, err)
	}
}

type fakeProvider struct {
	name  string
	err   error
	calls int
}

func (f *fakeProvider) Name() string { return f.name }
func (f *fakeProvider) Fetch(context.Context) (*Snapshot, error) {
	f.calls++
	if f.err != nil {
		return nil, f.err
	}
	return &Snapshot{Source: f.name}, nil
}

func TestCollector(t *testing.T) {
	t.Parallel()
	prom := &fakeProvider{name: "prometheus", err: errors.New("down")}
	ms := &fakeProvider{name: "metrics-server"}
	c := NewCollector(time.Minute, prom, ms)
	now := time.Unix(1000, 0)
	c.nowFunc = func() time.Time { return now }

	// Falls back to the next provider and caches it.
	if s := c.Get(context.Background()); s == nil || s.Source != "metrics-server" {
		t.Fatalf("Get() = %+v", s)
	}
	c.Get(context.Background())
	if prom.calls != 1 || ms.calls != 1 {
		t.Errorf("cached call hit providers: prom=%d ms=%d", prom.calls, ms.calls)
	}

	// After the TTL it asks again; the preferred source wins once it is back.
	now = now.Add(2 * time.Minute)
	prom.err = nil
	if s := c.Get(context.Background()); s.Source != "prometheus" {
		t.Errorf("Get() after recovery = %q", s.Source)
	}

	// Nothing available: nil, cached too.
	prom.err, ms.err = errors.New("down"), errors.New("down")
	now = now.Add(2 * time.Minute)
	first := c.Get(context.Background())
	second := c.Get(context.Background()) // served from the cached miss
	if first != nil || second != nil {
		t.Error("expected nil without sources")
	}
	if ms.calls != 2 {
		t.Errorf("a cached miss must not refetch, ms calls = %d", ms.calls)
	}

	var nilCollector *Collector
	if nilCollector.Get(context.Background()) != nil {
		t.Error("nil collector must return nil")
	}
}
