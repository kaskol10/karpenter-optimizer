import { describe, test, expect, vi } from 'vitest';
import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { RoutingMap } from './RoutingMap';

const route = (over) => ({
  team: 'Backend',
  key: 'questions',
  alias: 'empathyai/Qwen/Qwen3.5-9B',
  modelGroup: 'empathyai/Qwen/Qwen3.5-9B',
  deployment: 'Qwen/Qwen3.5-9B',
  apiBase: 'https://vllm.office-prod.empathy.ai/v1',
  provider: 'hosted_vllm',
  requests: 100,
  failures: 0,
  ...over,
});

const data = {
  routes: [
    route({}),
    route({ modelGroup: 'together/Qwen3.5-9B', deployment: 'together_ai/Qwen3.5-9B', apiBase: 'https://api.together.xyz/v1', provider: 'together_ai', requests: 14 }),
    route({ team: 'Search', key: 'search-api', alias: 'empathyai/Qwen/Qwen3.5-2B', modelGroup: 'empathyai/Qwen/Qwen3.5-2B', deployment: 'Qwen/Qwen3.5-2B', apiBase: 'http://qwen.llm:8000/v1', requests: 40, failures: 4 }),
    route({ key: 'ci', requests: 3, failures: 1 }),
  ],
  deployments: [{ model: 'Qwen/Qwen3.5-9B', apiBase: 'https://vllm.office-prod.empathy.ai/v1', provider: 'hosted_vllm', state: 2 }],
  teams: [{ team: 'Backend', throttled: 2, budgetRemaining: 30, budgetMax: 100 }],
  models: [{ model: 'empathyai/Qwen/Qwen3.5-9B', spend: 12.5, ttftP50Seconds: 0.2, ttftP95Seconds: 0.9 }],
};
const groups = [{ model: 'Qwen/Qwen3.5-2B', online: 2, replicas: [{}, {}], kvMax: 40, waiting: 0 }];

const node = (name) => screen.getByRole('button', { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}( \\(|:)`) });

describe('RoutingMap', () => {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(() => Promise.resolve()) }, configurable: true });

  test('draws the four columns with facts and flags', () => {
    render(<RoutingMap data={data} groups={groups} filtered={false} onFilter={vi.fn()} />);
    ['Callers', 'Deployments', 'Runs on'].forEach((c) => expect(screen.getByText(c)).toBeInTheDocument());
    expect(screen.getByText('Aliases (empathyai/…)')).toBeInTheDocument();
    expect(node('Backend')).toHaveAccessibleName('Backend: 118 req, 2 throttled');
    expect(node('empathyai/Qwen/Qwen3.5-9B')).toHaveAccessibleName(/12% fallbacks/);
    expect(node('Qwen/Qwen3.5-9B')).toHaveAccessibleName(/Outage, still receiving traffic/);
    expect(node('2/2 vLLM pods')).toBeInTheDocument();
    expect(node('api.together.xyz')).toHaveAccessibleName(/external API/);
  });

  test('clicking an alias lights its paths and shows where its traffic goes', () => {
    const onFilter = vi.fn();
    render(<RoutingMap data={data} groups={groups} filtered={false} onFilter={onFilter} />);
    fireEvent.click(node('empathyai/Qwen/Qwen3.5-9B'));
    expect(node('empathyai/Qwen/Qwen3.5-9B')).toHaveAttribute('aria-pressed', 'true');
    expect(node('Search').getAttribute('class')).toMatch(/opacity-20/);
    const details = screen.getByRole('region', { name: /Details for empathyai\/Qwen\/Qwen3.5-9B/ });
    expect(within(details).getByText('Where its traffic goes')).toBeInTheDocument();
    expect(within(details).getAllByText(/fallback/).length).toBeGreaterThan(0);
    expect(within(details).getByText(/outage/)).toBeInTheDocument();
    expect(within(details).getByText('Spend $12.50')).toBeInTheDocument();
    fireEvent.click(within(details).getByRole('button', { name: 'Filter Team usage by this alias' }));
    expect(onFilter).toHaveBeenCalledWith({ model: 'empathyai/Qwen/Qwen3.5-9B' });
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  test('a team shows its keys and budget; Enter toggles; close button', () => {
    const onFilter = vi.fn();
    render(<RoutingMap data={data} groups={groups} filtered={false} onFilter={onFilter} />);
    fireEvent.keyDown(node('Backend'), { key: 'Enter' });
    const details = screen.getByRole('region', { name: /Details for Backend/ });
    expect(within(details).getByText('Its API keys')).toBeInTheDocument();
    expect(within(details).getByText('ci')).toBeInTheDocument();
    expect(within(details).getByText(/\$30.00 left of \$100.00/)).toBeInTheDocument();
    fireEvent.click(within(details).getByRole('button', { name: 'Filter Team usage by this team' }));
    expect(onFilter).toHaveBeenCalledWith({ team: 'Backend' });
    fireEvent.keyDown(node('Backend'), { key: ' ' });
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    fireEvent.keyDown(node('Backend'), { key: 'Enter' });
    fireEvent.keyDown(node('Backend'), { key: 'Enter' });
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    fireEvent.keyDown(node('Backend'), { key: 'Tab' });
  });

  test('API keys mode, deployment and runs-on details', () => {
    const onFilter = vi.fn();
    render(<RoutingMap data={data} groups={groups} filtered onFilter={onFilter} />);
    fireEvent.click(screen.getByRole('button', { name: 'API keys' }));
    fireEvent.click(node('search-api'));
    fireEvent.click(screen.getByRole('button', { name: 'Filter Team usage by this API key' }));
    expect(onFilter).toHaveBeenCalledWith({ key: 'search-api' });

    fireEvent.click(node('together_ai/Qwen3.5-9B'));
    let details = screen.getByRole('region');
    expect(within(details).getByText('Who reaches it')).toBeInTheDocument();
    expect(within(details).getByText('Identifiers')).toBeInTheDocument();
    fireEvent.click(within(details).getByTitle('Copy api_base'));

    fireEvent.click(node('2/2 vLLM pods'));
    details = screen.getByRole('region');
    expect(within(details).getByText('Deployments here')).toBeInTheDocument();
    expect(within(details).getByText('Aliases routed here')).toBeInTheDocument();
  });

  test('a crowded column folds into "N more"', () => {
    const many = Array.from({ length: 15 }, (_, i) => route({ team: `team-${i}`, requests: 100 - i }));
    render(<RoutingMap data={{ routes: many }} groups={[]} filtered onFilter={vi.fn()} />);
    fireEvent.click(node('4 more'));
    expect(screen.getByText(/4 smaller nodes, folded/)).toBeInTheDocument();
  });

  test('no routes', () => {
    render(<RoutingMap data={{ routes: [] }} groups={[]} filtered={false} onFilter={vi.fn()} />);
    expect(screen.getByText('No routed requests in this window.')).toBeInTheDocument();
  });
});
