package gatewaydash

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestPromQueryAndRange(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query().Get("query")
		switch {
		case r.URL.Path == "/api/v1/query" && q == "up":
			if r.URL.Query().Get("time") != "1000" {
				t.Errorf("time %s", r.URL.Query().Get("time"))
			}
			_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"vector","result":[
				{"metric":{"job":"a"},"value":[1000,"1.5"]},{"metric":{"job":"b"},"value":[1000,"NaN"]},{"metric":{"job":"c"},"value":[1000,7]}]}}`))
		case r.URL.Path == "/api/v1/query_range" && q == "x":
			if r.URL.Query().Get("step") != "86400" {
				t.Errorf("step %s", r.URL.Query().Get("step"))
			}
			_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"matrix","result":[
				{"metric":{"m":"x"},"values":[[86400,"2"],[172800.5,"3"],["bad","4"],[259200,"+Inf"]]}]}}`))
		case q == "matrix":
			_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"matrix","result":[]}}`))
		case q == "broken":
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"status":"error","error":"parse error"}`))
		default:
			_, _ = w.Write([]byte(`not json`))
		}
	}))
	defer srv.Close()
	p := NewProm(srv.URL + "/")
	ctx := context.Background()

	s, err := p.Query(ctx, "up", time.Unix(1000, 0))
	if err != nil || len(s) != 1 || s[0].Value != 1.5 || s[0].Metric["job"] != "a" {
		t.Fatalf("query: %v %+v", err, s)
	}
	series, err := p.QueryRange(ctx, "x", time.Unix(0, 0), time.Unix(259200, 0), 24*time.Hour)
	if err != nil || len(series) != 1 || len(series[0].Points) != 2 || series[0].Points[1].V != 3 {
		t.Fatalf("range: %v %+v", err, series)
	}
	if !series[0].Points[1].T.Equal(time.Unix(172800, 5e8)) {
		t.Fatalf("time: %v", series[0].Points[1].T)
	}
	if _, err := p.Query(ctx, "matrix", time.Now()); err == nil {
		t.Error("a matrix from an instant query should fail")
	}
	if _, err := p.QueryRange(ctx, "up", time.Now(), time.Now(), time.Minute); err == nil {
		t.Error("a vector from a range query should fail")
	}
	if _, err := p.Query(ctx, "broken", time.Now()); err == nil || err.Error() != "prometheus: HTTP 400: parse error" {
		t.Errorf("error: %v", err)
	}
	if _, err := p.Query(ctx, "garbage", time.Now()); err == nil {
		t.Error("garbage should fail")
	}
	if _, err := p.QueryRange(ctx, "broken", time.Now(), time.Now(), time.Minute); err == nil {
		t.Error("range error should fail")
	}
	if _, err := NewProm("http://127.0.0.1:1").Query(ctx, "up", time.Now()); err == nil {
		t.Error("unreachable should fail")
	}
	if _, err := NewProm("http://bad host").Query(ctx, "up", time.Now()); err == nil {
		t.Error("bad url should fail")
	}
}

func TestPromTenantHeader(t *testing.T) {
	var got []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = append(got, r.Header.Get("X-Scope-OrgID"))
		_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"vector","result":[]}}`))
	}))
	defer srv.Close()

	p := NewProm(srv.URL)
	if _, err := p.Query(context.Background(), "up", time.Now()); err != nil {
		t.Fatal(err)
	}
	p.Tenant = "prod"
	if _, err := p.Query(context.Background(), "up", time.Now()); err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0] != "" || got[1] != "prod" {
		t.Errorf("X-Scope-OrgID = %q, want none then prod", got)
	}
}
