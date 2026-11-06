import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ServingCard } from './ServingCard';
import { findGpuNeighbours } from '../../lib/servingPlacement';
import { allServingPods, servingPods, topologyNodes, GPU } from '../../test/fixtures';

function renderCard(pod, { onOpenTopology = jest.fn(), withPlacement = true } = {}) {
  const placement = withPlacement ? findGpuNeighbours(pod, topologyNodes) : undefined;
  render(
    <ServingCard pod={pod} peers={allServingPods} placement={placement} onOpenTopology={onOpenTopology} />,
  );
  return { onOpenTopology };
}

describe('ServingCard', () => {
  test('a healthy replica alone on its GPU shows OK and no diagnosis', () => {
    renderCard(servingPods.r1);
    expect(screen.getByText('OK')).toBeInTheDocument();
    expect(screen.queryByText(/Try first/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Shares /)).not.toBeInTheDocument();
  });

  test('a slow replica names its GPU neighbour, leads with moving it, and links to topology', async () => {
    const { onOpenTopology } = renderCard(servingPods.r2);

    expect(screen.getByText('Slow')).toBeInTheDocument();
    expect(screen.getByText(/>2x the fastest server/)).toBeInTheDocument();
    expect(screen.getByText('shares c3c3c3c3 with batch/embed-worker-7f9c')).toBeInTheDocument();
    expect(screen.getByText(/Move the co-located pod off c3c3c3c3/)).toBeInTheDocument();

    // The remaining fixes are on the page, behind a disclosure, not in a tooltip.
    const more = screen.getByText(/3 more things to try/);
    await userEvent.click(more);
    const list = more.closest('details').querySelector('ol');
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);

    await userEvent.click(screen.getByRole('button', { name: /See who shares this GPU/ }));
    expect(onOpenTopology).toHaveBeenCalledWith({
      node: 'ip-10-0-7-88',
      pod: 'llm/llama-70b-r2',
      gpu: GPU.c.uuid,
    });
  });

  test('a healthy replica sharing a GPU shows a quiet chip instead of a diagnosis', async () => {
    const { onOpenTopology } = renderCard(servingPods.qwen);
    expect(screen.getByText('OK')).toBeInTheDocument();
    expect(screen.queryByText(/Try first/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Shares d4d4d4d4 with 1 pod/ }));
    expect(onOpenTopology).toHaveBeenCalledWith(expect.objectContaining({ pod: 'llm/qwen3-8b-0' }));
  });

  test('without topology data the card still diagnoses, just without neighbours', () => {
    renderCard(servingPods.r2, { withPlacement: false });
    expect(screen.getByText('Slow')).toBeInTheDocument();
    expect(screen.queryByText(/shares c3c3c3c3/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Show placement in topology/ })).toBeInTheDocument();
  });

  test('an offline replica shows its error instead of metrics', () => {
    renderCard(servingPods.offline, { withPlacement: false });
    expect(screen.getByText('offline')).toBeInTheDocument();
    expect(screen.getByText('connection refused')).toBeInTheDocument();
    expect(screen.queryByText('KV cache')).not.toBeInTheDocument();
  });
});
