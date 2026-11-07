import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, within, fireEvent } from '@testing-library/react';
import axios from 'axios';
import TopologyView from './TopologyView';
import { podUsedShare } from './NodePodBar';
import { topologyNodes, GPU } from '../../test/fixtures';

vi.mock('axios', () => ({ default: { get: vi.fn() } }));

// Usage for the llama replicas: r1 uses a quarter of its CPU request.
const withUsage = topologyNodes.map((n) => ({
  ...n,
  pods: n.pods.map((p) =>
    p.namespace === 'llm' ? { ...p, usage: { cpuCores: p.requests.cpuCores / 4, memoryGiB: p.requests.memoryGiB / 2 } } : p,
  ),
}));
// Two replicas of one API, both on ip-10-0-4-12: a single-node risk.
withUsage[0] = {
  ...withUsage[0],
  pods: [
    ...withUsage[0].pods,
    { namespace: 'prod', name: 'api-a', workloadName: 'api', workloadType: 'Deployment', requests: { cpuCores: 1, memoryGiB: 1 } },
    { namespace: 'prod', name: 'api-b', workloadName: 'api', workloadType: 'Deployment', requests: { cpuCores: 1, memoryGiB: 1 } },
  ],
};

let topology;
function setUrl(search) {
  window.history.replaceState(null, '', `/${search}`);
}

describe('Topology usage, blast radius and node actions', () => {
  beforeEach(() => {
    topology = {
      nodes: withUsage,
      currency: 'USD',
      usage: { source: 'prometheus', window: 'p95 over 24h' },
      gpuUsage: { [GPU.c.uuid]: 20000 },
    };
    axios.get.mockImplementation(() => Promise.resolve({ data: topology }));
    setUrl('?tab=topology');
  });
  afterEach(() => vi.clearAllMocks());

  test('with a usage source: Usage lens, source note, hatched idle requests and the DCGM line', async () => {
    render(<TopologyView />);
    expect(await screen.findByText(/Usage: p95 over 24h from Prometheus/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Usage' }));
    expect(screen.getByRole('button', { name: 'ip-10-0-4-12: 25%' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'ip-10-0-7-88: 25%' }));
    // CPU bar: llama-70b-r2 uses 25% of its request; the rest is hatched.
    expect(document.querySelector('[data-used="25"]')).not.toBeNull();
    expect(screen.getByTestId('gpu-used-line')).toBeInTheDocument();
  });

  test('without a source: no Usage lens, a note says so, and ?lens=usage falls back to requests', async () => {
    topology = { nodes: topologyNodes, currency: 'USD', usage: null, gpuUsage: null };
    setUrl('?tab=topology&lens=usage');
    render(<TopologyView />);
    expect(await screen.findByText(/no metrics-server or Prometheus found/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Usage' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ip-10-0-4-12: 50%' })).toBeInTheDocument();
  });

  test('metrics-server is named as live', async () => {
    topology = { ...topology, usage: { source: 'metrics-server', window: 'live' } };
    render(<TopologyView />);
    expect(await screen.findByText(/Usage: live from metrics-server/)).toBeInTheDocument();
  });

  test('blast radius: counted at the Cluster level, named on the node', async () => {
    render(<TopologyView />);
    const summary = await screen.findByText('1 workload has every replica in one place');
    fireEvent.click(summary);
    fireEvent.click(screen.getByRole('button', { name: 'ip-10-0-4-12' }));
    expect(await screen.findByText(/Every replica of prod\/api \(2\) runs on this node/)).toBeInTheDocument();
  });

  test('node actions: copy a kubectl command, open logs, open disruption status', async () => {
    const onOpenLogs = vi.fn();
    const onOpenDisruptions = vi.fn();
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    setUrl('?tab=topology&zoom=node&at=ip-10-0-7-88');
    render(<TopologyView onOpenLogs={onOpenLogs} onOpenDisruptions={onOpenDisruptions} />);

    fireEvent.click(await screen.findByLabelText('Actions for ip-10-0-7-88'));
    fireEvent.click(screen.getByText('kubectl drain ip-10-0-7-88 --ignore-daemonsets --delete-emptydir-data --dry-run=client'));
    expect(writeText).toHaveBeenCalledWith('kubectl drain ip-10-0-7-88 --ignore-daemonsets --delete-emptydir-data --dry-run=client');
    expect(await screen.findByText('Copied')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open logs for batch/embed-worker-7f9c' }));
    expect(onOpenLogs).toHaveBeenCalledWith(expect.objectContaining({ name: 'embed-worker-7f9c' }));
    fireEvent.click(screen.getByRole('button', { name: /Disruption status/ }));
    expect(onOpenDisruptions).toHaveBeenCalledWith(expect.objectContaining({ name: 'ip-10-0-7-88' }));
    // The DaemonSet agent is last in the logs list.
    const logButtons = screen.getAllByRole('button', { name: /^Open logs for / }).map((b) => b.getAttribute('aria-label'));
    expect(logButtons.at(-1)).toBe('Open logs for kube-system/node-exporter-x2');
    expect(within(screen.getByLabelText('Actions for ip-10-0-7-88').closest('details')).getByText('Copy')).toBeInTheDocument();
  });
});

test('podUsedShare: per metric, null without usage or request', () => {
  const pod = { requests: { cpuCores: 2, memoryGiB: 4 }, usage: { cpuCores: 1, memoryGiB: 5 } };
  expect(podUsedShare(pod, 'cpu')).toBe(0.5);
  expect(podUsedShare(pod, 'memory')).toBe(1.25);
  expect(podUsedShare(pod, 'gpu')).toBeNull();
  expect(podUsedShare({ requests: { cpuCores: 1 } }, 'cpu')).toBeNull();
  expect(podUsedShare({ requests: {}, usage: { cpuCores: 1 } }, 'cpu')).toBeNull();
  expect(podUsedShare({ requests: { cpuCores: 1 }, usage: {} }, 'cpu')).toBe(0);
});
