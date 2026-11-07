import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import axios from 'axios';
import ServingHealth from './ServingHealth';
import { allServingPods } from '../../test/fixtures';
import { resetPollingClock } from '../../lib/pollingClock';

vi.mock('axios', () => ({ default: { get: vi.fn() } }));

const RESPONSES = {
  '/api/v1/serving': { pods: allServingPods },
  '/api/v1/serving/history': { pods: [] },
  '/api/v1/serving/gateway': { gateway: null },
};

function setUrl(search) {
  window.history.replaceState(null, '', `/${search}`);
}

// Waits for the replica cards (the triage list repeats some names).
const cardsLoaded = () => screen.findAllByText('llm/llama-70b-r1');

// Card titles in render order.
async function cardOrder() {
  await cardsLoaded();
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

  test('in the replica view the replica that needs attention comes first', async () => {
    setUrl('?tab=serving&view=replicas');
    render(<ServingHealth />);
    const order = await cardOrder();
    expect(order[0]).toBe('llm/llama-70b-r2');
    expect(screen.getByRole('combobox', { name: 'Sort servers' })).toHaveTextContent('Needs attention');
  });

  test('GPU neighbours come with /serving; the tab never downloads the topology', async () => {
    setUrl('?tab=serving');
    render(<ServingHealth />);
    expect(await screen.findByText('shares c3c3c3c3 with batch/embed-worker-7f9c')).toBeInTheDocument();
    expect(axios.get.mock.calls.map(([url]) => url).filter((u) => u.includes('/topology'))).toEqual([]);
  });

  test('?sort=throughput keeps the throughput order', async () => {
    setUrl('?tab=serving&view=replicas&sort=throughput');
    render(<ServingHealth />);
    const order = await cardOrder();
    expect(order[0]).toBe('llm/qwen3-8b-0');
    expect(order.at(-1)).toBe('llm/llama-70b-r2');
  });

  test('the metrics glossary accordion is gone; definitions live next to each metric', async () => {
    setUrl('?tab=serving&view=replicas');
    render(<ServingHealth />);
    await cardsLoaded();
    expect(screen.queryByText('What do these metrics mean?')).not.toBeInTheDocument();
    const card = screen.getByText('llm/llama-70b-r1').closest('[class*="rounded"]');
    expect(within(card).getByRole('button', { name: 'What is KV cache?' })).toBeInTheDocument();
  });

  test('by default servers are grouped by model, the troubled model first and open', async () => {
    setUrl('?tab=serving');
    render(<ServingHealth />);
    const llama = await screen.findByRole('button', { name: /meta-llama/, expanded: true });
    const qwen = screen.getByRole('button', { name: /Qwen\/Qwen3-8B/, expanded: false });
    expect(llama.compareDocumentPosition(qwen) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Healthy models stay folded: their cards are not rendered until opened.
    expect(screen.queryByText('llm/qwen3-8b-0')).not.toBeInTheDocument();
    fireEvent.click(qwen);
    expect(screen.getByText('llm/qwen3-8b-0')).toBeInTheDocument();
    // The user's choice wins over "open when troubled".
    fireEvent.click(llama);
    expect(llama).toHaveAttribute('aria-expanded', 'false');
  });

  test('a replica dot opens its model row and rings its card', async () => {
    setUrl('?tab=serving');
    render(<ServingHealth />);
    fireEvent.click(await screen.findByRole('button', { name: 'llm/qwen3-8b-0: OK' }));
    const card = document.getElementById('serving-card-llm-qwen3-8b-0');
    expect(card).not.toBeNull();
    expect(card.className).toMatch(/ring-primary/);
  });

  test('the triage list names the slow replica and links to its logs', async () => {
    setUrl('?tab=serving');
    const onOpenLogs = vi.fn();
    render(<ServingHealth onOpenLogs={onOpenLogs} />);
    const triage = await screen.findByRole('region', { name: 'Needs attention' });
    expect(within(triage).getAllByRole('listitem')).toHaveLength(1);
    expect(within(triage).getByText('llm/llama-70b-r2')).toBeInTheDocument();
    fireEvent.click(within(triage).getByRole('button', { name: 'Open logs for llm/llama-70b-r2' }));
    expect(onOpenLogs).toHaveBeenCalledWith(expect.objectContaining({ name: 'llama-70b-r2' }));
  });

  test('a ?pod= deep link opens that replica and rings its card', async () => {
    setUrl('?tab=serving&pod=llm/qwen3-8b-0');
    render(<ServingHealth focusPod="llm/qwen3-8b-0" />);
    await screen.findByRole('button', { name: 'llm/qwen3-8b-0: OK' });
    const card = await waitFor(() => {
      const el = document.getElementById('serving-card-llm-qwen3-8b-0');
      expect(el).not.toBeNull();
      return el;
    });
    expect(card.className).toMatch(/ring-primary/);
  });
});
