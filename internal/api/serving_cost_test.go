package api

import (
	"context"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/karpenter-optimizer/internal/hostedprices"
	"github.com/karpenter-optimizer/internal/llmhealth"
)

func approx(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

func TestReplicaGPUShare(t *testing.T) {
	t.Parallel()

	dev := func(mem int) llmhealth.GPUDevice { return llmhealth.GPUDevice{UUID: "GPU-x", MemoryMiB: mem} }
	cases := []struct {
		name  string
		pod   llmhealth.PodHealth
		share float64
		basis string
		ok    bool
	}{
		{"HAMi memory over node memory", llmhealth.PodHealth{GPUDevices: []llmhealth.GPUDevice{dev(23000)}, NodeGPUMemMiB: 92000, GPUCapacity: 4}, 0.25, "gpu-memory", true},
		{"memory share is capped at 1", llmhealth.PodHealth{GPUDevices: []llmhealth.GPUDevice{dev(50000)}, NodeGPUMemMiB: 40000, GPUCapacity: 1}, 1, "gpu-memory", true},
		{"placed cards over GPU count when node memory is unknown", llmhealth.PodHealth{GPUDevices: []llmhealth.GPUDevice{dev(46000), dev(46000)}, GPURequested: 8, GPUCapacity: 4}, 0.5, "gpu-count", true},
		{"whole-GPU request over GPU count", llmhealth.PodHealth{GPURequested: 1, GPUCapacity: 8}, 0.125, "gpu-count", true},
		{"request above capacity is capped", llmhealth.PodHealth{GPURequested: 4, GPUCapacity: 2}, 1, "gpu-count", true},
		{"no GPU count on the node", llmhealth.PodHealth{GPURequested: 1}, 0, "", false},
		{"no GPU on the pod", llmhealth.PodHealth{GPUCapacity: 4}, 0, "", false},
	}
	for _, tc := range cases {
		share, basis, ok := replicaGPUShare(&tc.pod)
		if ok != tc.ok || basis != tc.basis || !approx(share, tc.share) {
			t.Errorf("%s: got (%v, %q, %v), want (%v, %q, %v)", tc.name, share, basis, ok, tc.share, tc.basis, tc.ok)
		}
	}
}

func TestAttachCost(t *testing.T) {
	t.Parallel()

	// #given: two replicas on the same spot node type, one on an unknown
	// capacity type, one unpriceable, one without placement
	health := []llmhealth.PodHealth{
		{Name: "a", NodeInstanceType: "g6e.12xlarge", NodeCapacityType: "spot", GPURequested: 1, GPUCapacity: 4},
		{Name: "b", NodeInstanceType: "g6e.12xlarge", NodeCapacityType: "spot", GPURequested: 2, GPUCapacity: 4},
		{Name: "c", NodeInstanceType: "g6e.12xlarge", GPURequested: 4, GPUCapacity: 4},
		{Name: "d", NodeInstanceType: "p9.mystery", GPURequested: 1, GPUCapacity: 1},
		{Name: "e", GPURequested: 1, GPUCapacity: 1},
	}
	calls := map[string]int{}
	price := func(instanceType, capacityType string) (float64, string, bool) {
		calls[instanceType+"/"+capacityType]++
		switch {
		case instanceType == "g6e.12xlarge" && capacityType == "spot":
			return 2.5, "aws-pricing-api", true
		case instanceType == "g6e.12xlarge":
			return 10, "aws-pricing-api", true
		}
		return 0, "", false
	}

	// #when
	attachCost(health, price, "USD")

	// #then
	if c := health[0].Cost; c == nil || !approx(c.CostPerHour, 0.625) || c.Share != 0.25 || c.NodeCapacityType != "spot" || c.Currency != "USD" || c.PriceSource != "aws-pricing-api" {
		t.Errorf("a cost = %+v, want 0.625/h at a 0.25 share of a 2.5/h spot node", c)
	}
	if c := health[1].Cost; c == nil || !approx(c.CostPerHour, 1.25) {
		t.Errorf("b cost = %+v, want 1.25/h", c)
	}
	if c := health[2].Cost; c == nil || c.NodeCapacityType != "on-demand" || !approx(c.CostPerHour, 10) {
		t.Errorf("c cost = %+v, want the on-demand price for an unknown capacity type", c)
	}
	if health[3].Cost != nil || health[4].Cost != nil {
		t.Errorf("unpriceable or unplaced pods must keep a nil cost, got %+v / %+v", health[3].Cost, health[4].Cost)
	}
	if calls["g6e.12xlarge/spot"] != 1 {
		t.Errorf("prices must be looked up once per instance and capacity type, got %d calls", calls["g6e.12xlarge/spot"])
	}
}

func TestAttachHostedPrices(t *testing.T) {
	t.Parallel()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"data":[{"id":"meta-llama/llama-3.3-70b-instruct","hugging_face_id":"meta-llama/Llama-3.3-70B-Instruct","pricing":{"prompt":"0.0000001","completion":"0.0000003"}}]}`))
	}))
	defer srv.Close()

	health := []llmhealth.PodHealth{{Model: "meta-llama/Llama-3.3-70B-Instruct"}, {Model: "my-finetune"}}

	// #given an empty catalog, nothing is attached
	catalog := hostedprices.New(srv.URL)
	attachHostedPrices(health, catalog)
	attachHostedPrices(health, nil)
	if health[0].HostedPrice != nil {
		t.Fatalf("empty catalog attached %+v", health[0].HostedPrice)
	}

	// #when the catalog has been fetched
	if err := catalog.Refresh(context.Background()); err != nil {
		t.Fatalf("Refresh() error = %v", err)
	}
	attachHostedPrices(health, catalog)

	// #then
	hp := health[0].HostedPrice
	if hp == nil || hp.Source != "openrouter" || hp.Model != "meta-llama/llama-3.3-70b-instruct" || !approx(hp.InputPerMTok, 0.1) || !approx(hp.OutputPerMTok, 0.3) || hp.FetchedAtUnix == 0 {
		t.Errorf("hosted price = %+v", hp)
	}
	if health[1].HostedPrice != nil {
		t.Errorf("unknown model got a hosted price: %+v", health[1].HostedPrice)
	}
}

func TestStartHostedPricesNeedsRootContext(t *testing.T) {
	t.Parallel()
	// A Server built without NewServer (as in other tests) must not panic.
	(&Server{}).startHostedPrices()
	(&Server{hostedPrices: hostedprices.New("http://127.0.0.1:0")}).startHostedPrices()
}
