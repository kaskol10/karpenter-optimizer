package hostedprices

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const sample = `{"data":[
 {"id":"meta-llama/llama-3.3-70b-instruct","canonical_slug":"meta-llama/llama-3.3-70b-instruct-v1","hugging_face_id":"meta-llama/Llama-3.3-70B-Instruct",
  "pricing":{"prompt":"0.00000013","completion":"0.00000039"}},
 {"id":"meta-llama/llama-3.3-70b-instruct:free","hugging_face_id":"meta-llama/Llama-3.3-70B-Instruct",
  "pricing":{"prompt":"0","completion":"0"}},
 {"id":"qwen/qwen3-8b","hugging_face_id":"Qwen/Qwen3-8B","pricing":{"prompt":"0.00000005","completion":"0.0000002"}},
 {"id":"qwen/qwen3-8b-pricey","hugging_face_id":"Qwen/Qwen3-8B","pricing":{"prompt":"0.000001","completion":"0.000002"}},
 {"id":"openrouter/auto","pricing":{"prompt":"-1","completion":"-1"}},
 {"id":"broken","pricing":{"prompt":"n/a","completion":"1"}}
]}`

func TestParseAndLookup(t *testing.T) {
	t.Parallel()

	byKey, err := parse(strings.NewReader(sample))
	if err != nil {
		t.Fatalf("parse() error = %v", err)
	}
	c := New("")
	c.byKey = byKey

	cases := []struct {
		served, model string
		in, out       float64
		ok            bool
	}{
		// Hugging Face id, any case; the free variant does not shadow it
		{"meta-llama/Llama-3.3-70B-Instruct", "meta-llama/llama-3.3-70b-instruct", 0.13, 0.39, true},
		{"META-LLAMA/LLAMA-3.3-70B-INSTRUCT", "meta-llama/llama-3.3-70b-instruct", 0.13, 0.39, true},
		// base name matches its -instruct variant
		{"meta-llama/Llama-3.3-70B", "meta-llama/llama-3.3-70b-instruct", 0.13, 0.39, true},
		// OpenRouter id and canonical slug
		{"meta-llama/llama-3.3-70b-instruct-v1", "meta-llama/llama-3.3-70b-instruct", 0.13, 0.39, true},
		// several paid variants: the cheapest wins
		{"Qwen/Qwen3-8B", "qwen/qwen3-8b", 0.05, 0.2, true},
		// routers with variable prices and unparseable entries are skipped
		{"openrouter/auto", "", 0, 0, false},
		{"broken", "", 0, 0, false},
		{"", "", 0, 0, false},
		{"my-finetune", "", 0, 0, false},
	}
	for _, tc := range cases {
		p, ok := c.Lookup(tc.served)
		if ok != tc.ok || p.Model != tc.model || !near(p.InputPerMTok, tc.in) || !near(p.OutputPerMTok, tc.out) {
			t.Errorf("Lookup(%q) = %+v, %v; want %s %v/%v %v", tc.served, p, ok, tc.model, tc.in, tc.out, tc.ok)
		}
	}

	var nilCatalog *Catalog
	if _, ok := nilCatalog.Lookup("x"); ok || !nilCatalog.FetchedAt().IsZero() {
		t.Error("a nil catalog must be empty")
	}
}

func near(a, b float64) bool { return a-b < 1e-9 && b-a < 1e-9 }

func TestParseRejectsEmptyOrInvalid(t *testing.T) {
	t.Parallel()
	for _, body := range []string{`not json`, `{"data":[]}`, `{"data":[{"id":"x","pricing":{"prompt":"0","completion":"0"}}]}`} {
		if _, err := parse(strings.NewReader(body)); err == nil {
			t.Errorf("parse(%q) succeeded, want an error", body)
		}
	}
}

func TestRefresh(t *testing.T) {
	t.Parallel()

	status := int32(http.StatusOK)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(int(atomic.LoadInt32(&status)))
		_, _ = w.Write([]byte(sample))
	}))
	defer srv.Close()

	c := New(srv.URL)
	if err := c.Refresh(context.Background()); err != nil {
		t.Fatalf("Refresh() error = %v", err)
	}
	if c.FetchedAt().IsZero() {
		t.Fatal("FetchedAt not set")
	}
	if _, ok := c.Lookup("Qwen/Qwen3-8B"); !ok {
		t.Fatal("price missing after refresh")
	}

	// A failed refresh keeps the previous catalog.
	atomic.StoreInt32(&status, http.StatusBadGateway)
	if err := c.Refresh(context.Background()); err == nil {
		t.Fatal("Refresh() on HTTP 502 succeeded")
	}
	if _, ok := c.Lookup("Qwen/Qwen3-8B"); !ok {
		t.Fatal("a failed refresh dropped the old catalog")
	}

	if err := New("http://127.0.0.1:0").Refresh(context.Background()); err == nil {
		t.Error("Refresh() against a closed port succeeded")
	}
	if err := New("://bad").Refresh(context.Background()); err == nil {
		t.Error("Refresh() with a bad URL succeeded")
	}
}

func TestRefreshIfDueBacksOff(t *testing.T) {
	t.Parallel()

	var hits int32
	ok := int32(0)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		if atomic.LoadInt32(&ok) == 0 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte(sample))
	}))
	defer srv.Close()

	c := New(srv.URL)
	ctx := context.Background()
	t0 := time.Now()

	c.refreshIfDue(ctx, t0)                     // fails
	c.refreshIfDue(ctx, t0.Add(30*time.Minute)) // still backing off
	c.refreshIfDue(ctx, t0.Add(RetryInterval))  // retries, fails again
	atomic.StoreInt32(&ok, 1)
	c.refreshIfDue(ctx, t0.Add(2*RetryInterval))                 // succeeds
	c.refreshIfDue(ctx, t0.Add(3*RetryInterval))                 // fresh: no fetch
	c.refreshIfDue(ctx, t0.Add(2*RetryInterval+RefreshInterval)) // due again

	if got := atomic.LoadInt32(&hits); got != 4 {
		t.Errorf("fetches = %d, want 4 (fail, retry after 1h, success, daily refresh)", got)
	}
}

func TestRunStopsWithContext(t *testing.T) {
	t.Parallel()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(sample)) }))
	defer srv.Close()

	c := New(srv.URL)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { c.Run(ctx); close(done) }()
	deadline := time.Now().Add(5 * time.Second)
	for c.FetchedAt().IsZero() && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if c.FetchedAt().IsZero() {
		t.Fatal("Run did not fetch on start")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not stop after cancel")
	}
}
