import { describe, test, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { readZoom, zoomSearch, useTopologyZoom } from './useTopologyZoom';

const setUrl = (search) => window.history.replaceState(null, '', `/${search}`);

describe('readZoom', () => {
  test.each([
    ['', { zoom: 'cluster', at: '', card: '', explicit: false }],
    ['?zoom=cluster&at=x', { zoom: 'cluster', at: '', card: '', explicit: true }],
    ['?zoom=pool&at=gpu', { zoom: 'pool', at: 'gpu', card: '', explicit: true }],
    ['?zoom=pool', { zoom: 'cluster', at: '', card: '', explicit: true }],
    ['?zoom=node', { zoom: 'node', at: '', card: '', explicit: true }],
    ['?zoom=node&at=n1&card=c', { zoom: 'node', at: 'n1', card: '', explicit: true }],
    ['?zoom=gpu&at=n1&card=GPU-1', { zoom: 'gpu', at: 'n1', card: 'GPU-1', explicit: true }],
    ['?zoom=gpu&at=n1', { zoom: 'node', at: 'n1', card: '', explicit: true }],
    ['?zoom=gpu', { zoom: 'cluster', at: '', card: '', explicit: true }],
    ['?zoom=bogus', { zoom: 'cluster', at: '', card: '', explicit: true }],
  ])('%s', (search, want) => {
    setUrl(search);
    expect(readZoom()).toEqual(want);
  });
});

test('zoomSearch keeps other params and drops a focus link', () => {
  setUrl('?tab=topology&lens=cost&node=n&pod=a/b&gpu=g&zoom=pool&at=p');
  expect(zoomSearch({ zoom: 'gpu', at: 'n1', card: 'GPU-1' })).toBe('/?tab=topology&lens=cost&zoom=gpu&at=n1&card=GPU-1');
  expect(zoomSearch({ zoom: 'cluster', at: 'ignored' })).toBe('/?tab=topology&lens=cost&zoom=cluster');
  expect(zoomSearch({})).toBe('/?tab=topology&lens=cost&zoom=cluster');
  setUrl('');
  expect(zoomSearch({ zoom: 'node' })).toBe('/?zoom=node');
});

test('useTopologyZoom pushes one history entry per level and follows Back', () => {
  setUrl('?tab=topology');
  const { result } = renderHook(() => useTopologyZoom());
  expect(result.current[0].zoom).toBe('cluster');
  const before = window.history.length;

  act(() => result.current[1]({ zoom: 'pool', at: 'gpu' }));
  expect(result.current[0]).toEqual(expect.objectContaining({ zoom: 'pool', at: 'gpu' }));
  expect(window.history.length).toBe(before + 1);

  // Going to the same place adds no entry.
  act(() => result.current[1]({ zoom: 'pool', at: 'gpu' }));
  expect(window.history.length).toBe(before + 1);

  act(() => {
    window.history.replaceState(null, '', '/?tab=topology&zoom=node&at=n1');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  expect(result.current[0]).toEqual(expect.objectContaining({ zoom: 'node', at: 'n1' }));
});
