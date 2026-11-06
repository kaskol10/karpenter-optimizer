

export function getPodKey(pod) {
  return `${pod.namespace}/${pod.name}`;
}

// formatNodeAge renders a human-friendly age from an RFC3339 creation time
// (e.g. "age 3d" / "age 5h" / "age 12m"). Returns '' when unknown.
export function formatNodeAge(creationTime) {
  if (!creationTime) return '';
  const created = new Date(creationTime).getTime();
  if (Number.isNaN(created)) return '';
  const secs = Math.max(0, (Date.now() - created) / 1000);
  if (secs < 90) return 'age now';
  if (secs < 5400) return `age ${Math.round(secs / 60)}m`;
  if (secs < 172800) return `age ${Math.round(secs / 3600)}h`;
  return `age ${Math.round(secs / 86400)}d`;
}

export function hashToHue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i += 1) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 360;
}

export function getMetricFields(metric, node) {
  if (metric === 'memory') {
    return {
      weight: (pod) => pod.requests?.memoryGiB || 0,
      format: (v) => `${v.toFixed(2)} GiB`,
      label: 'Memory',
    };
  }
  if (metric === 'gpu' && node) {
    const memKnown = (node.gpuMemTotalMiB || 0) > 0;
    const perGpuMiB =
      memKnown && (node.gpuCapacity || 0) > 0 ? node.gpuMemTotalMiB / node.gpuCapacity : 0;
    return {
      // Memory-based (HAMi) when node GPU memory is known; count-based otherwise.
      // Whole-GPU pods without an explicit gpumem value are estimated from the
      // node's per-GPU memory so they stay visible in memory-based mode.
      weight: (pod) => {
        if (!memKnown) return pod.requests?.gpu || 0;
        if ((pod.requests?.gpuMemMiB || 0) > 0) return pod.requests.gpuMemMiB;
        return (pod.requests?.gpu || 0) * perGpuMiB;
      },
      format: (v) => (memKnown ? `${(v / 1024).toFixed(1)} GiB` : `${v} GPU`),
      label: 'GPU',
    };
  }
  return {
    weight: (pod) => pod.requests?.cpuCores || 0,
    format: (v) => `${v.toFixed(3)} cores`,
    label: 'CPU',
  };
}

export function isDaemonSetPod(pod) {
  return (pod.workloadType || '').toLowerCase() === 'daemonset';
}

// hasDevicePlacement reports whether the node should render per-physical-GPU
// lanes: HAMi-detected, per-GPU memory known, multi-GPU node, and at least one
// of the given pods carries a hami.io/vgpu-devices-allocated annotation.
export function hasDevicePlacement(node, pods) {
  return (
    !!node.hamiDetected &&
    (node.gpuMemTotalMiB || 0) > 0 &&
    (node.gpuCapacity || 0) > 1 &&
    pods.some((p) => (p.gpuDevices || []).length > 0)
  );
}
