package api

import (
	"context"
	"log"
	"os"
	"sort"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/karpenter-optimizer/internal/awspricing"
	"github.com/karpenter-optimizer/internal/config"
	"github.com/karpenter-optimizer/internal/kubernetes"
	"github.com/karpenter-optimizer/internal/placementdurable"
	"github.com/karpenter-optimizer/internal/placementhistory"
)

const (
	defaultPlacementInterval = 2 * time.Minute
	defaultPlacementWindow   = 24 * time.Hour
	maxPlacementWindow       = 72 * time.Hour
	// placementKeyEvery is the keyframe spacing: one full snapshot every 60
	// samples (2h at the default interval), deltas in between.
	placementKeyEvery = 60
	// placementMaxPods is the per-node pod cap for samples (the /topology
	// maximum), so replays are not truncated at the default 200.
	placementMaxPods = 1000
)

// placementWindowFromEnv reads PLACEMENT_HISTORY_HOURS (default 24, max 72,
// 0 disables the sampler).
func placementWindowFromEnv() time.Duration {
	v, set := lookupEnvInt("PLACEMENT_HISTORY_HOURS")
	if !set {
		return defaultPlacementWindow
	}
	if v <= 0 {
		return 0
	}
	if d := time.Duration(v) * time.Hour; d < maxPlacementWindow {
		return d
	}
	return maxPlacementWindow
}

// placementIntervalFromEnv reads PLACEMENT_HISTORY_INTERVAL_SECS (default
// 120, at least 30). Each sample lists every node and pod, so it runs less
// often than the cluster trends.
func placementIntervalFromEnv() time.Duration {
	if v, set := lookupEnvInt("PLACEMENT_HISTORY_INTERVAL_SECS"); set && v > 0 {
		if v < 30 {
			v = 30
		}
		return time.Duration(v) * time.Second
	}
	return defaultPlacementInterval
}

func lookupEnvInt(key string) (int, bool) {
	v := os.Getenv(key)
	if v == "" {
		return 0, false
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, false
	}
	return n, true
}

// startPlacementSampler records where every pod runs on each tick into the
// placement-history store, for Topology time travel. No-op without a k8s
// client or when PLACEMENT_HISTORY_HOURS=0.
func (s *Server) startPlacementSampler(ctx context.Context) {
	if s.k8sClient == nil || s.placementHistory == nil {
		return
	}
	interval := s.placementInterval
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		s.samplePlacement(ctx)
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				s.samplePlacement(ctx)
			}
		}
	}()
}

func (s *Server) samplePlacement(parent context.Context) {
	ctx, cancel := context.WithTimeout(parent, 90*time.Second)
	defer cancel()
	nodes, err := s.buildTopologyNodes(ctx, placementMaxPods)
	if err != nil {
		debugLog(s.config.Debug, "[placement-history] sample skipped: %v\n", err)
		return
	}
	reasons, err := s.k8sClient.NodeDisruptionReasons(ctx)
	if err != nil {
		s.placementReasonErr.Do(func() {
			log.Printf("placement history: cannot read node events, terminations will have no reason: %v", err)
		})
	}
	rec, ok := s.placementHistory.Add(snapshotFromTopology(time.Now(), nodes, reasons))
	if ok && s.placementDurable != nil {
		if err := s.placementDurable.Add(rec); err != nil {
			// A lost delta would corrupt later rebuilds: start over from a
			// full keyframe on the next sample.
			s.placementHistory.ForceKeyframe()
			s.placementWriteErr.Do(func() {
				log.Printf("placement history: cannot write to Postgres, keeping it in memory until it recovers: %v", err)
			})
		}
	}
}

// initPlacementDurable opens the durable placement store when a DSN
// resolves and restores the saved history into mem, so a restart keeps
// time travel. nil (memory only) when no DSN is set or the database is
// unreachable.
func initPlacementDurable(cfg *config.Config, mem *placementhistory.Store, retention time.Duration) placementdurable.Store {
	if cfg.PlacementHistoryDSN == "" {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	ps, err := placementdurable.NewPostgres(ctx, cfg.PlacementHistoryDSN, retention)
	if err != nil {
		log.Printf("placement history: Postgres unavailable (%v); keeping it in memory only", err)
		return nil
	}
	restorePlacement(ps, mem, retention, time.Now())
	return ps
}

// restorePlacement loads the saved records into the in-memory store.
func restorePlacement(store placementdurable.Store, mem *placementhistory.Store, retention time.Duration, now time.Time) int {
	recs, err := store.Load(now, retention)
	if err != nil {
		log.Printf("placement history: cannot read saved history: %v", err)
		return 0
	}
	n := mem.Load(recs, now)
	if n > 0 {
		first, last, _ := mem.Range()
		log.Printf("placement history: restored %d samples (%s to %s)", n, first.Format(time.RFC3339), last.Format(time.RFC3339))
	}
	return n
}

// snapshotFromTopology converts topology nodes to a placement snapshot,
// stamping each node with its latest Karpenter disruption reason.
func snapshotFromTopology(at time.Time, nodes []TopologyNode, reasons map[string]string) *placementhistory.Snapshot {
	snap := &placementhistory.Snapshot{
		At:    at,
		Nodes: make(map[string]placementhistory.Node, len(nodes)),
		Pods:  map[string]placementhistory.Pod{},
	}
	for _, n := range nodes {
		hn := placementhistory.Node{
			Name: n.Name, NodePool: n.NodePool, Zone: n.Zone, InstanceType: n.InstanceType,
			CapacityType: n.CapacityType, Architecture: n.Architecture, CreationTime: n.CreationTime,
			PodCount: n.PodCount, GPUCapacity: n.GPUCapacity, GPUAllocated: n.GPUAllocated, GPUModel: n.GPUModel,
			GPUMemTotalMiB: n.GPUMemTotalMiB, GPUMemAllocatedMiB: n.GPUMemAllocatedMiB, GPUPods: n.GPUPods,
			HamiDetected: n.HamiDetected, DisruptionReason: reasons[n.Name],
		}
		if u := n.CPUUsage; u != nil {
			hn.CPUUsed, hn.CPUCapacity, hn.CPUAllocatable, hn.CPUPercent = u.Used, u.Capacity, u.Allocatable, u.Percent
		}
		if u := n.MemoryUsage; u != nil {
			hn.MemUsed, hn.MemCapacity, hn.MemAllocatable, hn.MemPercent = u.Used, u.Capacity, u.Allocatable, u.Percent
		}
		snap.Nodes[n.Name] = hn
		for _, p := range n.Pods {
			hp := placementhistory.Pod{
				Namespace: p.Namespace, Name: p.Name, Node: n.Name, WorkloadName: p.WorkloadName,
				WorkloadType: p.WorkloadType, QOSClass: p.QOSClass, CPUCores: p.Requests.CPUCores,
				MemoryGiB: p.Requests.MemoryGiB, GPU: p.Requests.GPU, GPUMemMiB: p.Requests.GPUMemMiB,
			}
			for _, d := range p.GPUDevices {
				hp.GPUDevices = append(hp.GPUDevices, placementhistory.GPUDevice{UUID: d.UUID, Model: d.Model, Index: d.Index, MemoryMiB: d.MemoryMiB})
			}
			snap.Pods[hp.Key()] = hp
		}
	}
	return snap
}

// topologyFromSnapshot rebuilds the /topology node shape from a snapshot,
// nodes by name and pods by largest CPU request, like the live endpoint.
func topologyFromSnapshot(snap *placementhistory.Snapshot) []TopologyNode {
	podsByNode := map[string][]TopologyPod{}
	for _, p := range snap.Pods {
		tp := TopologyPod{
			Name: p.Name, Namespace: p.Namespace, NodeName: p.Node, WorkloadName: p.WorkloadName,
			WorkloadType: p.WorkloadType, QOSClass: p.QOSClass,
			Requests: TopologyPodResources{CPUCores: p.CPUCores, MemoryGiB: p.MemoryGiB, GPU: p.GPU, GPUMemMiB: p.GPUMemMiB},
		}
		for _, d := range p.GPUDevices {
			tp.GPUDevices = append(tp.GPUDevices, kubernetes.GPUDevice{UUID: d.UUID, Model: d.Model, Index: d.Index, MemoryMiB: d.MemoryMiB})
		}
		podsByNode[p.Node] = append(podsByNode[p.Node], tp)
	}
	out := make([]TopologyNode, 0, len(snap.Nodes))
	for _, name := range sortedNames(snap.Nodes) {
		n := snap.Nodes[name]
		pods := podsByNode[name]
		sortTopologyPods(pods)
		if pods == nil {
			pods = []TopologyPod{}
		}
		out = append(out, TopologyNode{
			Name: n.Name, NodePool: n.NodePool, InstanceType: n.InstanceType, CapacityType: n.CapacityType,
			Architecture: n.Architecture, Zone: n.Zone, PodCount: n.PodCount, Pods: pods, CreationTime: n.CreationTime,
			CPUUsage:    &kubernetes.NodeUsage{Used: n.CPUUsed, Capacity: n.CPUCapacity, Allocatable: n.CPUAllocatable, Percent: n.CPUPercent},
			MemoryUsage: &kubernetes.NodeUsage{Used: n.MemUsed, Capacity: n.MemCapacity, Allocatable: n.MemAllocatable, Percent: n.MemPercent},
			GPUCapacity: n.GPUCapacity, GPUAllocated: n.GPUAllocated, GPUModel: n.GPUModel, GPUMemTotalMiB: n.GPUMemTotalMiB,
			GPUMemAllocatedMiB: n.GPUMemAllocatedMiB, GPUPods: n.GPUPods, HamiDetected: n.HamiDetected,
		})
	}
	return out
}

func sortedNames(m map[string]placementhistory.Node) []string {
	names := make([]string, 0, len(m))
	for k := range m {
		names = append(names, k)
	}
	sort.Strings(names)
	return names
}

// sortTopologyPods orders pods by largest CPU request, then name, so a
// replay lists them like the live endpoint and stays stable.
func sortTopologyPods(pods []TopologyPod) {
	sort.Slice(pods, func(i, j int) bool {
		if pods[i].Requests.CPUCores != pods[j].Requests.CPUCores {
			return pods[i].Requests.CPUCores > pods[j].Requests.CPUCores
		}
		return pods[i].Namespace+"/"+pods[i].Name < pods[j].Namespace+"/"+pods[j].Name
	})
}

// parseHistoryTime accepts Unix seconds or RFC3339.
func parseHistoryTime(v string) (time.Time, bool) {
	if v == "" {
		return time.Time{}, false
	}
	if secs, err := strconv.ParseInt(v, 10, 64); err == nil {
		return time.Unix(secs, 0), true
	}
	if t, err := time.Parse(time.RFC3339, v); err == nil {
		return t, true
	}
	return time.Time{}, false
}

func (s *Server) placementRange() gin.H {
	first, last, n := s.placementHistory.Range()
	h := gin.H{"samples": n, "intervalSeconds": int(s.placementInterval.Seconds()), "retentionHours": int(s.placementWindow.Hours())}
	if n > 0 {
		h["from"] = first.Unix()
		h["to"] = last.Unix()
	}
	return h
}

// getTopologyHistory godoc
// @Summary      Topology at a past moment
// @Description  Nodes and pods as they were at the latest placement sample at or before `at` (Unix seconds or RFC3339). Same node shape as /topology; cost uses today's prices; no usage. Kept in memory, and restored from Postgres after a restart when a database is configured.
// @Tags         nodes
// @Produce      json
// @Param        at  query  string  true  "Unix seconds or RFC3339"
// @Success      200  {object}  map[string]interface{}
// @Failure      400  {object}  map[string]interface{}
// @Failure      404  {object}  map[string]interface{}  "No sample at or before that time"
// @Failure      503  {object}  map[string]interface{}  "Placement history disabled"
// @Router       /topology/history [get]
func (s *Server) getTopologyHistory(c *gin.Context) {
	if s.placementHistory == nil {
		c.JSON(503, gin.H{"error": "placement history is disabled (PLACEMENT_HISTORY_HOURS=0 or no Kubernetes client)"})
		return
	}
	at, ok := parseHistoryTime(c.Query("at"))
	if !ok {
		c.JSON(400, gin.H{"error": "at must be Unix seconds or RFC3339"})
		return
	}
	// The URL has second resolution and samples do not: count the whole second.
	snap, found := s.placementHistory.At(at.Truncate(time.Second).Add(time.Second - time.Nanosecond))
	if !found {
		c.JSON(404, gin.H{"error": "no placement sample at or before that time", "history": s.placementRange()})
		return
	}
	nodes := topologyFromSnapshot(snap)
	if price := s.instancePricer(c.Request.Context()); price != nil {
		attachTopologyCost(nodes, price)
	}
	c.JSON(200, gin.H{
		"currency": awspricing.PricingCurrencyForRegion(s.config.AWSRegion),
		"nodes":    nodes,
		"count":    len(nodes),
		"at":       snap.At.Unix(),
		"usage":    nil,
		"gpuUsage": nil,
		"history":  s.placementRange(),
	})
}

// getTopologyEvents godoc
// @Summary      Node launches, terminations and pod moves
// @Description  Changes between consecutive placement samples: node-added, node-removed (with the last Karpenter disruption reason seen and its pod count) and pod-moved (same pod name on another node).
// @Tags         nodes
// @Produce      json
// @Param        since  query  string  false  "Window, e.g. 6h (default: the whole history)"
// @Success      200  {object}  map[string]interface{}
// @Failure      503  {object}  map[string]interface{}  "Placement history disabled"
// @Router       /topology/events [get]
func (s *Server) getTopologyEvents(c *gin.Context) {
	if s.placementHistory == nil {
		c.JSON(503, gin.H{"error": "placement history is disabled (PLACEMENT_HISTORY_HOURS=0 or no Kubernetes client)"})
		return
	}
	since := time.Time{}
	if v := c.Query("since"); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil || d <= 0 {
			c.JSON(400, gin.H{"error": "since must be a duration such as 6h"})
			return
		}
		since = time.Now().Add(-d)
	}
	events := s.placementHistory.Events(since)
	if events == nil {
		events = []placementhistory.Event{}
	}
	c.JSON(200, gin.H{"history": s.placementRange(), "events": events})
}
