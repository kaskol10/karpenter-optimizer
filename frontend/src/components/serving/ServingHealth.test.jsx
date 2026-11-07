import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import axios from 'axios';
import ServingHealth from './ServingHealth';
import { allServingPods, topologyNodes } from '../../test/fixtures';
import { resetPollingClock } from '../../lib/pollingClock';

vi.mock('axios', () => ({ default: { get: vi.fn() } }));

const RESPONSES = {
  '/api/v1/serving': { pods: allServingPods },
  '/api/v1/serving/history': { pods: [] },
  '/api/v1/serving/gateway': { gateway: null },
  '/api/v1/topology': { nodes: topologyNodes },
};

function setUrl(search) {
  window.history.replaceState(null, '', `/${search}`);
}

// Card titles in render order.
async function cardOrder() {
  await screen.findByText('llm/llama-70b-r2');
  return screen
    .getAllByText(/^llm\//)
    .filter((el) => el.closest('[class*="rounded"]') && el.tagName !== 'BUTTON')
    .map((el) => el.textContent);
}

describe('ServingHealth', () => {
  beforeEach(() => {
    axios.get.mockImplementation((url) => {
      const path = url.replace(/^.*?(\/api\/)/, '$1').split('?')[0];
      return Promise.resolve({ data: RESPONSES[path] ?? {} });
    });
  });

  afterEach(() => {
    resetPollingClock();
    vi.clearAllMocks();
  });

  test('by default the replica that needs attention comes first', async () => {
    setUrl('?tab=serving');
    render(<ServingHealth />);
    const order = await cardOrder();
    expect(order[0]).toBe('llm/llama-70b-r2');
    expect(screen.getByRole('combobox', { name: 'Sort servers' })).toHaveTextContent('Needs attention');
  });

  test('?sort=throughput keeps the throughput order', async () => {
    setUrl('?tab=serving&sort=throughput');
    render(<ServingHealth />);
    const order = await cardOrder();
    expect(order[0]).toBe('llm/qwen3-8b-0');
    expect(order.at(-1)).toBe('llm/llama-70b-r2');
  });

  test('the metrics glossary accordion is gone; definitions live next to each metric', async () => {
    setUrl('?tab=serving');
    render(<ServingHealth />);
    await screen.findByText('llm/llama-70b-r2');
    expect(screen.queryByText('What do these metrics mean?')).not.toBeInTheDocument();
    const card = screen.getByText('llm/llama-70b-r1').closest('[class*="rounded"]');
    expect(within(card).getByRole('button', { name: 'What is KV cache?' })).toBeInTheDocument();
  });
});
