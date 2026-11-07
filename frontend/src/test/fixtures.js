// Shared test fixtures: a small GPU cluster with a noisy neighbour.
//
// Two L40S nodes with HAMi placement. llama-70b runs three replicas; r2 shares
// its GPU (c3c3c3c3) with a batch embedding job and is 3x slower than its
// peers. qwen3-8b is healthy but shares its GPU with a reranker.

export const GPU = {
  a: { uuid: 'GPU-a1a1a1a1-0000-0000-0000-000000000000', index: 0, memoryMiB: 46000, model: 'NVIDIA-L40S' },
  b: { uuid: 'GPU-b2b2b2b2-0000-0000-0000-000000000000', index: 1, memoryMiB: 46000, model: 'NVIDIA-L40S' },
  c: { uuid: 'GPU-c3c3c3c3-0000-0000-0000-000000000000', index: 0, memoryMiB: 30000, model: 'NVIDIA-L40S' },
  d: { uuid: 'GPU-d4d4d4d4-0000-0000-0000-000000000000', index: 1, memoryMiB: 16000, model: 'NVIDIA-L40S' },
};

function topologyPod(namespace, name, requests, gpuDevices = [], workloadType = 'Deployment') {
  return {
    namespace,
    name,
    workloadType,
    workloadName: name.replace(/-[^-]+$/, ''),
    requests: { cpuCores: 0, memoryGiB: 0, gpu: 0, gpuMemMiB: 0, ...requests },
    gpuDevices,
  };
}

function gpuNode(name, extra, pods) {
  return {
    name,
    nodePool: 'gpu-l40s',
    instanceType: 'g6e.12xlarge',
    creationTime: '2026-11-03T10:00:00Z',
    cpuUsage: { allocatable: 47 },
    memoryUsage: { allocatable: 370 },
    gpuCapacity: 4,
    gpuMemTotalMiB: 184000,
    gpuModel: 'L40S',
    hamiDetected: true,
    ...extra,
    pods,
  };
}

export const topologyNodes = [
  gpuNode('ip-10-0-4-12', { zone: 'eu-west-1a', capacityType: 'spot', gpuAllocated: 2, gpuMemAllocatedMiB: 92000, gpuPods: 2 }, [
    topologyPod('llm', 'llama-70b-r1', { cpuCores: 8, memoryGiB: 64, gpu: 1, gpuMemMiB: 46000 }, [GPU.a]),
    topologyPod('llm', 'llama-70b-r3', { cpuCores: 8, memoryGiB: 64, gpu: 1, gpuMemMiB: 46000 }, [GPU.b]),
    topologyPod('kube-system', 'node-exporter-x1', { cpuCores: 0.1, memoryGiB: 0.2 }, [], 'DaemonSet'),
  ]),
  gpuNode('ip-10-0-7-88', { zone: 'eu-west-1b', capacityType: 'on-demand', gpuAllocated: 3, gpuMemAllocatedMiB: 98000, gpuPods: 4 }, [
    topologyPod('llm', 'llama-70b-r2', { cpuCores: 8, memoryGiB: 64, gpu: 1, gpuMemMiB: 30000 }, [GPU.c]),
    topologyPod('batch', 'embed-worker-7f9c', { cpuCores: 4, memoryGiB: 16, gpu: 1, gpuMemMiB: 14000 }, [{ ...GPU.c, memoryMiB: 14000 }]),
    topologyPod('llm', 'qwen3-8b-0', { cpuCores: 4, memoryGiB: 24, gpu: 1, gpuMemMiB: 16000 }, [GPU.d]),
    topologyPod('search', 'reranker-5d2a', { cpuCores: 2, memoryGiB: 8, gpu: 1, gpuMemMiB: 12000 }, [{ ...GPU.d, memoryMiB: 12000 }]),
    topologyPod('kube-system', 'node-exporter-x2', { cpuCores: 0.1, memoryGiB: 0.2 }, [], 'DaemonSet'),
  ]),
];

function servingPod(name, model, node, gpuDevices, metrics = {}) {
  return {
    namespace: 'llm',
    name,
    model,
    backend: 'vllm',
    online: true,
    node,
    nodeInstanceType: 'g6e.12xlarge',
    gpuModel: 'L40S',
    gpuCapacity: 4,
    gpuDevices,
    running: 4,
    waiting: 0,
    preemptions: 0,
    kvCachePercent: 48,
    ttftSeconds: 0.21,
    ttftP95Seconds: 0.4,
    e2eSeconds: 1.8,
    e2eP95Seconds: 2.1,
    tokensPerSec: 710,
    requestsPerSec: 1.4,
    ...metrics,
  };
}

const LLAMA = 'meta-llama/Llama-3.3-70B';

// gpuNeighbours as /api/v1/serving returns them (computed server-side from the
// same placement as topologyNodes above).
const alone = { gpuNeighbours: [], gpuNeighboursPrecise: true };
function sharing(device, pods) {
  return {
    gpuNeighbours: [{ uuid: device.uuid, index: device.index, pods }],
    gpuNeighboursPrecise: true,
  };
}

export const servingPods = {
  r1: servingPod('llama-70b-r1', LLAMA, 'ip-10-0-4-12', [GPU.a], alone),
  r2: servingPod('llama-70b-r2', LLAMA, 'ip-10-0-7-88', [GPU.c], {
    e2eSeconds: 5.1,
    e2eP95Seconds: 6.8,
    ttftP95Seconds: 1.9,
    kvCachePercent: 71,
    tokensPerSec: 260,
    requestsPerSec: 0.6,
    ...sharing(GPU.c, [{ namespace: 'batch', name: 'embed-worker-7f9c', memoryMiB: 14000 }]),
  }),
  r3: servingPod('llama-70b-r3', LLAMA, 'ip-10-0-4-12', [GPU.b], { e2eP95Seconds: 2.4, ...alone }),
  qwen: servingPod('qwen3-8b-0', 'Qwen/Qwen3-8B', 'ip-10-0-7-88', [GPU.d], {
    e2eP95Seconds: 0.9,
    tokensPerSec: 1980,
    kvCachePercent: 31,
    ...sharing(GPU.d, [{ namespace: 'search', name: 'reranker-5d2a', memoryMiB: 12000 }]),
  }),
  offline: servingPod('mistral-0', 'mistralai/Mistral-7B', 'ip-10-0-4-12', [], {
    online: false,
    error: 'connection refused',
    gpuNeighbours: null,
  }),
};

export const allServingPods = [servingPods.r1, servingPods.r2, servingPods.r3, servingPods.qwen];
