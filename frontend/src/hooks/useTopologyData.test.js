import { describe, test, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import axios from 'axios';
import { useTopologyData } from './useTopologyData';

vi.mock('axios', () => ({ default: { get: vi.fn() } }));

const route = (table) =>
  axios.get.mockImplementation((url) => {
    const path = url.replace(/^.*?(\/api\/)/, '$1');
    const r = table[path];
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve({ data: r ?? {} });
  });
const httpError = (status, error) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data: error ? { error } : {} } });

describe('useTopologyData', () => {
  afterEach(() => vi.clearAllMocks());

  test('loads topology with currency, usage and GPU usage', async () => {
    route({ '/api/v1/topology': { nodes: [{ name: 'a' }], currency: 'CNY', usage: { source: 'prometheus' }, gpuUsage: { g: 1 } } });
    const { result } = renderHook(() => useTopologyData());
    await waitFor(() => expect(result.current.nodes).toHaveLength(1));
    expect(result.current).toEqual(expect.objectContaining({ currency: 'CNY', usageMeta: { source: 'prometheus' }, gpuUsage: { g: 1 }, loading: false, error: null }));
    expect(result.current.servingPods).toBeNull();
  });

  test('defaults when the response leaves fields out', async () => {
    route({ '/api/v1/topology': {} });
    const { result } = renderHook(() => useTopologyData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current).toEqual(expect.objectContaining({ nodes: [], currency: 'USD', usageMeta: null, gpuUsage: null }));
  });

  test('errors: the API message, an older backend, no message', async () => {
    route({ '/api/v1/topology': httpError(500, 'boom') });
    const a = renderHook(() => useTopologyData());
    await waitFor(() => expect(a.result.current.error).toBe('boom'));

    route({ '/api/v1/topology': httpError(404), '/api/v1/nodes': { nodes: [{ name: 'a' }] } });
    const b = renderHook(() => useTopologyData());
    await waitFor(() => expect(b.result.current.error).toMatch(/no \/api\/v1\/topology.*same release/));
    expect(b.result.current.nodes).toEqual([]);
    expect(axios.get).not.toHaveBeenCalledWith(expect.stringMatching(/\/api\/v1\/nodes$/));

    route({ '/api/v1/topology': new Error('') });
    const c = renderHook(() => useTopologyData());
    await waitFor(() => expect(c.result.current.error).toBe('Failed to load topology'));
  });

  test('lens data only when needed; failures become empty lists', async () => {
    route({
      '/api/v1/topology': { nodes: [] },
      '/api/v1/serving': { pods: [{ name: 's' }] },
      '/api/v1/disruptions': { disruptions: [{ nodeName: 'a' }] },
    });
    const { result } = renderHook(() => useTopologyData({ needServing: true, needDisruptions: true }));
    await waitFor(() => expect(result.current.servingPods).toHaveLength(1));
    await waitFor(() => expect(result.current.disruptions).toHaveLength(1));

    route({ '/api/v1/topology': { nodes: [] }, '/api/v1/serving': new Error('x'), '/api/v1/disruptions': new Error('y') });
    const failed = renderHook(() => useTopologyData({ needServing: true, needDisruptions: true }));
    await waitFor(() => expect(failed.result.current.servingPods).toEqual([]));
    await waitFor(() => expect(failed.result.current.disruptions).toEqual([]));

    route({ '/api/v1/topology': { nodes: [] }, '/api/v1/serving': {}, '/api/v1/disruptions': {} });
    const empty = renderHook(() => useTopologyData({ needServing: true, needDisruptions: true }));
    await waitFor(() => expect(empty.result.current.servingPods).toEqual([]));
    await waitFor(() => expect(empty.result.current.disruptions).toEqual([]));
  });
});
