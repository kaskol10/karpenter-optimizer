import { describe, test, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { readUrlParam, useUrlParam, writeUrlParam } from './useUrlParam';

function setUrl(search) {
  window.history.replaceState({ from: 'serving' }, '', `/${search}`);
}

describe('useUrlParam', () => {
  beforeEach(() => setUrl('?tab=topology&node=n1'));

  test('reads a param, falling back when absent or not allowed', () => {
    setUrl('?tab=topology&metric=memory&bad=zzz');
    expect(readUrlParam('metric', 'cpu', ['cpu', 'memory'])).toBe('memory');
    expect(readUrlParam('missing', 'x')).toBe('x');
    expect(readUrlParam('bad', 'cpu', ['cpu', 'memory'])).toBe('cpu');
  });

  test('writes in place, keeping other params and history state', () => {
    const before = window.history.length;
    writeUrlParam('pool', 'gpu', '');
    expect(window.location.search).toBe('?tab=topology&node=n1&pool=gpu');
    expect(window.history.state).toEqual({ from: 'serving' });
    expect(window.history.length).toBe(before);
  });

  test('removes the param when set back to its default or emptied', () => {
    setUrl('?tab=topology&pool=gpu&metric=memory');
    writeUrlParam('pool', '', '');
    writeUrlParam('metric', 'cpu', 'cpu');
    expect(window.location.search).toBe('?tab=topology');
  });

  test('the hook starts from the URL and keeps state and URL in sync', () => {
    setUrl('?tab=serving&sort=queue');
    const { result } = renderHook(() => useUrlParam('sort', 'throughput', ['throughput', 'queue', 'name']));
    expect(result.current[0]).toBe('queue');
    act(() => result.current[1]('name'));
    expect(result.current[0]).toBe('name');
    expect(window.location.search).toBe('?tab=serving&sort=name');
    act(() => result.current[1]((prev) => (prev === 'name' ? 'throughput' : prev)));
    expect(result.current[0]).toBe('throughput');
    expect(window.location.search).toBe('?tab=serving');
  });
});
