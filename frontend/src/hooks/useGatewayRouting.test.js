import { describe, test, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import axios from 'axios';
import { useGatewayRouting } from './useGatewayRouting';

vi.mock('axios', () => ({ default: { get: vi.fn() } }));

const httpError = (status, data) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });

describe('useGatewayRouting', () => {
  afterEach(() => vi.clearAllMocks());

  test('asks for the range and returns the answer', async () => {
    axios.get.mockResolvedValue({ data: { config: {} } });
    const { result } = renderHook(() => useGatewayRouting('24h'));
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(axios.get).toHaveBeenCalledWith(expect.stringMatching(/\/api\/v1\/serving\/gateway\/routing$/), { params: { range: '24h' } });
    expect(result.current.data).toEqual({ config: {} });

    const b = renderHook(() => useGatewayRouting());
    await waitFor(() => expect(b.result.current.status).toBe('ready'));
    expect(axios.get).toHaveBeenLastCalledWith(expect.any(String), { params: { range: '7d' } });
  });

  test('no config named and an older backend are unavailable', async () => {
    axios.get.mockRejectedValue(httpError(503, { code: 'litellm_config_not_configured', error: 'set LITELLM_CONFIGMAP_NAME' }));
    const a = renderHook(() => useGatewayRouting());
    await waitFor(() => expect(a.result.current.status).toBe('unavailable'));

    axios.get.mockRejectedValue(httpError(404, {}));
    const b = renderHook(() => useGatewayRouting());
    await waitFor(() => expect(b.result.current.status).toBe('unavailable'));
  });

  test('a ConfigMap that is missing or unreadable is an error with its message', async () => {
    axios.get.mockRejectedValue(httpError(404, { code: 'litellm_config_not_found', error: 'ConfigMap llm/x does not exist' }));
    const a = renderHook(() => useGatewayRouting());
    await waitFor(() => expect(a.result.current.status).toBe('error'));
    expect(a.result.current.error).toBe('ConfigMap llm/x does not exist');

    axios.get.mockRejectedValue(new Error('Network Error'));
    const b = renderHook(() => useGatewayRouting());
    await waitFor(() => expect(b.result.current.error).toBe('Network Error'));
  });

  test('keeps the last answer when a refresh fails, and drops a stale one', async () => {
    axios.get.mockResolvedValue({ data: { config: { groups: [] } } });
    const { result, rerender } = renderHook(({ range }) => useGatewayRouting(range), { initialProps: { range: '7d' } });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    axios.get.mockRejectedValue(httpError(500, { error: 'boom' }));
    await act(() => result.current.reload());
    expect(result.current.status).toBe('error');
    expect(result.current.data).toEqual({ config: { groups: [] } });

    // The answer for a range no longer selected is ignored.
    let resolveSlow;
    axios.get.mockImplementation((_url, { params }) =>
      params.range === '24h' ? new Promise((resolve) => (resolveSlow = resolve)) : Promise.resolve({ data: { config: { groups: ['30d'] } } }),
    );
    rerender({ range: '24h' });
    rerender({ range: '30d' });
    await waitFor(() => expect(result.current.data).toEqual({ config: { groups: ['30d'] } }));
    await act(async () => resolveSlow({ data: { config: { groups: ['24h'] } } }));
    expect(result.current.data).toEqual({ config: { groups: ['30d'] } });

    // So is an error for it.
    let rejectSlow;
    axios.get.mockImplementation((_url, { params }) =>
      params.range === '24h' ? new Promise((_r, reject) => (rejectSlow = reject)) : Promise.resolve({ data: { config: { groups: ['7d'] } } }),
    );
    rerender({ range: '24h' });
    rerender({ range: '7d' });
    await waitFor(() => expect(result.current.data).toEqual({ config: { groups: ['7d'] } }));
    await act(async () => rejectSlow(httpError(500, { error: 'late' })));
    expect(result.current.error).toBeNull();
  });
});
