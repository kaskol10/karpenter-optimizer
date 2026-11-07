import { describe, test, expect, vi, afterEach } from 'vitest';
import React, { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import { CommandPalette, isPaletteShortcut } from './CommandPalette';
import { StatusStrip } from './StatusStrip';
import { topologyNodes } from '../test/fixtures';

vi.mock('axios', () => ({ default: { get: vi.fn() } }));

function route({ topology = { nodes: topologyNodes }, serving = { pods: [{ namespace: 'llm', name: 'q-0', model: 'qwen', backend: 'sglang' }] } } = {}) {
  axios.get.mockImplementation((url) => {
    if (url.endsWith('/api/v1/topology')) return topology instanceof Error ? Promise.reject(topology) : Promise.resolve({ data: topology });
    if (url.endsWith('/api/v1/serving')) return serving instanceof Error ? Promise.reject(serving) : Promise.resolve({ data: serving });
    if (url.endsWith('/api/v1/alerts/status')) return Promise.resolve({ data: { enabled: false, firing: [] } });
    return Promise.reject(new Error(url));
  });
}

function Harness({ onRun }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        open
      </button>
      <CommandPalette open={open} onOpenChange={setOpen} onRun={onRun} />
    </>
  );
}

describe('CommandPalette', () => {
  afterEach(() => vi.clearAllMocks());

  test('isPaletteShortcut is ⌘K or Ctrl+K', () => {
    expect(isPaletteShortcut({ metaKey: true, key: 'k' })).toBe(true);
    expect(isPaletteShortcut({ ctrlKey: true, key: 'K' })).toBe(true);
    expect(isPaletteShortcut({ ctrlKey: true, altKey: true, key: 'k' })).toBe(false);
    expect(isPaletteShortcut({ key: 'k' })).toBe(false);
  });

  test('finds a node by part of its name and runs it with Enter', async () => {
    route();
    const onRun = vi.fn();
    render(<Harness onRun={onRun} />);
    await userEvent.click(screen.getByText('open'));
    const input = screen.getByRole('combobox', { name: 'Search' });
    expect(screen.getAllByRole('option').length).toBeGreaterThan(5); // pages and actions before typing
    await waitFor(() => expect(screen.queryByLabelText('Loading names')).not.toBeInTheDocument());

    const [, b] = topologyNodes;
    await userEvent.type(input, b.name.slice(-5));
    const first = screen.getAllByRole('option')[0];
    expect(first).toHaveTextContent(b.name);
    expect(first).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{Enter}');
    expect(onRun).toHaveBeenCalledWith({ type: 'navigate', page: 'topology', params: { zoom: 'node', at: b.name } });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('arrow keys move, a click runs, verbs become actions', async () => {
    route();
    const onRun = vi.fn();
    render(<Harness onRun={onRun} />);
    await userEvent.click(screen.getByText('open'));
    const input = screen.getByRole('combobox');
    await waitFor(() => expect(screen.queryByLabelText('Loading names')).not.toBeInTheDocument());

    await userEvent.type(input, 'drain ');
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(topologyNodes.length);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' }); // stops at the end
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'ArrowUp' }); // stops at the top
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.mouseMove(options[1]);
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(options[1]);
    expect(onRun).toHaveBeenCalledWith({ type: 'navigate', page: 'topology', params: { drain: topologyNodes[1].name } });
  });

  test('a hint row does nothing; no match says so; models come from /serving', async () => {
    route();
    const onRun = vi.fn();
    render(<Harness onRun={onRun} />);
    await userEvent.click(screen.getByText('open'));
    const input = screen.getByRole('combobox');
    await waitFor(() => expect(screen.queryByLabelText('Loading names')).not.toBeInTheDocument());

    await userEvent.type(input, 'fit lots');
    const hint = screen.getByRole('option');
    expect(hint).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(hint);
    await userEvent.keyboard('{Enter}');
    expect(onRun).not.toHaveBeenCalled();

    await userEvent.clear(input);
    await userEvent.type(input, 'zzzzzz');
    expect(screen.getByText(/Nothing matches/)).toBeInTheDocument();

    await userEvent.clear(input);
    await userEvent.type(input, 'qwen');
    expect(screen.getByRole('option', { name: /qwen.*1 replica · sglang/ })).toBeInTheDocument();
  });

  test('still offers pages when the lists fail; reopening within a minute does not refetch', async () => {
    route({ topology: new Error('down'), serving: { } });
    render(<Harness onRun={vi.fn()} />);
    await userEvent.click(screen.getByText('open'));
    await waitFor(() => expect(screen.queryByLabelText('Loading names')).not.toBeInTheDocument());
    await userEvent.type(screen.getByRole('combobox'), 'nodes');
    expect(screen.getByRole('option', { name: /Nodes/ })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByText('open'));
    expect(screen.getByRole('combobox')).toHaveValue('');
    expect(axios.get).toHaveBeenCalledTimes(2);
  });
});

describe('StatusStrip', () => {
  afterEach(() => vi.clearAllMocks());

  test('shows connection, Karpenter and firing alerts; the count opens alert settings', async () => {
    axios.get.mockResolvedValue({ data: { enabled: true, firing: [{ id: 'cost', title: 'Cost spike', severity: 'warning' }] } });
    const onOpenAlerts = vi.fn();
    render(<StatusStrip config={{ kubernetes: { connected: true }, karpenter: { detected: true } }} onOpenAlerts={onOpenAlerts} />);
    expect(screen.getByText('Cluster connected')).toBeInTheDocument();
    expect(screen.getByText('Karpenter')).toBeInTheDocument();
    const alerts = await screen.findByRole('button', { name: '1 alert firing' });
    expect(alerts).toHaveAttribute('title', 'Cost spike');
    await userEvent.click(alerts);
    expect(onOpenAlerts).toHaveBeenCalled();
  });

  test('no Karpenter, nothing firing, alerting off or unknown', async () => {
    axios.get.mockResolvedValue({ data: { enabled: true, firing: [] } });
    const { unmount } = render(<StatusStrip config={{ kubernetes: { connected: true }, karpenter: { detected: false } }} />);
    expect(screen.getByText('No Karpenter')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'No alerts firing' })).toBeInTheDocument();
    unmount();

    axios.get.mockResolvedValue({ data: { enabled: false, firing: [] } });
    const second = render(<StatusStrip config={{ kubernetes: { connected: false } }} />);
    expect(screen.getByText('Cluster not connected')).toBeInTheDocument();
    expect(screen.queryByText('Karpenter')).not.toBeInTheDocument();
    await waitFor(() => expect(axios.get).toHaveBeenCalled());
    expect(screen.queryByText(/alert/)).not.toBeInTheDocument();
    second.unmount();

    axios.get.mockRejectedValue(new Error('404'));
    render(<StatusStrip config={{ kubernetes: { connected: true }, karpenter: { detected: true } }} />);
    await waitFor(() => expect(axios.get).toHaveBeenCalledTimes(3));
    expect(screen.queryByText(/alert/)).not.toBeInTheDocument();
  });

  test('renders nothing before the config arrives', () => {
    axios.get.mockResolvedValue({ data: {} });
    const { container } = render(<StatusStrip config={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
