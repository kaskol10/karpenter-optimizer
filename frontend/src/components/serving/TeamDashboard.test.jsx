import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import { TeamDashboard } from './TeamDashboard';

vi.mock('axios', () => ({ default: { get: vi.fn() } }));

const dashboard = {
  team: '',
  range: 'month',
  from: '2026-11-01T00:00:00Z',
  to: '2026-11-17T12:00:00Z',
  summary: { spend: 812.4, requests: 120000, failed: 2400, errorRatePct: 2, activeDevelopers: 14, throttled: 31 },
  budget: null,
  spendByDay: [
    { day: '2026-11-15', model: 'llama-70b', value: 40 },
    { day: '2026-11-16', model: 'qwen-32b', value: 12 },
  ],
  tokensByDay: [{ day: '2026-11-16', input: 1e6, cached: null, output: 2e5 }],
  developers: [
    { key: 'alice-laptop', spend: 300, tokens: 4e6, requests: 1000, failed: 80, budgetRemaining: 50, ttftP95Seconds: 0.8 },
  ],
  models: [{ model: 'llama-70b', requests: 9000, ttftP50Seconds: 0.3, ttftP95Seconds: 1.2 }],
  outputSpeed: [{ modelGroup: 'llama-70b', tokensPerSecond: 42.25 }],
  options: { teams: ['search', 'ads'], models: ['llama-70b'], keys: ['alice-laptop'] },
  errors: { budget: 'timeout' },
};

describe('TeamDashboard', () => {
  beforeEach(() => window.history.replaceState(null, '', '/inference/gateway'));
  afterEach(() => vi.clearAllMocks());

  test('summary tiles, charts, keys, latency and failed panels', async () => {
    axios.get.mockResolvedValue({ data: dashboard });
    render(<TeamDashboard />);
    expect(await screen.findByText('$812.40')).toBeInTheDocument();
    expect(screen.getByText('120k')).toBeInTheDocument();
    expect(screen.getByText('2.0%')).toBeInTheDocument();
    expect(screen.getByText('Pick a team')).toBeInTheDocument();
    expect(screen.getByText(/did not answer for: budget/)).toBeInTheDocument();
    expect(screen.getByText('UTC days · 2026-11-01 → 2026-11-17')).toBeInTheDocument();
    expect(screen.getByText('qwen-32b')).toBeInTheDocument();
    expect(screen.getByText('Input')).toBeInTheDocument();
    expect(screen.queryByText('Cached input')).not.toBeInTheDocument();
    expect(screen.getByText('8.0%')).toBeInTheDocument();
    expect(screen.getByText('42.3 tok/s')).toBeInTheDocument();
    expect(screen.getByText('1.20 s')).toBeInTheDocument();
  });

  test('clicking a key or a model filters by it, and again clears it', async () => {
    axios.get.mockResolvedValue({ data: dashboard });
    render(<TeamDashboard />);
    await userEvent.click(await screen.findByRole('button', { name: 'alice-laptop' }));
    expect(window.location.search).toBe('?key=alice-laptop');
    expect(axios.get).toHaveBeenLastCalledWith(expect.any(String), { params: { range: 'month', key: 'alice-laptop' } });
    await userEvent.click(screen.getByRole('button', { name: 'alice-laptop' }));
    expect(window.location.search).toBe('');
    const latency = screen.getByText('Time to first token by model').closest('section');
    await userEvent.click(within(latency).getByRole('button', { name: 'llama-70b' }));
    expect(window.location.search).toBe('?model=llama-70b');
    await userEvent.click(within(latency).getByRole('button', { name: 'llama-70b' }));
    expect(window.location.search).toBe('');
  });

  test('a team from the URL shows its budget', async () => {
    window.history.replaceState(null, '', '/inference/gateway?team=search&range=7d');
    axios.get.mockResolvedValue({
      data: { ...dashboard, budget: { remaining: 10, max: 100, remainingShare: 0.1, hoursToReset: 5 }, errors: undefined },
    });
    render(<TeamDashboard />);
    expect(await screen.findByText('10%')).toBeInTheDocument();
    expect(screen.getByText('$10.00 of $100.00 · resets in 5 h')).toBeInTheDocument();
    expect(axios.get).toHaveBeenCalledWith(expect.any(String), { params: { range: '7d', team: 'search' } });
  });

  test('empty panels and a team without a budget', async () => {
    window.history.replaceState(null, '', '/inference/gateway?team=ads');
    axios.get.mockResolvedValue({ data: { from: dashboard.from, to: dashboard.to, summary: {} } });
    render(<TeamDashboard />);
    expect(await screen.findByText('No budget set')).toBeInTheDocument();
    expect(screen.getAllByText('No data in this window.')).toHaveLength(5);
  });

  test('no Prometheus: explains how to turn it on', async () => {
    axios.get.mockRejectedValue(Object.assign(new Error('x'), { response: { status: 503, data: { code: 'prometheus_not_configured' } } }));
    render(<TeamDashboard />);
    expect(await screen.findByText('usage.prometheusUrl')).toBeInTheDocument();
  });

  test('a failed request says so', async () => {
    axios.get.mockRejectedValue(Object.assign(new Error('x'), { response: { status: 500, data: { error: 'boom' } } }));
    render(<TeamDashboard />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load team usage: boom.');
  });

  test('fallbacks, $0 requests and the deployments behind the gateway', async () => {
    axios.get.mockImplementation((url) => {
      if (url.endsWith('/api/v1/serving')) {
        return Promise.resolve({
          data: { pods: [{ namespace: 'llm', name: 'v1', model: 'meta-llama/Llama-3.3-70B', online: true, kvCachePercent: 91, waiting: 3 }] },
        });
      }
      return Promise.resolve({
        data: {
          ...dashboard,
          summary: { ...dashboard.summary, zeroCost: 12 },
          models: [{ model: 'llama-70b', requests: 200, fallbacks: 5, failedFallbacks: 1, ttftP95Seconds: 1 }],
          deployments: [
            { model: 'hosted_vllm/meta-llama/Llama-3.3-70B', apiBase: 'http://vllm:8000', provider: 'hosted_vllm', state: 2 },
            { model: 'openai/gpt-4o', apiBase: '', provider: 'openai', state: 0 },
          ],
        },
      });
    });
    render(<TeamDashboard />);
    expect(await screen.findByText('12 requests priced at $0')).toBeInTheDocument();
    expect(screen.getByText('2.5%')).toHaveAttribute('title', '1 fallbacks failed too');
    const deployments = screen.getByText('Deployments behind the gateway').closest('section');
    expect(within(deployments).getByText('Outage')).toBeInTheDocument();
    expect(await within(deployments).findByText('91%')).toBeInTheDocument();
    expect(within(deployments).getByText('1/1')).toBeInTheDocument();
    expect(within(deployments).getByText('Not served in this cluster')).toBeInTheDocument();
  });

  test('deployments: none reported, and /serving failing', async () => {
    axios.get.mockImplementation((url) =>
      url.endsWith('/api/v1/serving')
        ? Promise.reject(new Error('x'))
        : Promise.resolve({ data: { ...dashboard, deployments: [{ model: 'a', apiBase: '', state: 0 }] } }),
    );
    const { unmount } = render(<TeamDashboard />);
    expect(await screen.findByText('Not served in this cluster')).toBeInTheDocument();
    unmount();
    axios.get.mockResolvedValue({ data: dashboard });
    render(<TeamDashboard />);
    expect(await screen.findByText('LiteLLM reports no deployment state.')).toBeInTheDocument();
  });
});
