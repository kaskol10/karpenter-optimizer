import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import GatewayPage from './GatewayPage';

vi.mock('axios', () => ({ default: { get: vi.fn() } }));

const gateway = {
  pods: 2,
  online: true,
  inFlightRequests: 3,
  admissionQueued: 0,
  admissionRejected: 0,
  totalRequests: 1000,
  failedRequests: 4,
  errorRatePct: 0.4,
  spend: 12.5,
  models: [{ model: 'llama-70b', requestsTotal: 1000, spend: 12.5, apps: [], apiKeys: [], teams: [] }],
  apps: [{ name: 'chatbot', requestsTotal: 900, tokensTotal: 5000, tokensInput: 3000, tokensOutput: 2000, spend: 10 }],
  apiKeys: [],
  teams: [{ name: 'search', requestsTotal: 100, tokensTotal: 800, tokensInput: 500, tokensOutput: 300, spend: 2.5 }],
};

function route(gw) {
  axios.get.mockImplementation((url) => {
    if (url.endsWith('/serving/gateway')) return gw instanceof Error ? Promise.reject(gw) : Promise.resolve({ data: { gateway: gw } });
    return Promise.resolve({ data: { days: [] } });
  });
}

describe('GatewayPage', () => {
  beforeEach(() => window.history.replaceState(null, '', '/inference/gateway'));
  afterEach(() => vi.clearAllMocks());

  test('shows the gateway card; the split is a URL param', async () => {
    route(gateway);
    render(<GatewayPage />);
    expect(await screen.findByText('chatbot')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Team' }));
    expect(window.location.search).toBe('?split=team');
    expect(await screen.findByText('search')).toBeInTheDocument();
  });

  test('explains when no gateway is found or the request fails', async () => {
    route(null);
    const { unmount } = render(<GatewayPage />);
    expect(await screen.findByText('No LiteLLM gateway detected')).toBeInTheDocument();
    unmount();
    route(new Error('down'));
    render(<GatewayPage />);
    expect(await screen.findByText('No LiteLLM gateway detected')).toBeInTheDocument();
  });

  test('says when the gateway pods do not answer', async () => {
    route({ pods: 2, online: false });
    render(<GatewayPage />);
    expect(await screen.findByText('The gateway is not answering')).toBeInTheDocument();
    expect(screen.getByText(/Found 2 LiteLLM pod/)).toBeInTheDocument();
  });
});
