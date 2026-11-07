package api

import (
	"context"
	"strconv"

	"github.com/karpenter-optimizer/internal/kubernetes"
	"github.com/karpenter-optimizer/internal/llmhealth"
)

// GPU co-location for serving pods: which other pods share each serving pod's
// physical GPU. A replica that is slower than its peers and shares its GPU
// with a batch job is the classic noisy-neighbour case, and the cheapest fix
// is usually to move the neighbour.
//
// This mirrors frontend/src/lib/servingPlacement.js (findGpuNeighbours), which
// the Topology view still uses on topology data; keep the two in step.

// attachGPUNeighbours fills GPUNeighbours on each serving pod. It lists pods
// only on the nodes that host serving pods (one paginated list). On error it
// leaves the field nil, so the UI shows no neighbour information rather than
// a wrong "alone".
func (s *Server) attachGPUNeighbours(ctx context.Context, health []llmhealth.PodHealth) {
	nodes := make(map[string]bool)
	for _, h := range health {
		if h.Node != "" {
			nodes[h.Node] = true
		}
	}
	if len(nodes) == 0 {
		return
	}

	pods, err := s.k8sClient.GetPodsOnNodes(ctx, nodes)
	if err != nil {
		debugLog(s.config.Debug, "[serving] failed to list pods for GPU neighbours: %v\n", err)
		return
	}
	byNode := make(map[string][]kubernetes.PodInfo, len(nodes))
	for _, p := range pods {
		byNode[p.NodeName] = append(byNode[p.NodeName], p)
	}

	for i := range health {
		if health[i].Node == "" {
			continue
		}
		health[i].GPUNeighbours, health[i].GPUNeighboursPrecise = gpuNeighboursFor(health[i], byNode[health[i].Node])
	}
}

// gpuNeighboursFor returns the GPUs the serving pod shares and with whom.
//
// With HAMi placement (device UUIDs on the serving pod or its PodInfo), pods
// are matched by physical GPU: precise. Without placement, GPUs are normally
// exclusive, so other GPU pods on the node are not reported, except on a
// single-GPU node, where two GPU pods can only coexist by time-slicing it.
// The result is never nil: an empty slice means "alone".
func gpuNeighboursFor(h llmhealth.PodHealth, nodePods []kubernetes.PodInfo) ([]llmhealth.GPUShare, bool) {
	self := h.Namespace + "/" + h.Name

	var others []kubernetes.PodInfo
	var selfDevices []kubernetes.GPUDevice
	for _, p := range nodePods {
		if p.Namespace+"/"+p.Name == self {
			selfDevices = p.GPUDevices
			continue
		}
		if isGPUPod(p) {
			others = append(others, p)
		}
	}

	type device struct {
		uuid  string
		index int
	}
	var mine []device
	for _, d := range h.GPUDevices {
		mine = append(mine, device{d.UUID, d.Index})
	}
	if len(mine) == 0 {
		for _, d := range selfDevices {
			mine = append(mine, device{d.UUID, d.Index})
		}
	}

	shares := []llmhealth.GPUShare{}

	if len(mine) > 0 {
		for _, d := range mine {
			key := gpuKey(d.uuid, d.index)
			share := llmhealth.GPUShare{UUID: d.uuid, Index: d.index, Pods: []llmhealth.NeighbourPod{}}
			for _, o := range others {
				for _, od := range o.GPUDevices {
					if gpuKey(od.UUID, od.Index) == key {
						share.Pods = append(share.Pods, llmhealth.NeighbourPod{
							Namespace: o.Namespace,
							Name:      o.Name,
							MemoryMiB: od.MemoryMiB,
						})
					}
				}
			}
			if len(share.Pods) > 0 {
				shares = append(shares, share)
			}
		}
		return shares, true
	}

	if h.GPUCapacity == 1 && len(others) > 0 {
		share := llmhealth.GPUShare{Index: 0, Pods: make([]llmhealth.NeighbourPod, 0, len(others))}
		for _, o := range others {
			share.Pods = append(share.Pods, llmhealth.NeighbourPod{
				Namespace: o.Namespace,
				Name:      o.Name,
				MemoryMiB: int(o.GPUMemRequestMiB),
			})
		}
		return append(shares, share), false
	}

	return shares, false
}

// gpuKey identifies a physical GPU. HAMi's allocated index is unreliable (two
// cards can both report index 0), so the UUID wins; the index is a fallback.
func gpuKey(uuid string, index int) string {
	if uuid != "" {
		return uuid
	}
	return "idx-" + strconv.Itoa(index)
}

func isGPUPod(p kubernetes.PodInfo) bool {
	return p.GPURequested > 0 || p.GPUMemRequestMiB > 0 || len(p.GPUDevices) > 0
}
