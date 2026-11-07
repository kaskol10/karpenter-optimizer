import { describe, test, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ServingCard } from './ServingCard';
import { findGpuNeighbours } from '../../lib/servingPlacement';
import { allServingPods, servingPods, topologyNodes, GPU } from '../../test/fixtures';

function renderCard(pod, { onOpenTopology = vi.fn(), withPlacement = true } = {}) {
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

  test('the header carries one status badge and a quiet metadata line', () => {
    renderCard(servingPods.r1);
    expect(screen.queryByText('online')).not.toBeInTheDocument();
    expect(screen.getByText(/^vllm/).textContent).toBe('vllm · g6e.12xlarge · L40S x4');
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

  test('the latency split shows first token vs generation on the model scale', () => {
    renderCard(servingPods.r2);
    expect(screen.getByRole('img', { name: 'First token 0.21s, generation 4.9s' })).toBeInTheDocument();
    expect(screen.getByText('5.1s mean')).toBeInTheDocument();
  });

  test('a metric help button opens its definition next to the number', async () => {
    renderCard(servingPods.r1);
    expect(screen.queryByText(/Should stay at 0/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'What is Preempt?' }));
    expect(await screen.findByText(/Should stay at 0/)).toBeInTheDocument();
  });

  test('the Preempt tile shows the last 5 minutes, with the lifetime total below', () => {
    renderCard(servingPods.r1);
    expect(screen.getByText('17 total')).toBeInTheDocument();
    expect(screen.getByText('OK')).toBeInTheDocument();
  });

  test('an offline replica shows its error instead of metrics', () => {
    renderCard(servingPods.offline, { withPlacement: false });
    expect(screen.getByText('offline')).toBeInTheDocument();
    expect(screen.getByText('connection refused')).toBeInTheDocument();
    expect(screen.queryByText('KV cache')).not.toBeInTheDocument();
  });
});
