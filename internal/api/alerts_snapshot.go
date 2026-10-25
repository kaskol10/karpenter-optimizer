package api

import (
	"context"
	"time"

	"github.com/karpenter-optimizer/internal/alerts"
	"github.com/karpenter-optimizer/internal/kubernetes"
	"github.com/karpenter-optimizer/internal/litellm"
)

// buildAlertSnapshot assembles the point-in-time state the alert evaluator
// reads, reusing data the server already samples (history store, serving
// history store, gateway cache, the tick's disruption list). It performs no
// heavy AWS pricing or per-node fan-out beyond the disruption list.
func (s *Server) buildAlertSnapshot(ctx context.Context, disruptions []kubernetes.NodeDisruptionInfo) alerts.Snapshot {
	now := time.Now()
	snap := alerts.Snapshot{Time: now}

	// Cost spike: current vs trailing average from the history store.
	if s.historyStore != nil {
		points := s.historyStore.Series(24 * time.Hour)
		var costs []float64
		for _, p := range points {
			// Partially-priced samples (an unpriceable node counted as $0)
			// understate the true cost and would fake a spike/dip, so they
			// are treated as no-data.
			if p.CostPerHour > 0 && !p.CostUnknown {
				costs = append(costs, p.CostPerHour)
			}
		}
		// The current cost must be the most recent sample; if the latest
		// sample has an unknown cost there is no data for this tick.
		if len(points) > 0 && points[len(points)-1].CostUnknown {
			costs = nil
		}
		// Need a reasonable baseline: at least a dozen priced points.
		if len(costs) >= 12 {
			current := costs[len(costs)-1]
			baseline := costs[:len(costs)-1]
			var sum float64
			for _, c := range baseline {
				sum += c
			}
			snap.CostPerHour = current
			snap.Cost24hAverage = sum / float64(len(baseline))
			snap.HasCostBaseline = true
		}
	}

	// Disruption blocked-for: longest time a blocked node has been blocked.
	for i := range disruptions {
		d := &disruptions[i]
		if !d.IsBlocked {
			continue
		}
		first, perr := time.Parse(time.RFC3339, d.FirstSeen)
		if perr != nil {
			continue
		}
		if held := now.Sub(first); held > snap.DisruptionBlockedFor {
			snap.DisruptionBlockedFor = held
		}
	}

	// Serving: KV-cache max + longest offline, from the serving history store.
	if s.servingHistoryStore != nil {
		window := historyWindowFromEnv()
		for _, key := range s.servingHistoryStore.Pods() {
			ns, name := splitPodKey(key)
			series := s.servingHistoryStore.Series(ns, name, window)
			if len(series) == 0 {
				continue
			}
			snap.HasServingPods = true
			latest := series[len(series)-1]
			if latest.KVCachePercent != nil && *latest.KVCachePercent > snap.ServingKVCacheMax {
				snap.ServingKVCacheMax = *latest.KVCachePercent
			}
			if !latest.Online {
				// Walk the trailing offline run to size the offline duration.
				cutoff := series[len(series)-1].Unix
				for i := len(series) - 1; i >= 0; i-- {
					if series[i].Online {
						break
					}
					cutoff = series[i].Unix
				}
				if held := now.Sub(time.Unix(cutoff, 0)); held > snap.ServingOfflineFor {
					snap.ServingOfflineFor = held
				}
			}
		}
	}

	// Gateway: prefer the 15s cache, else a bounded probe.
	gw, ok := gatewayCache()
	if !ok && s.k8sClient != nil {
		pods, perr := s.k8sClient.FindLiteLLMPods(ctx)
		if perr == nil && len(pods) > 0 {
			refs := make([]litellm.PodRef, 0, len(pods))
			for _, p := range pods {
				refs = append(refs, litellm.PodRef{IP: p.IP, Port: p.Port})
			}
			gw = litellmProber.ProbeAll(ctx, refs)
			storeGatewayCache(gw)
		}
	}
	if gw.Online || gw.Pods > 0 {
		snap.GatewayOnline = gw.Online
		if gw.ErrorRatePct != nil {
			snap.GatewayErrorRatePct = *gw.ErrorRatePct
		}
		snap.GatewayRejectedTotal = gw.AdmissionRejected
	}

	return snap
}

// splitPodKey splits a "namespace/name" serving-history key.
func splitPodKey(key string) (string, string) {
	if i := indexOfSlash(key); i >= 0 {
		return key[:i], key[i+1:]
	}
	return "", key
}

func indexOfSlash(s string) int {
	for i := 0; i < len(s); i++ {
		if s[i] == '/' {
			return i
		}
	}
	return -1
}
