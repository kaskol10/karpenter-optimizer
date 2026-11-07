import { describe, test, expect } from 'vitest';
import React from 'react';
import { render, screen, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GatewayFlow, formatFlowValue } from './GatewayFlow';

const gateway = {
  models: [
    {
      model: 'llama-70b',
      apps: [
        { name: 'support-bot', tokensTotal: 42_000_000, spend: 180 },
        { name: 'search', tokensTotal: 6_000_000, spend: 25 },
      ],
      teams: [{ name: 'cx', tokensTotal: 48_000_000, spend: 205 }],
    },
    {
      model: 'qwen-7b',
      apps: [{ name: 'search', tokensTotal: 12_000_000, spend: 0 }],
      teams: [{ name: 'data', tokensTotal: 12_000_000 }],
    },
  ],
};

const rows = () =>
  within(screen.getByRole('table'))
    .getAllByRole('row')
    .slice(1)
    .map((r) => r.textContent);

describe('GatewayFlow', () => {
  test('draws the Sankey and lists the largest flows by tokens', () => {
    const { container } = render(<GatewayFlow gateway={gateway} width={800} />);
    expect(screen.getByText(/App → model, by/)).toBeInTheDocument();
    expect(rows()).toEqual(['support-bot → llama-70b42.0M70%', 'search → qwen-7b12.0M20%', 'search → llama-70b6.00M10%']);
    // Three links and four nodes in the SVG, labels on the bars.
    expect(container.querySelectorAll('path[stroke]')).toHaveLength(3);
    expect(container.querySelector('svg')).toHaveTextContent('support-bot');
    expect(container.querySelector('svg')).toHaveTextContent('llama-70b');
  });

  test('hovering a link highlights it and dims the others', () => {
    const { container } = render(<GatewayFlow gateway={gateway} width={800} />);
    const [first, second] = container.querySelectorAll('path[stroke]');
    fireEvent.mouseEnter(first);
    expect(first).toHaveAttribute('stroke-opacity', '0.75');
    expect(second).toHaveAttribute('stroke-opacity', '0.12');
    fireEvent.mouseLeave(first);
    expect(second).toHaveAttribute('stroke-opacity', '0.35');
  });

  test('switches to spend; zero spend drops out', async () => {
    render(<GatewayFlow gateway={gateway} width={800} />);
    await userEvent.click(screen.getByRole('button', { name: 'Spend' }));
    expect(screen.getByRole('button', { name: 'Spend' })).toHaveAttribute('aria-pressed', 'true');
    expect(rows()).toEqual(['support-bot → llama-70b$180.0088%', 'search → llama-70b$25.0012%']);
  });

  test('follows the Split-by dimension', () => {
    render(<GatewayFlow gateway={gateway} dimField="teams" dimLabel="Team" width={800} />);
    expect(screen.getByText(/Team → model, by/)).toBeInTheDocument();
    expect(rows()).toEqual(['cx → llama-70b48.0M80%', 'data → qwen-7b12.0M20%']);
  });

  test('says when there is nothing to draw, and when small flows are grouped', async () => {
    const { unmount } = render(<GatewayFlow gateway={{ models: [] }} dimLabel="Team" />);
    expect(screen.getByText(/No token usage per team and model yet/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Spend' }));
    expect(screen.getByText(/The gateway may not track spend/)).toBeInTheDocument();
    unmount();

    const many = {
      models: Array.from({ length: 10 }, (_, i) => ({ model: `m${i}`, apps: [{ name: `a${i}`, tokensTotal: 100 - i }] })),
    };
    render(<GatewayFlow gateway={many} />);
    expect(screen.getByText(/Smaller flows are grouped/)).toBeInTheDocument();
  });

  test('formatFlowValue', () => {
    expect(formatFlowValue('spend', 3.456)).toBe('$3.46');
    expect(formatFlowValue('tokens', 1499.6)).toBe('1.5k');
  });
});
