import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, within, fireEvent } from '@testing-library/react';
import axios from 'axios';
import TopologyView from './TopologyView';
import { topologyNodes } from '../../test/fixtures';

vi.mock('axios', () => ({ default: { get: vi.fn() } }));

const nodes = topologyNodes.map((n) => ({ ...n, costPerHour: 10 }));
const params = () => Object.fromEntries(new URLSearchParams(window.location.search));
function setUrl(search) {
  window.history.replaceState(null, '', `/${search}`);
}

describe('Topology drain simulator and placement planner', () => {
  beforeEach(() => {
    axios.get.mockResolvedValue({ data: { nodes, currency: 'USD' } });
  });
  afterEach(() => vi.clearAllMocks());

  test('Simulate drain from the node menu: panel, moves, saving, and the node greyed out', async () => {
    setUrl('?tab=topology&zoom=node');
    render(<TopologyView />);
    const menu = (await screen.findByLabelText('Actions for ip-10-0-7-88')).closest('details');
    fireEvent.click(within(menu).getByText('Actions'));
    fireEvent.click(within(menu).getByRole('button', { name: /Simulate drain/ }));

    expect(params().drain).toBe('ip-10-0-7-88');
    const panel = screen.getByRole('region', { name: 'Drain simulation' });
    expect(within(panel).getByText('approximate')).toBeInTheDocument();
    expect(panel).toHaveTextContent('4 pods would move, and everything fits; 1 DaemonSet pod goes with the node.');
    expect(panel).toHaveTextContent('saves about $7,300/month ($10.00/h)');
    expect(panel).toHaveTextContent('Not modelled: taints and tolerations');
    expect(screen.getByLabelText('ip-10-0-7-88 (simulated drain)')).toBeInTheDocument();
    expect(within(panel).getAllByRole('button', { name: 'ip-10-0-4-12' })).toHaveLength(4);

    // Toggle it back off from the same menu.
    fireEvent.click(within(screen.getByLabelText('Actions for ip-10-0-7-88').closest('details')).getByRole('button', { name: /Remove from drain simulation/ }));
    expect(screen.queryByRole('region', { name: 'Drain simulation' })).not.toBeInTheDocument();
    expect(params().drain).toBeUndefined();
  });

  test('a shared ?drain= link: drained tiles on the Cluster level, chips, links and clear', async () => {
    setUrl('?tab=topology&drain=ip-10-0-7-88');
    render(<TopologyView />);
    expect(await screen.findByRole('button', { name: /ip-10-0-7-88: .* \(simulated drain\)/ })).toBeInTheDocument();
    const panel = screen.getByRole('region', { name: 'Drain simulation' });
    fireEvent.click(within(panel).getAllByRole('button', { name: 'ip-10-0-4-12' })[0]);
    expect(params()).toEqual(expect.objectContaining({ zoom: 'node', at: 'ip-10-0-4-12' }));
    fireEvent.click(within(screen.getByRole('region', { name: 'Drain simulation' })).getByRole('button', { name: 'Clear' }));
    expect(screen.queryByRole('region', { name: 'Drain simulation' })).not.toBeInTheDocument();
  });

  test('draining every node: pods that would not fit are listed in red, no saving without prices', async () => {
    axios.get.mockResolvedValue({ data: { nodes: topologyNodes, currency: 'USD' } });
    setUrl('?tab=topology&zoom=pool&at=gpu-l40s&drain=ip-10-0-7-88,ip-10-0-4-12');
    render(<TopologyView />);
    const panel = await screen.findByRole('region', { name: 'Drain simulation' });
    expect(panel).toHaveTextContent('0 pods would move, 6 would not fit anywhere');
    expect(within(panel).getByRole('list', { name: 'Pods that would not fit' })).toHaveTextContent('no other node');
    expect(panel).not.toHaveTextContent('/month');
    expect(screen.getByRole('button', { name: /ip-10-0-4-12: .* \(simulated drain\)/ })).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'Stop simulating ip-10-0-4-12' }));
    expect(params().drain).toBe('ip-10-0-7-88');
  });

  test('the planner places replicas across nodes and marks the cards', async () => {
    setUrl('?tab=topology&zoom=node&fit=40&replicas=2');
    render(<TopologyView />);
    const plan = await screen.findByLabelText('Placement plan');
    expect(plan).toHaveTextContent('All 2 replicas fit across 2 nodes in 2 zones.');
    expect(plan).toHaveTextContent('R1 ip-10-0-4-12');
    expect(plan).toHaveTextContent('R2 ip-10-0-7-88');
    expect(screen.getAllByRole('listitem', { name: /planned replica/ })).toHaveLength(2);

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Replicas' }), { target: { value: '5' } });
    expect(screen.getByLabelText('Placement plan')).toHaveTextContent('Only 4 of 5 replicas fit: the pool must grow for the rest.');
    expect(params().replicas).toBe('5');

    // Nonsense replica counts fall back to one replica (no plan line).
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Replicas' }), { target: { value: 'x' } });
    expect(screen.queryByLabelText('Placement plan')).not.toBeInTheDocument();
  });

  test('a drained node is not offered to the planner', async () => {
    setUrl('?tab=topology&zoom=node&fit=40&replicas=2&drain=ip-10-0-4-12');
    render(<TopologyView />);
    const plan = await screen.findByLabelText('Placement plan');
    expect(plan).toHaveTextContent('All 2 replicas fit, but only on one node: losing it takes the model down.');
    expect(plan).not.toHaveTextContent('ip-10-0-4-12');
  });

  test('node cards drill down, one at a time, with their own filters', async () => {
    setUrl('?tab=topology&zoom=node');
    render(<TopologyView />);
    const [first, second] = await screen.findAllByRole('button', { name: 'Drill into node' });
    fireEvent.click(first);
    expect(screen.getByRole('button', { name: 'Hide node details' })).toBeInTheDocument();
    fireEvent.click(second);
    expect(screen.getAllByRole('button', { name: 'Hide node details' })).toHaveLength(1);
    const search = screen.getByPlaceholderText(/search/i);
    fireEvent.change(search, { target: { value: 'reranker' } });
    expect(search).toHaveValue('reranker');
    fireEvent.click(screen.getByRole('button', { name: 'Hide node details' }));
    expect(screen.queryByRole('button', { name: 'Hide node details' })).not.toBeInTheDocument();
  });
});
