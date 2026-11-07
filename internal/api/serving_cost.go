package api

import (
	"context"

	"github.com/karpenter-optimizer/internal/awspricing"
	"github.com/karpenter-optimizer/internal/hostedprices"
	"github.com/karpenter-optimizer/internal/llmhealth"
	"github.com/karpenter-optimizer/internal/recommender"
)

// nodePrice is the hourly price of one instance and where it came from. ok is
// false when the instance could not be priced.
type nodePrice func(instanceType, capacityType string) (cost float64, source string, ok bool)

// attachServingCost fills Cost on each serving pod from the recommender's
// cached instance prices. Pods it cannot price keep a nil Cost.
func (s *Server) attachServingCost(ctx context.Context, health []llmhealth.PodHealth) {
	if s.recommender == nil || s.config == nil {
		return
	}
	price := func(instanceType, capacityType string) (float64, string, bool) {
		res, _ := s.recommender.EstimateCostWithSource(ctx, []string{instanceType}, capacityType, 1)
		if res.Source == recommender.PricingSourceUnknown || res.Cost <= 0 {
			return 0, "", false
		}
		return res.Cost, string(res.Source), true
	}
	attachCost(health, price, awspricing.PricingCurrencyForRegion(s.config.AWSRegion))
}

// attachCost prices each pod as its node's hourly price times the share of
// the node's GPUs it holds (replicaGPUShare). Prices are looked up once per
// instance type and capacity type. A node of unknown capacity type is priced
// as on-demand, the project-wide default, so the estimate errs high.
func attachCost(health []llmhealth.PodHealth, price nodePrice, currency string) {
	type key struct{ instanceType, capacityType string }
	type result struct {
		cost   float64
		source string
		ok     bool
	}
	cache := map[key]result{}

	for i := range health {
		h := &health[i]
		if h.NodeInstanceType == "" {
			continue
		}
		share, basis, ok := replicaGPUShare(h)
		if !ok {
			continue
		}
		capacityType := h.NodeCapacityType
		if capacityType != "spot" {
			capacityType = "on-demand"
		}
		k := key{h.NodeInstanceType, capacityType}
		r, seen := cache[k]
		if !seen {
			r.cost, r.source, r.ok = price(k.instanceType, k.capacityType)
			cache[k] = r
		}
		if !r.ok {
			continue
		}
		h.Cost = &llmhealth.ReplicaCost{
			CostPerHour:      r.cost * share,
			NodeCostPerHour:  r.cost,
			NodeCapacityType: capacityType,
			Share:            share,
			ShareBasis:       basis,
			Currency:         currency,
			PriceSource:      r.source,
		}
	}
}

// replicaGPUShare is the fraction (0-1] of its node's GPUs a serving pod
// holds:
//   - "gpu-memory": HAMi placement memory over the node's GPU memory, when
//     both are known (fractional GPUs);
//   - "gpu-count": the GPUs it requests, else the cards HAMi placed it on,
//     over the node's GPU count.
//
// ok is false when neither can be worked out.
func replicaGPUShare(h *llmhealth.PodHealth) (float64, string, bool) {
	var memMiB float64
	for _, d := range h.GPUDevices {
		memMiB += float64(d.MemoryMiB)
	}
	if memMiB > 0 && h.NodeGPUMemMiB > 0 {
		return clampShare(memMiB / h.NodeGPUMemMiB), "gpu-memory", true
	}
	if h.GPUCapacity <= 0 {
		return 0, "", false
	}
	gpus := h.GPURequested
	if len(h.GPUDevices) > 0 {
		// Under HAMi the request counts vGPUs; the placed cards are the
		// physical ones.
		gpus = len(h.GPUDevices)
	}
	if gpus <= 0 {
		return 0, "", false
	}
	return clampShare(float64(gpus) / float64(h.GPUCapacity)), "gpu-count", true
}

func clampShare(v float64) float64 {
	if v > 1 {
		return 1
	}
	return v
}

// startHostedPrices begins the daily hosted-price refresh the first time it
// is called (from a /serving request that found serving pods).
func (s *Server) startHostedPrices() {
	if s.hostedPrices == nil || s.rootCtx == nil {
		return
	}
	s.hostedPricesOnce.Do(func() { go s.hostedPrices.Run(s.rootCtx) })
}

// attachHostedPrices fills HostedPrice on each online pod whose model is in
// the hosted catalog. A nil or empty catalog leaves every pod untouched.
func attachHostedPrices(health []llmhealth.PodHealth, catalog *hostedprices.Catalog) {
	fetchedAt := catalog.FetchedAt()
	if fetchedAt.IsZero() {
		return
	}
	for i := range health {
		h := &health[i]
		p, ok := catalog.Lookup(h.Model)
		if !ok {
			continue
		}
		h.HostedPrice = &llmhealth.HostedPrice{
			Source:        "openrouter",
			Model:         p.Model,
			InputPerMTok:  p.InputPerMTok,
			OutputPerMTok: p.OutputPerMTok,
			FetchedAtUnix: fetchedAt.Unix(),
		}
	}
}
