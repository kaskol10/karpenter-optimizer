// GPU placement helpers shared by the Serving and Topology tabs.
//
// The question they answer: "who else is on this serving pod's GPU?" — the
// classic noisy-neighbour cause of one replica being slower than its peers.
// Kept free of React so it can be unit-tested.

import { shortGpuUuid } from './utils';

// gpuKey is the stable identity of a physical GPU. HAMi's allocated index is
// unreliable (two cards can both report index 0), so the UUID wins; the index
// is only a fallback when no UUID is present.
export function gpuKey(device) {
  if (!device) return '';
  return device.uuid || `idx-${device.index ?? 0}`;
}

export function gpuLabel(device) {
  if (!device) return '';
  return shortGpuUuid(device.uuid) || `GPU ${device.index ?? 0}`;
}

export function podKey(pod) {
  return `${pod.namespace}/${pod.name}`;
}

function isGpuPod(pod) {
  return (
    (pod.requests?.gpu || 0) > 0 ||
    (pod.requests?.gpuMemMiB || 0) > 0 ||
    (pod.gpuDevices || []).length > 0
  );
}

// findGpuNeighbours locates a serving pod on the topology and returns the
// other pods sharing its GPU(s):
//
//   {
//     node: 'ip-10-0-7-88',
//     precise: true,          // device-level placement known (HAMi)
//     shared: [{ gpu: { key, label, uuid, index }, neighbours: [{ pod, memMiB }] }],
//     unplaced: [pod],        // other GPU pods on the node with no placement info
//   }
//
// Returns null when the pod or its node isn't in the topology.
//
// Without device placement (plain NVIDIA device plugin), GPUs are normally
// exclusive, so other GPU pods on the node are *not* reported as sharing —
// except on a single-GPU node, where two GPU pods can only coexist by
// time-slicing the same card.
export function findGpuNeighbours(servingPod, nodes) {
  if (!servingPod || !servingPod.node || !Array.isArray(nodes)) return null;
  const node = nodes.find((n) => n.name === servingPod.node);
  if (!node) return null;

  const me = podKey(servingPod);
  const pods = node.pods || [];
  const self = pods.find((p) => podKey(p) === me);
  const myDevices =
    (servingPod.gpuDevices || []).length > 0 ? servingPod.gpuDevices : self?.gpuDevices || [];
  const others = pods.filter((p) => podKey(p) !== me && isGpuPod(p));

  if (myDevices.length > 0) {
    const shared = myDevices
      .map((d) => {
        const key = gpuKey(d);
        const neighbours = [];
        others.forEach((p) => {
          (p.gpuDevices || []).forEach((od) => {
            if (gpuKey(od) === key) neighbours.push({ pod: p, memMiB: od.memoryMiB || 0 });
          });
        });
        return {
          gpu: { key, label: gpuLabel(d), uuid: d.uuid || '', index: d.index ?? 0 },
          neighbours,
        };
      })
      .filter((s) => s.neighbours.length > 0);
    const unplaced = others.filter((p) => (p.gpuDevices || []).length === 0);
    return { node: node.name, precise: true, shared, unplaced };
  }

  if (Math.round(node.gpuCapacity || 0) === 1 && others.length > 0) {
    return {
      node: node.name,
      precise: false,
      shared: [
        {
          gpu: { key: 'idx-0', label: 'GPU 0', uuid: '', index: 0 },
          neighbours: others.map((p) => ({ pod: p, memMiB: p.requests?.gpuMemMiB || 0 })),
        },
      ],
      unplaced: [],
    };
  }

  return { node: node.name, precise: false, shared: [], unplaced: others };
}

// placementFromServing reads the GPU neighbours that /api/v1/serving computes
// server-side (gpuNeighbours, gpuNeighboursPrecise) into the same shape as
// findGpuNeighbours, so the Serving tab needs no topology download. Returns
// null when the backend did not compute them (null/absent: unknown, as
// opposed to [] which means alone).
export function placementFromServing(servingPod) {
  if (!servingPod || !Array.isArray(servingPod.gpuNeighbours)) return null;
  return {
    node: servingPod.node || '',
    precise: !!servingPod.gpuNeighboursPrecise,
    shared: servingPod.gpuNeighbours.map((share) => {
      const device = { uuid: share.uuid || '', index: share.index ?? 0 };
      return {
        gpu: { key: gpuKey(device), label: gpuLabel(device), uuid: device.uuid, index: device.index },
        neighbours: (share.pods || []).map((p) => ({
          pod: { namespace: p.namespace, name: p.name },
          memMiB: p.memoryMiB || 0,
        })),
      };
    }),
    unplaced: [],
  };
}

// neighbourPods flattens a placement into the unique neighbour pods.
export function neighbourPods(placement) {
  if (!placement) return [];
  const seen = new Map();
  placement.shared.forEach((s) =>
    s.neighbours.forEach(({ pod }) => {
      if (!seen.has(podKey(pod))) seen.set(podKey(pod), pod);
    }),
  );
  return [...seen.values()];
}

// describeNeighbours renders a placement as a one-line reason, e.g.
// "shares GPU b3d6e634 with batch/embed-7f9c (+1 more)". null when alone.
export function describeNeighbours(placement, maxNames = 2) {
  const pods = neighbourPods(placement);
  if (pods.length === 0) return null;
  const gpus = placement.shared.map((s) => s.gpu.label);
  const names = pods.slice(0, maxNames).map(podKey).join(', ');
  const more = pods.length > maxNames ? ` (+${pods.length - maxNames} more)` : '';
  const gpuText = gpus.length === 1 ? gpus[0] : `GPUs ${gpus.join(', ')}`;
  return {
    text: `shares ${gpuText} with ${names}${more}`,
    gpuText,
    count: pods.length,
  };
}

// topologyFocusFor builds the Topology deep link for a serving pod: its node,
// itself, and the GPU worth looking at (the first shared one, else its first
// card). null when the pod has no node (offline / not scheduled).
export function topologyFocusFor(pod, placement) {
  if (!pod.node) return null;
  return {
    node: pod.node,
    pod: podKey(pod),
    gpu: placement?.shared?.[0]?.gpu?.key || (pod.gpuDevices?.[0]?.uuid ?? ''),
  };
}
