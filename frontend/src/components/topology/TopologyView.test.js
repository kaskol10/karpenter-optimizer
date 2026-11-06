import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import TopologyView from './TopologyView';
import { topologyNodes, GPU } from '../../test/fixtures';

// axios ships as an ES module that CRA's Jest does not transform.
jest.mock('axios', () => ({ get: jest.fn() }));

function setUrl(search) {
  window.history.replaceState(null, '', `/${search}`);
}

describe('TopologyView', () => {
  beforeEach(() => {
    axios.get.mockResolvedValue({ data: { nodes: topologyNodes } });
    setUrl('?tab=topology');
  });

  afterEach(() => jest.clearAllMocks());

  test('groups nodes by NodePool and shows each node card', async () => {
    render(<TopologyView />);
    expect(await screen.findByRole('heading', { name: 'gpu-l40s' })).toBeInTheDocument();
    expect(screen.getByText('ip-10-0-4-12')).toBeInTheDocument();
    expect(screen.getByText('ip-10-0-7-88')).toBeInTheDocument();
    expect(axios.get).toHaveBeenCalledWith(expect.stringMatching(/\/api\/v1\/topology$/));
  });

  test('a focus link names the GPU neighbours and offers a way back', async () => {
    const onBack = jest.fn();
    const onClear = jest.fn();
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
});
