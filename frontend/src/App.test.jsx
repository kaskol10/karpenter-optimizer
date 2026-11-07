import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import App from './App';

vi.mock('axios', () => ({ default: { get: vi.fn() } }));

// The pages are tested on their own; here they are stand-ins that show what
// App handed them and let a test press their deep-link buttons.
vi.mock('./components/GlobalClusterSummary', () => ({ default: () => <p>overview page</p> }));
vi.mock('./components/NodeUsageView', () => ({ default: () => <p>nodes page</p> }));
vi.mock('./components/DisruptionTracker', () => ({ default: () => <p>disruptions page</p> }));
vi.mock('./components/WorkloadUsageView', () => ({ default: () => <p>workloads page</p> }));
vi.mock('./components/AgentRecommendations', () => ({ default: () => <p>recommendations page</p> }));
vi.mock('./components/serving/GatewayPage', () => ({ default: () => <p>gateway page</p> }));
vi.mock('./components/CommandPalette', () => ({
  isPaletteShortcut: (e) => (e.metaKey || e.ctrlKey) && e.key === 'k',
  CommandPalette: ({ open, onOpenChange, onRun: run }) => {
    const onRun = (r) => {
      onOpenChange(false);
      run(r);
    };
    return open ? (
      <div role="dialog" aria-label="Command palette">
        <button type="button" onClick={() => onRun({ type: 'navigate', page: 'topology', params: { drain: 'n2' } })}>
          run drain
        </button>
        <button type="button" onClick={() => onRun({ type: 'logs', pod: 'llm/x' })}>
          run logs
        </button>
        <button type="button" onClick={() => onRun({ type: 'theme' })}>
          run theme
        </button>
      </div>
    ) : null;
  },
}));
vi.mock('./components/LogExplorer', () => ({ default: ({ seedPod }) => <p>log explorer on {seedPod || 'picker'}</p> }));
vi.mock('./components/topology/TopologyView', () => ({
  default: ({ focus, onOpenLogs, onOpenServing }) => (
    <div>
      <p>topology page{focus ? ` focused on ${focus.node}` : ''}</p>
      <p>topology url {window.location.search}</p>
      <button type="button" onClick={() => onOpenLogs({ namespace: 'llm', name: 'vllm-0' })}>
        topology logs
      </button>
      <button type="button" onClick={() => onOpenServing({ namespace: 'llm', name: 'vllm-0' })}>
        topology serving
      </button>
    </div>
  ),
}));
vi.mock('./components/serving/ServingHealth', () => ({
  default: ({ focusPod, onOpenTopology }) => (
    <div>
      <p>serving page{focusPod ? ` focused on ${focusPod}` : ''}</p>
      <button type="button" onClick={() => onOpenTopology({ node: 'n1', pod: 'llm/vllm-0', gpu: '' })}>
        serving topology
      </button>
    </div>
  ),
}));

const setUrl = (url) => window.history.replaceState(null, '', url);
const here = () => `${window.location.pathname}${window.location.search}`;

describe('App navigation', () => {
  beforeEach(() => {
    axios.get.mockImplementation((url) =>
      Promise.resolve({ data: url.endsWith('/disruptions') ? { summary: { blockedCount: 2, activeCount: 1 } } : { kubernetes: { connected: true }, karpenter: { detected: true } } }),
    );
    setUrl('/');
  });
  afterEach(() => vi.clearAllMocks());

  test('three areas, each with its pages, and a new tagline', async () => {
    render(<App />);
    expect(screen.getByText('Karpenter capacity and GPU inference operations')).toBeInTheDocument();
    const areas = screen.getByRole('navigation', { name: 'Areas' });
    expect(within(areas).getAllByRole('link').map((a) => a.textContent.replace(/\d+$/, ''))).toEqual(['Cluster', 'Inference', 'Optimize']);
    const pages = screen.getByRole('navigation', { name: 'Cluster pages' });
    expect(within(pages).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['/', '/cluster/nodes', '/cluster/topology', '/cluster/disruptions']);
    expect(await screen.findByText('overview page')).toBeInTheDocument();
    // The disruption count shows on the Cluster area and the Disruptions page.
    expect(await within(areas).findByText('3')).toBeInTheDocument();
    expect(within(pages).getByRole('link', { name: /^Disruptions\s*3$/ })).toBeInTheDocument();
  });

  test('pages are paths; an area remembers its last page', async () => {
    render(<App />);
    await userEvent.click(screen.getByRole('link', { name: 'Topology' }));
    expect(here()).toBe('/cluster/topology');
    expect(await screen.findByText('topology page')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('link', { name: 'Inference' }));
    expect(here()).toBe('/inference/serving');
    await userEvent.click(within(screen.getByRole('navigation', { name: 'Inference pages' })).getByRole('link', { name: 'Gateway' }));
    expect(await screen.findByText('gateway page')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('link', { name: /Cluster/ }));
    expect(here()).toBe('/cluster/topology');
    await userEvent.click(screen.getByRole('link', { name: 'Optimize' }));
    expect(await screen.findByText('recommendations page')).toBeInTheDocument();

    // Back follows the history.
    await act(async () => {
      window.history.back();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(await screen.findByText('topology page')).toBeInTheDocument();
  });

  test('old ?tab= links land on the new page and the address is rewritten', async () => {
    setUrl('/?tab=topology&node=n1&lens=cost');
    render(<App />);
    expect(await screen.findByText('topology page focused on n1')).toBeInTheDocument();
    expect(here()).toBe('/cluster/topology?node=n1&lens=cost');
  });

  test('the old Logs tab opens the log drawer instead', async () => {
    setUrl('/?tab=logs&pod=llm/vllm-0');
    render(<App />);
    const drawer = await screen.findByRole('dialog', { name: /Logs/ });
    expect(within(drawer).getByText('log explorer on llm/vllm-0')).toBeInTheDocument();
    expect(here()).toBe('/?logs=llm%2Fvllm-0');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Close logs' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(here()).toBe('/');
  });

  test('logs open in a drawer over the page you are on', async () => {
    setUrl('/cluster/topology?zoom=node');
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'topology logs' }));
    const drawer = await screen.findByRole('dialog', { name: /Logs/ });
    expect(within(drawer).getByText('log explorer on llm/vllm-0')).toBeInTheDocument();
    expect(await screen.findByText('topology page')).toBeInTheDocument();
    expect(here()).toBe('/cluster/topology?zoom=node&logs=llm%2Fvllm-0');

    // Closing steps back, so Back does not reopen the drawer.
    await userEvent.keyboard('{Escape}');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(here()).toBe('/cluster/topology?zoom=node');

    // The header button opens the picker.
    await userEvent.click(screen.getByRole('button', { name: 'Logs' }));
    expect(await screen.findByText('log explorer on picker')).toBeInTheDocument();
  });

  test('Serving and Topology deep-link into each other with focus', async () => {
    setUrl('/inference/serving');
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'serving topology' }));
    expect(await screen.findByText('topology page focused on n1')).toBeInTheDocument();
    expect(here()).toBe('/cluster/topology?node=n1&pod=llm%2Fvllm-0');
    await userEvent.click(await screen.findByRole('button', { name: 'topology serving' }));
    expect(await screen.findByText('serving page focused on llm/vllm-0')).toBeInTheDocument();
    expect(here()).toBe('/inference/serving?pod=llm%2Fvllm-0');
  });

  test('⌘K opens the palette; its jumps reload the page with the new params', async () => {
    setUrl('/cluster/topology?zoom=gpu&card=x');
    render(<App />);
    expect(await screen.findByText('topology url ?zoom=gpu&card=x')).toBeInTheDocument();
    await userEvent.keyboard('{Control>}k{/Control}');
    await userEvent.click(screen.getByRole('button', { name: 'run drain' }));
    expect(here()).toBe('/cluster/topology?drain=n2');
    expect(await screen.findByText('topology url ?drain=n2')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Search/ }));
    await userEvent.click(screen.getByRole('button', { name: 'run logs' }));
    expect(await screen.findByText('log explorer on llm/x')).toBeInTheDocument();
  });

  test('the palette can switch the theme, and ⌘K toggles it closed', async () => {
    render(<App />);
    const dark = document.documentElement.classList.contains('dark');
    await userEvent.keyboard('{Meta>}k{/Meta}');
    await userEvent.click(screen.getByRole('button', { name: 'run theme' }));
    expect(document.documentElement.classList.contains('dark')).toBe(!dark);
    await userEvent.keyboard('{Meta>}k{/Meta}');
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    await userEvent.keyboard('{Meta>}k{/Meta}');
    expect(screen.queryByRole('dialog', { name: 'Command palette' })).not.toBeInTheDocument();
  });
});
