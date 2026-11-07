import { describe, test, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { ModelRow } from './ModelRow';
import { groupByModel } from '../../lib/servingModels';
import { modelCost } from '../../lib/servingCost';
import { servingPods } from '../../test/fixtures';

const llama = groupByModel([servingPods.r1, servingPods.r2, servingPods.r3])[0];

function renderRow(props = {}) {
  return render(
    <ModelRow group={llama} expanded={false} onToggle={vi.fn()} onSelectReplica={vi.fn()} {...props}>
      <p>cards</p>
    </ModelRow>,
  );
}

describe('ModelRow', () => {
  test('cost per 1M tokens with the hosted comparison and its inputs', () => {
    renderRow({ cost: modelCost(llama.replicas) });
    expect(screen.getByText('≈$1.24')).toBeInTheDocument();
    expect(screen.getByText('6.4× hosted $0.20')).toHaveClass('text-amber-700');
    fireEvent.click(screen.getByRole('button', { name: 'What is Per 1M tok?' }));
    expect(screen.getByText(/25% of the node’s GPUs × g6e.12xlarge at \$10.00\/h/)).toBeInTheDocument();
  });

  test('cheaper than hosted reads green', () => {
    const cost = { ...modelCost(llama.replicas), perMTok: 0.05 };
    renderRow({ cost });
    expect(screen.getByText('0.3× hosted $0.20')).toHaveClass('text-green-700');
  });

  test('without a hosted price: hourly cost; idle: no per-token figure', () => {
    const pods = llama.replicas.map((p) => ({ ...p, hostedPrice: null, tokensPerSec: 0 }));
    renderRow({ cost: modelCost(pods) });
    expect(screen.getByText('idle')).toBeInTheDocument();
    expect(screen.getByText('$7.50/h')).toBeInTheDocument();
  });

  test('hosted price without a mix shows the list prices', () => {
    const pods = llama.replicas.map((p) => ({ ...p, cost: null, promptTokensPerSec: null, generationTokensPerSec: null }));
    renderRow({ cost: modelCost(pods) });
    expect(screen.getByText('–')).toBeInTheDocument();
    expect(screen.getByText('hosted $0.13/$0.39')).toBeInTheDocument();
  });

  test('no prices at all: no cost column', () => {
    const pods = llama.replicas.map((p) => ({ ...p, cost: null, hostedPrice: null }));
    renderRow({ cost: modelCost(pods) });
    expect(screen.queryByText('Per 1M tok')).not.toBeInTheDocument();
    renderRow();
    expect(screen.queryByText('Per 1M tok')).not.toBeInTheDocument();
  });

  test('headroom label and explanation', () => {
    renderRow({ headroom: { pct: null, reason: 'short-history' } });
    expect(screen.getByText('Headroom')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'What is Headroom?' }));
    expect(screen.getByText('Needs 30 minutes of serving history.')).toBeInTheDocument();
  });
});
