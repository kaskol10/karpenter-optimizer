import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import { FallbackMap } from './FallbackMap';
import { FallbackCard } from './FallbackCard';
import { routing } from '../../test/routingFixture';

vi.mock('axios', () => ({ default: { get: vi.fn() } }));

const httpError = (status, data) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });

describe('FallbackMap', () => {
  test('summary, settings, issues and the three columns', () => {
    render(<FallbackMap routing={routing} />);
    expect(screen.getByText(/of 6 model groups have a fallback/)).toHaveTextContent(
      '2 of 6 model groups have a fallback · 1.1k fallbacks taken in 7d · 5 failed there too',
    );
    expect(screen.getByLabelText('When LiteLLM falls back')).toHaveTextContent('RetriesNone: a failed request goes straight to the fallback');
    const issues = screen.getByRole('list', { name: 'Things to look at' });
    expect(within(issues).getAllByRole('listitem')).toHaveLength(4);
    expect(issues).toHaveTextContent('1 model group has no fallback');

    const svg = screen.getByRole('group', { name: 'Fallback map' });
    ['Also asked for as', 'Model group', 'Falls back to'].forEach((c) => expect(within(svg).getByText(c)).toBeInTheDocument());
    expect(within(svg).getByRole('button', { name: /^acme\/small, 2 hosts · 2 deployments, 1\.0k fallbacks · 10% of requests$/ })).toBeInTheDocument();
    expect(within(svg).getByRole('button', { name: /^together\/small, api\.together\.xyz, 1\.1k served in 7d, 5 failed here too, External API$/ })).toBeInTheDocument();
    expect(within(svg).getByText('1st · 1.0k×')).toBeInTheDocument();
    expect(within(svg).getByText('1st · context window only')).toBeInTheDocument();
    expect(screen.getByText('taken (width = how often)')).toBeInTheDocument();
    expect(screen.getByText('configured, never taken')).toBeInTheDocument();
  });

  test('a group opens its chain with why each fallback was taken', async () => {
    render(<FallbackMap routing={routing} />);
    const svg = screen.getByRole('group', { name: 'Fallback map' });
    // acme/small is also a (context window) target: pick the group node.
    const small = within(svg).getByRole('button', { name: /^acme\/small,.*of requests$/ });
    await userEvent.click(small);
    expect(small).toHaveAttribute('aria-pressed', 'true');
    // The taken link gets the marching ants; unrelated nodes dim.
    expect(screen.getAllByTestId('ants')).toHaveLength(1);
    expect(within(svg).getByRole('button', { name: /^acme\/large,/ })).toHaveClass('opacity-20');

    const details = screen.getByRole('region', { name: 'Details for acme/small' });
    expect(details).toHaveTextContent('When it fails, LiteLLM tries');
    const hops = within(details).getAllByRole('listitem').filter((li) => li.textContent.startsWith('1st') || li.textContent.startsWith('2nd'));
    expect(hops[0]).toHaveTextContent('1sttogether/smallconfigured and taken');
    expect(hops[0]).toHaveTextContent('Router rate limit · 429620–');
    expect(hops[0]).toHaveTextContent('Service unavailable · 503400–');
    expect(hops[1]).toHaveTextContent('2ndbedrock/haikuconfigured, never taken in this window');
    expect(details).toHaveTextContent('Load-balanced over 2 deployments');
    expect(details).toHaveTextContent('hosted_vllm/Qwen/Small · https://vllm-b.acme.example/v1');
    expect(details).toHaveTextContent('Also asked for asacme/old-small');

    await userEvent.click(within(details).getByRole('button', { name: 'Close details' }));
    expect(screen.queryByRole('region', { name: 'Details for acme/small' })).not.toBeInTheDocument();
  });

  test('a target lists who falls back to it; an alias says what it is; the keyboard works', () => {
    render(<FallbackMap routing={routing} />);
    const svg = screen.getByRole('group', { name: 'Fallback map' });
    fireEvent.keyDown(within(svg).getByRole('button', { name: /^together\/small,/ }), { key: 'Enter' });
    const target = screen.getByRole('region', { name: 'Details for together/small' });
    expect(target).toHaveTextContent('Fallback for');
    expect(target).toHaveTextContent('1stacme/largeconfigured and taken');
    expect(target).toHaveTextContent('Context window exceeded · 400415');
    expect(target).toHaveTextContent('External API');
    expect(target).toHaveTextContent('Deployment');

    fireEvent.keyDown(within(svg).getByRole('button', { name: /^acme\/old-small/ }), { key: ' ' });
    expect(screen.getByRole('region', { name: 'Details for acme/old-small' })).toHaveTextContent('Another name for acme/small');
    fireEvent.keyDown(within(svg).getByRole('button', { name: /^acme\/broken/ }), { key: 'Enter' });
    expect(screen.getByRole('region', { name: 'Details for acme/broken' })).toHaveTextContent('Points to nowhere/model, which is not in model_list');
    // Another key does nothing; the same key again closes.
    fireEvent.keyDown(within(svg).getByRole('button', { name: /^acme\/broken/ }), { key: 'a' });
    expect(screen.getByRole('region', { name: 'Details for acme/broken' })).toBeInTheDocument();
    fireEvent.keyDown(within(svg).getByRole('button', { name: /^acme\/broken/ }), { key: 'Enter' });
    expect(screen.queryByRole('region', { name: 'Details for acme/broken' })).not.toBeInTheDocument();
  });

  test('the folded groups open, say they have no fallback, and fold again', async () => {
    render(<FallbackMap routing={routing} />);
    const svg = screen.getByRole('group', { name: 'Fallback map' });
    await userEvent.click(within(svg).getByRole('button', { name: '1 group with no fallback: acme/embed. Show them all' }));
    await userEvent.click(within(svg).getByRole('button', { name: /^acme\/embed,/ }));
    expect(screen.getByRole('region', { name: 'Details for acme/embed' })).toHaveTextContent('Nothing: the request fails with the error of its deployment.');
    expect(within(svg).getByRole('button', { name: /^acme\/\*,.*Wildcard: any other name$/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Hide groups with no fallback' }));
    expect(within(svg).getByRole('button', { name: /1 group with no fallback/ })).toBeInTheDocument();
    fireEvent.keyDown(within(svg).getByRole('button', { name: /1 group with no fallback/ }), { key: 'Enter' });
    expect(within(svg).getByRole('button', { name: /^acme\/embed,/ })).toBeInTheDocument();
  });

  test('without traffic data it draws the config alone; with no fallbacks it says so', () => {
    const { unmount } = render(<FallbackMap routing={{ ...routing, observed: null }} />);
    expect(screen.getByText(/of 6 model groups have a fallback/)).toHaveTextContent(/^2 of 6 model groups have a fallback$/);
    expect(screen.getByText('configured fallback')).toBeInTheDocument();
    expect(screen.queryByText('configured, never taken')).not.toBeInTheDocument();
    unmount();

    render(<FallbackMap routing={{ config: { groups: routing.config.groups, aliases: [], fallbacks: [], settings: {}, issues: [] }, observed: null }} />);
    expect(screen.getByText('No fallbacks are configured: every failure is returned to the caller.')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Fallback map' })).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Things to look at' })).not.toBeInTheDocument();
  });
});

describe('FallbackCard', () => {
  beforeEach(() => window.history.replaceState(null, '', '/inference/gateway'));
  afterEach(() => vi.clearAllMocks());

  test('shows the map, where the config came from and a range that lives in the URL', async () => {
    axios.get.mockResolvedValue({ data: routing });
    render(<FallbackCard />);
    expect(await screen.findByRole('group', { name: 'Fallback map' })).toBeInTheDocument();
    expect(screen.getByText('llm/litellm-config')).toBeInTheDocument();
    expect(axios.get).toHaveBeenLastCalledWith(expect.any(String), { params: { range: '7d' } });
    await userEvent.click(within(screen.getByRole('group', { name: 'Fallbacks taken in' })).getByRole('button', { name: '24h' }));
    expect(window.location.search).toBe('?fallbacks=24h');
    expect(axios.get).toHaveBeenLastCalledWith(expect.any(String), { params: { range: '24h' } });
  });

  test('says why the fallbacks taken are missing', async () => {
    axios.get.mockResolvedValue({ data: { ...routing, observed: null } });
    const a = render(<FallbackCard />);
    expect(await screen.findByText(/set PROMETHEUS_URL to also see the fallbacks taken/)).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Fallbacks taken in' })).not.toBeInTheDocument();
    a.unmount();

    axios.get.mockResolvedValue({ data: { ...routing, observed: null, observedError: 'prometheus is down' } });
    render(<FallbackCard />);
    expect(await screen.findByText(/fallbacks taken are not shown: prometheus is down/)).toBeInTheDocument();
  });

  test('not set up: says how; an unreadable ConfigMap: the error and a retry', async () => {
    axios.get.mockRejectedValue(httpError(503, { code: 'litellm_config_not_configured' }));
    const a = render(<FallbackCard />);
    expect(await screen.findByText(/Name the ConfigMap that holds the LiteLLM/)).toBeInTheDocument();
    expect(screen.getByText('litellmConfig.configMapName')).toBeInTheDocument();
    a.unmount();

    axios.get.mockRejectedValue(httpError(403, { code: 'litellm_config_forbidden', error: 'not allowed to read ConfigMap llm/x' }));
    render(<FallbackCard />);
    expect(await screen.findByRole('alert')).toHaveTextContent('not allowed to read ConfigMap llm/x');
    axios.get.mockResolvedValue({ data: routing });
    await userEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(await screen.findByRole('group', { name: 'Fallback map' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    // A failed refresh keeps the map and says so.
    axios.get.mockRejectedValue(httpError(500, { error: 'boom' }));
    await userEvent.click(within(screen.getByRole('group', { name: 'Fallbacks taken in' })).getByRole('button', { name: '30d' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not refresh: boom');
    expect(screen.getByRole('group', { name: 'Fallback map' })).toBeInTheDocument();
  });
});
