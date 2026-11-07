import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, within, fireEvent, act } from '@testing-library/react';
import axios from 'axios';
import TopologyView from './TopologyView';
import { topologyNodes, allServingPods, GPU } from '../../test/fixtures';

vi.mock('axios', () => ({ default: { get: vi.fn() } }));

const nodes = topologyNodes.map((n, i) => ({ ...n, costPerHour: i === 0 ? 2.62 : 10.49, pricedAs: n.capacityType }));
const RESPONSES = {
  '/api/v1/topology': { nodes, currency: 'USD' },
  '/api/v1/serving': { pods: allServingPods },
  '/api/v1/disruptions': { disruptions: [{ nodeName: 'ip-10-0-7-88', reason: 'drift', isBlocked: true, blockingReason: 'PDB' }] },
};

function setUrl(search) {
  window.history.replaceState(null, '', `/${search}`);
}

const zoomParams = () => Object.fromEntries(new URLSearchParams(window.location.search));

describe('Topology semantic zoom and lenses', () => {
  beforeEach(() => {
    axios.get.mockImplementation((url) => Promise.resolve({ data: RESPONSES[url.replace(/^.*?(\/api\/)/, '$1')] ?? {} }));
    setUrl('?tab=topology');
  });
  afterEach(() => vi.clearAllMocks());

  test('opens on the Cluster level: one tile per node, coloured by requests, with a legend', async () => {
    render(<TopologyView />);
    expect(await screen.findByRole('button', { name: 'ip-10-0-4-12: 50%' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ip-10-0-7-88: 53%' })).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Legend' })).getByText('≥ 95% requested')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Zoom level' })).toHaveTextContent('Cluster');
    // No node cards and no lens data fetched at this level.
    expect(screen.queryByText('Drill into node')).not.toBeInTheDocument();
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  test('lenses recolour the tiles, stay in the URL and fetch only what they need', async () => {
    render(<TopologyView />);
    await screen.findByRole('button', { name: 'ip-10-0-4-12: 50%' });

    fireEvent.click(screen.getByRole('button', { name: 'Capacity type' }));
    expect(screen.getByRole('button', { name: 'ip-10-0-4-12: spot' })).toBeInTheDocument();
    expect(zoomParams().lens).toBe('capacity');

    fireEvent.click(screen.getByRole('button', { name: 'Cost' }));
    expect(screen.getByRole('button', { name: 'ip-10-0-7-88: $10.49/h' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Age' }));
    expect(screen.getByRole('button', { name: /ip-10-0-4-12: \d+d/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Serving health' }));
    expect(await screen.findByRole('button', { name: 'ip-10-0-7-88: Slow' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Disruption' }));
    expect(await screen.findByRole('button', { name: 'ip-10-0-7-88: blocked' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ip-10-0-4-12: none' })).toBeInTheDocument();
  });

  test('Cluster → NodePool → node → GPU, each level with its own URL, and Back zooms out', async () => {
    render(<TopologyView onOpenServing={vi.fn()} onOpenLogs={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /^gpu-l40s/ }));
    expect(zoomParams()).toEqual(expect.objectContaining({ zoom: 'pool', at: 'gpu-l40s' }));
    // Pool tiles carry request bars.
    const tile = screen.getByRole('button', { name: 'ip-10-0-7-88: 53%' });
    expect(within(tile).getByText('GPU')).toBeInTheDocument();

    fireEvent.click(tile);
    expect(zoomParams()).toEqual(expect.objectContaining({ zoom: 'node', at: 'ip-10-0-7-88' }));
    expect(screen.getByRole('navigation', { name: 'Zoom level' })).toHaveTextContent('Clustergpu-l40sip-10-0-7-88');
    expect(screen.getAllByText('Drill into node')).toHaveLength(1);
    expect(screen.getByRole('complementary', { name: 'Cluster minimap' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Zoom into GPU c3c3c3c3' }));
    expect(zoomParams()).toEqual(expect.objectContaining({ zoom: 'gpu', at: 'ip-10-0-7-88', card: GPU.c.uuid }));
    expect(await screen.findByText('2 slices on this card')).toBeInTheDocument();
    expect(screen.getByText(/29.3 GiB · 65% of the card/)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Open llm/llama-70b-r2 in Serving' })).toBeInTheDocument();
    // The batch job is not a serving pod: logs only.
    expect(screen.queryByRole('button', { name: 'Open batch/embed-worker-7f9c in Serving' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open logs for batch/embed-worker-7f9c' })).toBeInTheDocument();

    // Browser Back: the URL changes and popstate fires.
    act(() => {
      window.history.replaceState(null, '', '/?tab=topology&zoom=node&at=ip-10-0-7-88');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(screen.getAllByText('Drill into node')).toHaveLength(1);

    // Breadcrumb back to the cluster.
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Zoom level' })).getByRole('button', { name: 'Cluster' }));
    expect(await screen.findByRole('button', { name: 'ip-10-0-4-12: 50%' })).toBeInTheDocument();
  });

  test('GPU slice links call back to Serving and Logs', async () => {
    const onOpenServing = vi.fn();
    const onOpenLogs = vi.fn();
    setUrl(`?tab=topology&zoom=gpu&at=ip-10-0-7-88&card=${GPU.c.uuid}`);
    render(<TopologyView onOpenServing={onOpenServing} onOpenLogs={onOpenLogs} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open llm/llama-70b-r2 in Serving' }));
    expect(onOpenServing).toHaveBeenCalledWith(expect.objectContaining({ name: 'llama-70b-r2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open logs for batch/embed-worker-7f9c' }));
    expect(onOpenLogs).toHaveBeenCalledWith(expect.objectContaining({ name: 'embed-worker-7f9c' }));
    expect(screen.getByRole('navigation', { name: 'Zoom level' })).toHaveTextContent('c3c3c3c3');
  });

  test('gone nodes and GPUs explain themselves and offer a way out', async () => {
    setUrl('?tab=topology&zoom=node&at=ip-gone');
    const { unmount } = render(<TopologyView />);
    expect(await screen.findByText('ip-gone is no longer in the cluster')).toBeInTheDocument();
    unmount();

    setUrl('?tab=topology&zoom=gpu&at=ip-10-0-7-88&card=GPU-gone');
    render(<TopologyView />);
    expect(await screen.findByText(/This GPU is no longer on ip-10-0-7-88/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(zoomParams()).toEqual(expect.objectContaining({ zoom: 'node', at: 'ip-10-0-7-88' }));
  });

  test('an empty NodePool level says so; the minimap jumps to a node', async () => {
    setUrl('?tab=topology&zoom=pool&at=nope');
    render(<TopologyView />);
    expect(await screen.findByText('No nodes in nope')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Go to ip-10-0-4-12' }));
    expect(zoomParams()).toEqual(expect.objectContaining({ zoom: 'node', at: 'ip-10-0-4-12' }));
  });

  test('a Serving focus link shows the node level until the user zooms elsewhere', async () => {
    const onFocusDone = vi.fn();
    setUrl(`?tab=topology&node=ip-10-0-7-88&pod=llm/llama-70b-r2&gpu=${GPU.c.uuid}`);
    render(<TopologyView focus={{ node: 'ip-10-0-7-88', pod: 'llm/llama-70b-r2', gpu: GPU.c.uuid }} onFocusDone={onFocusDone} />);
    expect(await screen.findByText(/Shares c3c3c3c3 with/)).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Zoom level' })).toHaveTextContent('ip-10-0-7-88 (from Serving)');

    fireEvent.click(within(screen.getByRole('navigation', { name: 'Zoom level' })).getByRole('button', { name: 'Cluster' }));
    expect(onFocusDone).toHaveBeenCalled();
    expect(zoomParams()).toEqual({ tab: 'topology', zoom: 'cluster' });
  });
});

test('tiles shrink as the cluster grows', async () => {
  const { tileRange } = await import('./ClusterMap');
  expect(tileRange(20)).toEqual([22, 56]);
  expect(tileRange(200)).toEqual([12, 30]);
  expect(tileRange(1000)).toEqual([10, 22]);
});
