import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import TopologyView from './TopologyView';
import { topologyNodes } from '../../test/fixtures';

vi.mock('axios', () => ({ default: { get: vi.fn() } }));

const NOW = Math.floor(Date.now() / 1000);
const FROM = NOW - 6 * 3600;
const iso = (secs) => new Date(secs * 1000).toISOString();

// An hour ago a third node ran a pod that has since moved; it was removed for
// being underutilized.
const oldNode = {
  ...topologyNodes[0],
  name: 'ip-10-0-9-9',
  zone: 'eu-west-1c',
  pods: [{ namespace: 'llm', name: 'llama-70b-r3', workloadType: 'Deployment', requests: { cpuCores: 8, memoryGiB: 64, gpu: 1, gpuMemMiB: 46000 }, gpuDevices: [] }],
};
const pastNodes = [{ ...topologyNodes[0], pods: topologyNodes[0].pods.filter((p) => p.name !== 'llama-70b-r3') }, topologyNodes[1], oldNode];
const EVENTS = {
  history: { samples: 180, from: FROM, to: NOW, intervalSeconds: 120, retentionHours: 24 },
  events: [
    { type: 'node-removed', at: iso(NOW - 1800), node: 'ip-10-0-9-9', nodePool: 'gpu-l40s', reason: 'Underutilized', pods: 1 },
    { type: 'pod-moved', at: iso(NOW - 1800), pod: 'llm/llama-70b-r3', from: 'ip-10-0-9-9', to: 'ip-10-0-4-12' },
  ],
};

function route({ events = EVENTS } = {}) {
  axios.get.mockImplementation((url, opts) => {
    const path = url.replace(/^.*?(\/api\/)/, '$1');
    if (path === '/api/v1/topology') return Promise.resolve({ data: { nodes: topologyNodes, currency: 'USD', usage: { source: 'metrics-server', window: 'live' } } });
    if (path === '/api/v1/topology/events') return events instanceof Error ? Promise.reject(events) : Promise.resolve({ data: events });
    if (path === '/api/v1/topology/history') return Promise.resolve({ data: { at: opts.params.at, nodes: pastNodes, history: EVENTS.history } });
    return Promise.resolve({ data: {} });
  });
}

const setUrl = (search) => window.history.replaceState(null, '', `/${search}`);
const params = () => Object.fromEntries(new URLSearchParams(window.location.search));

describe('Topology time travel', () => {
  beforeEach(() => {
    route();
    setUrl('?tab=topology');
  });
  afterEach(() => vi.clearAllMocks());

  test('History opens a timeline with Karpenter changes marked on it', async () => {
    render(<TopologyView />);
    await userEvent.click(await screen.findByRole('button', { name: 'History' }));
    const panel = await screen.findByRole('region', { name: 'Time travel' });
    expect(within(panel).getByText(/Live. Pick a moment/)).toBeInTheDocument();
    const marker = await within(panel).findByRole('button', { name: /0 launched, 1 removed, 1 moved/ });
    expect(marker).toHaveClass('bg-red-500');
    expect(marker.getAttribute('title')).toContain('ip-10-0-9-9 removed: Underutilized · 1 pod in gpu-l40s');

    // Clicking a marker replays that moment.
    await userEvent.click(marker);
    expect(params().at).toBe(String(NOW - 1800));
    expect(await screen.findByRole('button', { name: /ip-10-0-9-9: / })).toBeInTheDocument();
    expect(screen.getByText(/Replaying the cluster at/)).toBeInTheDocument();
    // No usage in the past: the Usage lens and caption fall back.
    expect(screen.getByText(/bars show requests only/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Back to live/ }));
    expect(params().at).toBeUndefined();
    expect(screen.queryByRole('button', { name: /ip-10-0-9-9: / })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Close time travel' }));
    expect(screen.queryByRole('region', { name: 'Time travel' })).not.toBeInTheDocument();
  });

  test('Compare keeps the live view, lists the changes and draws removed nodes as ghosts', async () => {
    render(<TopologyView />);
    await userEvent.click(await screen.findByRole('button', { name: 'History' }));
    const panel = await screen.findByRole('region', { name: 'Time travel' });
    await within(panel).findByRole('slider');
    await userEvent.click(within(panel).getByRole('button', { name: 'Compare with now' }));
    expect(params().compare).toBe(String(NOW - 3600));

    const changes = await screen.findByRole('region', { name: 'Changes since' });
    expect(changes).toHaveTextContent('−1 node · 1 pod moved');
    expect(changes).toHaveTextContent('Removed (Underutilized ×1): ip-10-0-9-9');
    expect(screen.getByRole('button', { name: 'ip-10-0-9-9: removed since then' })).toHaveClass('border-dashed');
    expect(screen.getByRole('button', { name: /gpu-l40s\s*2 nodes, 1 removed/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ip-10-0-4-12: 50%' })).toBeInTheDocument();
    expect(within(changes).getByText('llm/llama-70b-r3: ip-10-0-9-9 → ip-10-0-4-12')).toBeInTheDocument();

    // The slider moves the compare point; Replay switches mode at the same time.
    fireEvent.change(within(panel).getByRole('slider', { name: 'Compare with' }), { target: { value: String(FROM + 120) } });
    expect(params().compare).toBe(String(FROM + 120));
    await userEvent.click(within(panel).getByRole('button', { name: 'Replay' }));
    expect(params()).toEqual(expect.objectContaining({ at: String(FROM + 120) }));
    expect(screen.getByRole('slider', { name: 'Replay time' })).toBeInTheDocument();
  });

  test('a shared ?compare= link opens with the diff; a launched node gets a ring', async () => {
    axios.get.mockImplementation((url, opts) => {
      const path = url.replace(/^.*?(\/api\/)/, '$1');
      if (path === '/api/v1/topology') return Promise.resolve({ data: { nodes: topologyNodes } });
      if (path === '/api/v1/topology/events') return Promise.resolve({ data: EVENTS });
      return Promise.resolve({ data: { at: opts.params.at, nodes: [topologyNodes[0]] } });
    });
    setUrl(`?tab=topology&compare=${NOW - 600}`);
    render(<TopologyView />);
    const changes = await screen.findByRole('region', { name: 'Changes since' });
    expect(changes).toHaveTextContent('+1 node');
    expect(screen.getByRole('button', { name: 'ip-10-0-7-88: 53% (launched since then)' })).toHaveClass('ring-emerald-500');
    await userEvent.click(within(changes).getByRole('button', { name: 'ip-10-0-7-88' }));
    expect(params().zoom).toBe('node');
  });

  test('explains a backend without history and a history that is just starting', async () => {
    route({ events: Object.assign(new Error('nf'), { response: { status: 404 } }) });
    const { unmount } = render(<TopologyView />);
    await userEvent.click(await screen.findByRole('button', { name: 'History' }));
    expect(await screen.findByText(/keeps no placement history/)).toBeInTheDocument();
    unmount();

    route({ events: { history: { samples: 1, intervalSeconds: 120 }, events: [] } });
    render(<TopologyView />);
    await userEvent.click(await screen.findByRole('button', { name: 'History' }));
    expect(await screen.findByText(/one sample every 2 min/)).toBeInTheDocument();
  });

  test('shows a timeline error', async () => {
    route({ events: Object.assign(new Error('boom'), { response: { status: 500, data: { error: 'kaput' } } }) });
    render(<TopologyView />);
    await userEvent.click(await screen.findByRole('button', { name: 'History' }));
    expect(await screen.findByText('kaput')).toBeInTheDocument();
  });
});
