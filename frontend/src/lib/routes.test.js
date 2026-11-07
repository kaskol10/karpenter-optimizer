import { describe, test, expect } from 'vitest';
import { AREAS, HOME, areaOf, buildUrl, logsParam, pagePath, parseLocation } from './routes';

describe('areas and paths', () => {
  test('three areas, every page in exactly one', () => {
    expect(AREAS.map((a) => a.id)).toEqual(['cluster', 'inference', 'optimize']);
    const pages = AREAS.flatMap((a) => a.pages.map((p) => p.id));
    expect(new Set(pages).size).toBe(pages.length);
    expect(pages).toContain(HOME);
  });

  test.each([
    ['overview', '/'],
    ['topology', '/cluster/topology'],
    ['serving', '/inference/serving'],
    ['gateway', '/inference/gateway'],
    ['workloads', '/optimize/workloads'],
    ['nope', '/'],
  ])('pagePath(%s) = %s', (page, path) => expect(pagePath(page)).toBe(path));

  test('areaOf falls back to the first area', () => {
    expect(areaOf('serving').id).toBe('inference');
    expect(areaOf('nope').id).toBe('cluster');
  });
});

describe('buildUrl', () => {
  test('focus, kept filters and the drawer', () => {
    expect(buildUrl('topology', { focus: { node: 'n1', pod: 'llm/a', gpu: 'GPU-1' } })).toBe('/cluster/topology?node=n1&pod=llm%2Fa&gpu=GPU-1');
    expect(buildUrl('serving', { focus: { pod: 'llm/a' }, logs: 'llm/a' })).toBe('/inference/serving?pod=llm%2Fa&logs=llm%2Fa');
    // Page filters are kept; old focus, tab and drawer params are not copied from keep.
    expect(buildUrl('topology', { keep: '?zoom=node&node=old&tab=x&logs=y&lens=cost' })).toBe('/cluster/topology?zoom=node&lens=cost');
    expect(buildUrl('overview', { logs: '' })).toBe('/?logs=');
    expect(buildUrl('overview')).toBe('/');
  });
});

describe('parseLocation', () => {
  test('canonical paths with focus and drawer', () => {
    expect(parseLocation('/cluster/topology', '?node=n1&pod=llm/a&zoom=node')).toEqual({
      page: 'topology',
      focus: { node: 'n1', pod: 'llm/a', gpu: '' },
      logs: null,
      redirect: null,
    });
    expect(parseLocation('/inference/serving', '?pod=llm/a&logs=')).toEqual({ page: 'serving', focus: { pod: 'llm/a' }, logs: '', redirect: null });
    expect(parseLocation('/', '')).toEqual({ page: 'overview', focus: null, logs: null, redirect: null });
    expect(parseLocation('/optimize/workloads', '?pod=x').focus).toBeNull();
  });

  test('old ?tab= links redirect to the new paths, keeping focus and filters', () => {
    expect(parseLocation('/', '?tab=topology&node=n1&gpu=G&lens=cost')).toEqual({
      page: 'topology',
      focus: { node: 'n1', pod: '', gpu: 'G' },
      logs: null,
      redirect: '/cluster/topology?node=n1&gpu=G&lens=cost',
    });
    expect(parseLocation('/', '?tab=serving&pod=llm/a&sort=name').redirect).toBe('/inference/serving?pod=llm%2Fa&sort=name');
    expect(parseLocation('/', '?tab=overview').redirect).toBe('/');
    expect(parseLocation('/', '?tab=unknown&x=1').redirect).toBe('/?x=1');
  });

  test('the old Logs tab becomes the drawer on the home page', () => {
    expect(parseLocation('/', '?tab=logs&pod=llm/a')).toEqual({ page: 'overview', focus: null, logs: 'llm/a', redirect: '/?logs=llm%2Fa' });
    expect(parseLocation('/', '?tab=logs')).toEqual(expect.objectContaining({ logs: '', redirect: '/?logs=' }));
  });

  test('non-canonical paths redirect', () => {
    expect(parseLocation('/cluster', '')).toEqual({ page: 'overview', focus: null, logs: null, redirect: '/' });
    expect(parseLocation('/inference', '?logs=a/b')).toEqual(expect.objectContaining({ page: 'serving', redirect: '/inference/serving?logs=a%2Fb' }));
    expect(parseLocation('/optimize/serving', '').redirect).toBe('/');
    expect(parseLocation('/what', '').redirect).toBe('/');
    expect(parseLocation('/cluster/topology/extra', '?lens=age')).toEqual(expect.objectContaining({ page: 'topology', redirect: '/cluster/topology?lens=age' }));
    expect(parseLocation()).toEqual({ page: 'overview', focus: null, logs: null, redirect: null });
  });
});

describe('logsParam', () => {
  test.each([
    [null, ''],
    ['', ''],
    ['llm/a', 'llm/a'],
    [{ namespace: 'llm', name: 'a' }, 'llm/a'],
    [{ namespace: 'llm' }, 'llm'],
    [{}, ''],
  ])('%j → %s', (pod, want) => expect(logsParam(pod)).toBe(want));
});
