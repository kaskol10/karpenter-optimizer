import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import TopologyView from './TopologyView';
import { topologyNodes, GPU } from '../../test/fixtures';

// Serve the topology fixture instead of calling the API.
vi.mock('axios', () => ({ default: { get: vi.fn() } }));

function setUrl(search) {
  window.history.replaceState(null, '', `/${search}`);
}

describe('TopologyView', () => {
  beforeEach(() => {
    axios.get.mockResolvedValue({ data: { nodes: topologyNodes } });
    setUrl('?tab=topology');
  });

  afterEach(() => vi.clearAllMocks());

  test('groups nodes by NodePool and shows each node card', async () => {
    render(<TopologyView />);
    expect(await screen.findByRole('heading', { name: 'gpu-l40s' })).toBeInTheDocument();
    expect(screen.getByText('ip-10-0-4-12')).toBeInTheDocument();
    expect(screen.getByText('ip-10-0-7-88')).toBeInTheDocument();
    expect(axios.get).toHaveBeenCalledWith(expect.stringMatching(/\/api\/v1\/topology$/));
  });

  test('a focus link names the GPU neighbours and offers a way back', async () => {
    const onBack = vi.fn();
    const onClear = vi.fn();
    render(
      <TopologyView
        focus={{ node: 'ip-10-0-7-88', pod: 'llm/llama-70b-r2', gpu: GPU.c.uuid }}
        onBackToServing={onBack}
        onClearFocus={onClear}
      />,
    );
    expect(await screen.findByText(/Shares c3c3c3c3 with/)).toBeInTheDocument();
    expect(screen.getAllByText('batch/embed-worker-7f9c').length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole('button', { name: /Back to Serving/ }));
    expect(onBack).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: /Clear focus/ }));
    expect(onClear).toHaveBeenCalled();
  });

  test('a focus link to a node that is gone explains why', async () => {
    render(<TopologyView focus={{ node: 'ip-gone', pod: 'llm/x', gpu: '' }} />);
    expect(await screen.findByText(/no longer in the cluster/)).toBeInTheDocument();
  });

  test('filters come from the URL', async () => {
    setUrl('?tab=topology&ns=batch&ds=hide');
    render(<TopologyView />);
    await screen.findByRole('heading', { name: 'gpu-l40s' });
    expect(screen.getByDisplayValue('batch')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'DaemonSets hidden' })).toBeInTheDocument();
    expect(screen.queryByText('llm/qwen3-8b-0')).not.toBeInTheDocument();
    expect(screen.getAllByText('batch/embed-worker-7f9c').length).toBeGreaterThan(0);
  });

  test('a focus link clears filters that would hide the focused pod', async () => {
    setUrl('?tab=topology&ns=search');
    render(<TopologyView focus={{ node: 'ip-10-0-7-88', pod: 'llm/llama-70b-r2', gpu: GPU.c.uuid }} />);
    await screen.findByText(/Shares c3c3c3c3 with/);
    await waitFor(() => expect(screen.queryByDisplayValue('search')).not.toBeInTheDocument());
    expect(window.location.search).not.toContain('ns=');
  });

  test('each GPU is a tank with its free memory, and each node states its fragmentation', async () => {
    render(<TopologyView />);
    const gpus = await screen.findAllByRole('list', { name: 'GPUs' });
    expect(gpus).toHaveLength(2);
    expect(within(gpus[1]).getByRole('listitem', { name: 'GPU c3c3c3c3: 2.0 GiB free' })).toBeInTheDocument();
    expect(within(gpus[1]).getByRole('listitem', { name: 'GPU d4d4d4d4: 17.6 GiB free' })).toBeInTheDocument();
    expect(screen.getByText('109.4 GiB free')).toBeInTheDocument();
    expect(screen.getAllByText(/largest single gap 44.9 GiB/)).toHaveLength(2);
  });

  test('a pod hidden by a filter still takes its memory', async () => {
    setUrl('?tab=topology&ns=llm');
    render(<TopologyView />);
    const gpus = await screen.findAllByRole('list', { name: 'GPUs' });
    // embed-worker is filtered out, but c3c3c3c3 still has only 2.0 GiB free.
    expect(within(gpus[1]).getByRole('listitem', { name: 'GPU c3c3c3c3: 2.0 GiB free' })).toBeInTheDocument();
  });

  test('Will it fit? lights up the cards with room and survives a refresh', async () => {
    setUrl('?tab=topology&fit=17GiB');
    render(<TopologyView />);
    expect(await screen.findByText(/17.0 GiB fits on 5 GPUs across 2 nodes/)).toBeInTheDocument();
    const gpus = screen.getAllByRole('list', { name: 'GPUs' });
    expect(within(gpus[1]).getByRole('listitem', { name: 'GPU d4d4d4d4: 17.6 GiB free, fits' })).toBeInTheDocument();
    expect(within(gpus[1]).getByRole('listitem', { name: 'GPU c3c3c3c3: 2.0 GiB free' })).toHaveClass('opacity-40');

    const input = screen.getByRole('textbox', { name: /Will it fit/ });
    fireEvent.change(input, { target: { value: '50' } });
    expect(screen.getByText(/50.0 GiB fits on no GPU in view. Largest free space on one card: 44.9 GiB/)).toBeInTheDocument();
    expect(window.location.search).toContain('fit=50');

    fireEvent.change(input, { target: { value: 'lots' } });
    expect(screen.getByText(/Use a size such as 40/)).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });

  test('Will it fit? counts only the nodes in view, and says when none report GPU memory', async () => {
    setUrl('?tab=topology&fit=40&nodeq=7-88');
    render(<TopologyView />);
    expect(await screen.findByText(/40.0 GiB fits on 2 GPUs across 1 node\./)).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: /Will it fit/ }), { target: { value: '' } });
    expect(screen.getByText(/Type a size to see which GPUs/)).toBeInTheDocument();
  });
});
