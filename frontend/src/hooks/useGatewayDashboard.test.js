import { describe, test, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import axios from 'axios';
import { useGatewayDashboard } from './useGatewayDashboard';

vi.mock('axios', () => ({ default: { get: vi.fn() } }));

const httpError = (status, data) => Object.assign(new Error(`HTTP ${status}`), { response: { status, data } });

describe('useGatewayDashboard', () => {
  afterEach(() => vi.clearAllMocks());

  test('sends only the filters that are set', async () => {
    axios.get.mockResolvedValue({ data: { summary: {} } });
    const { result } = renderHook(() => useGatewayDashboard({ team: 'search', range: '7d' }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(axios.get).toHaveBeenCalledWith(expect.stringMatching(/\/api\/v1\/serving\/gateway\/dashboard$/), {
      params: { range: '7d', team: 'search' },
    });
    expect(result.current.data).toEqual({ summary: {} });

    const b = renderHook(() => useGatewayDashboard({ model: 'm', key: 'k' }));
    await waitFor(() => expect(b.result.current.status).toBe('ready'));
    expect(axios.get).toHaveBeenLastCalledWith(expect.any(String), { params: { range: 'month', model: 'm', key: 'k' } });
  });

  test('no Prometheus, an older backend, other errors', async () => {
    axios.get.mockRejectedValue(httpError(503, { code: 'prometheus_not_configured', error: 'set PROMETHEUS_URL' }));
    const a = renderHook(() => useGatewayDashboard({}));
    await waitFor(() => expect(a.result.current.status).toBe('unavailable'));
    expect(a.result.current.error).toBe('set PROMETHEUS_URL');

    axios.get.mockRejectedValue(httpError(404, {}));
    const b = renderHook(() => useGatewayDashboard({}));
    await waitFor(() => expect(b.result.current.status).toBe('unavailable'));

    axios.get.mockRejectedValue(httpError(500, { error: 'boom' }));
    const c = renderHook(() => useGatewayDashboard({}));
    await waitFor(() => expect(c.result.current.error).toBe('boom'));
    expect(c.result.current.status).toBe('error');

    axios.get.mockRejectedValue(new Error('network'));
    const d = renderHook(() => useGatewayDashboard({}));
    await waitFor(() => expect(d.result.current.error).toBe('network'));
  });

  test('keeps the last answer on error and drops answers for an old filter', async () => {
    let resolveOld;
    axios.get.mockImplementationOnce(() => new Promise((r) => { resolveOld = r; }));
    axios.get.mockResolvedValueOnce({ data: { team: 'b' } });
    const { result, rerender } = renderHook((p) => useGatewayDashboard(p), { initialProps: { team: 'a' } });
    rerender({ team: 'b' });
    await waitFor(() => expect(result.current.data).toEqual({ team: 'b' }));
    resolveOld({ data: { team: 'a' } });
    await Promise.resolve();
    expect(result.current.data).toEqual({ team: 'b' });

    axios.get.mockRejectedValueOnce(httpError(500, { error: 'later' }));
    await result.current.reload();
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.data).toEqual({ team: 'b' });

    // A stale failure is dropped too.
    let rejectOld;
    axios.get.mockImplementationOnce(() => new Promise((_, r) => { rejectOld = r; }));
    axios.get.mockResolvedValueOnce({ data: { team: 'c' } });
    rerender({ team: 'x' });
    rerender({ team: 'c' });
    await waitFor(() => expect(result.current.data).toEqual({ team: 'c' }));
    rejectOld(httpError(500, { error: 'stale' }));
    await Promise.resolve();
    expect(result.current.status).toBe('ready');
  });
});
