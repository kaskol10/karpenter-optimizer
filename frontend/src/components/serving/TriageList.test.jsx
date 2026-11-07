import { describe, test, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { TriageList } from './TriageList';
import { buildTriage } from '../../lib/servingTriage';
import { placementFromServing } from '../../lib/servingPlacement';
import { allServingPods, servingPods } from '../../test/fixtures';

const pods = [...allServingPods, servingPods.offline];
const placements = Object.fromEntries(pods.map((p) => [`${p.namespace}/${p.name}`, placementFromServing(p)]));

describe('TriageList', () => {
  afterEach(() => vi.restoreAllMocks());

  test('renders nothing when every replica is OK', () => {
    const { container } = render(<TriageList items={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  test('one line per troubled replica, worst first, with reasons and duration', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000 * 1000);
    const items = buildTriage(pods, placements, {
      'llm/llama-70b-r2': { points: [{ unix: 1_000_000 - 720, online: true, waiting: 3 }] },
    });
    render(<TriageList items={items} />);
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('offline')).toBeInTheDocument();
    expect(within(rows[0]).getByText('connection refused')).toBeInTheDocument();
    expect(within(rows[1]).getByText(/embed-worker-7f9c/)).toBeInTheDocument();
    expect(within(rows[1]).getByText('for 12m')).toBeInTheDocument();
  });

  test('actions: topology (with the shared GPU), logs, card focus', () => {
    const onOpenTopology = vi.fn();
    const onOpenLogs = vi.fn();
    const onFocusCard = vi.fn();
    render(
      <TriageList
        items={buildTriage(pods, placements)}
        onOpenTopology={onOpenTopology}
        onOpenLogs={onOpenLogs}
        onFocusCard={onFocusCard}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show llm/llama-70b-r2 in topology' }));
    expect(onOpenTopology).toHaveBeenCalledWith({
      node: servingPods.r2.node,
      pod: 'llm/llama-70b-r2',
      gpu: servingPods.r2.gpuDevices[0].uuid,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open logs for llm/mistral-0' }));
    expect(onOpenLogs).toHaveBeenCalledWith(servingPods.offline);
    fireEvent.click(screen.getByRole('button', { name: 'llm/llama-70b-r2' }));
    expect(onFocusCard).toHaveBeenCalledWith(servingPods.r2);
  });

  test('kubectl menu copies a command', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    render(<TriageList items={buildTriage(pods, placements)} />);
    fireEvent.click(screen.getByLabelText('kubectl commands for llm/llama-70b-r2'));
    fireEvent.click(screen.getByText('kubectl -n llm logs llama-70b-r2 --tail=200'));
    expect(writeText).toHaveBeenCalledWith('kubectl -n llm logs llama-70b-r2 --tail=200');
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });
});
