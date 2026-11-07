import { describe, test, expect } from 'vitest';
import {
  fitLine,
  replicaHeadroom,
  modelHeadroom,
  headroomText,
  MAX_HEADROOM_PCT,
} from './servingHeadroom';

// n samples a minute apart where KV % = a + b × req/s, req/s cycling 1..4.
function series(n, { a = 20, b = 10, noise = 0, last = {} } = {}) {
  const pts = Array.from({ length: n }, (_, i) => {
    const rps = 1 + (i % 4);
    const jitter = noise ? (Math.floor(i / 4) % 2 === 0 ? noise : -noise) : 0;
    return { unix: 1000 + i * 60, online: true, waiting: 0, requestsPerSec: rps, kvCachePercent: a + b * rps + jitter };
  });
  Object.assign(pts[n - 1], last);
  return pts;
}

describe('fitLine', () => {
  test('recovers an exact line', () => {
    const fit = fitLine([1, 2, 3], [12, 14, 16]);
    expect(fit.a).toBeCloseTo(10);
    expect(fit.b).toBeCloseTo(2);
    expect(fit.r2).toBeCloseTo(1);
  });

  test('null when x never varies or there are too few points; r2 0 for flat y', () => {
    expect(fitLine([2, 2, 2], [1, 2, 3])).toBeNull();
    expect(fitLine([1], [1])).toBeNull();
    expect(fitLine([1, 2, 3], [5, 5, 5]).r2).toBe(0);
  });
});

describe('replicaHeadroom', () => {
  test('projects the request rate at the KV threshold', () => {
    // KV = 20 + 10·rps → 85% at 6.5 req/s; the last sample runs at 4 req/s.
    const h = replicaHeadroom(series(40));
    expect(h.rpsAtLimit).toBeCloseTo(6.5);
    expect(h.currentRps).toBe(4);
    expect(h.pct).toBeCloseTo(62.5);
    expect(h.capped).toBe(false);
    expect(h.points).toBe(40);
  });

  test('needs 30 minutes and 10 usable samples', () => {
    expect(replicaHeadroom(undefined).reason).toBe('short-history');
    expect(replicaHeadroom(series(9)).reason).toBe('short-history');
    expect(replicaHeadroom(series(20)).reason).toBe('short-history'); // 19 minutes
    const gappy = series(40).map((p, i) => (i % 2 ? { ...p, online: false } : p));
    expect(replicaHeadroom(gappy).pct).not.toBeNull();
  });

  test('no headroom when already queueing or at the threshold', () => {
    expect(replicaHeadroom(series(40, { last: { waiting: 2 } }))).toEqual({ pct: 0, reason: 'at-limit' });
    expect(replicaHeadroom(series(40, { last: { kvCachePercent: 90 } }))).toEqual({ pct: 0, reason: 'at-limit' });
  });

  test('idle, flat and noisy histories give no estimate', () => {
    expect(replicaHeadroom(series(40, { last: { requestsPerSec: 0 } })).reason).toBe('idle');
    expect(replicaHeadroom(series(40, { b: 0 })).reason).toBe('flat');
    expect(replicaHeadroom(series(40, { b: -2, a: 60 })).reason).toBe('flat');
    expect(replicaHeadroom(series(40, { b: 1, noise: 20 })).reason).toBe('noisy');
  });

  test('large projections are capped', () => {
    const h = replicaHeadroom(series(40, { a: 1, b: 0.5 }));
    expect(h.pct).toBe(MAX_HEADROOM_PCT);
    expect(h.capped).toBe(true);
  });
});

describe('modelHeadroom', () => {
  const pod = (name) => ({ namespace: 'llm', name });

  test('the tightest replica sets the model’s headroom', () => {
    const history = {
      'llm/a': { points: series(40) }, // +62.5%
      'llm/b': { points: series(40, { a: 30 }) }, // 85% at 5.5 → +37.5%
      'llm/c': { points: series(5) }, // too short, ignored
    };
    const h = modelHeadroom([pod('a'), pod('b'), pod('c')], history);
    expect(h.pct).toBeCloseTo(37.5);
    expect(h.limitedBy).toBe('llm/b');
    expect(h.replicas).toHaveLength(3);
  });

  test('a replica at the limit wins', () => {
    const history = { 'llm/a': { points: series(40) }, 'llm/b': { points: series(40, { last: { waiting: 1 } }) } };
    const h = modelHeadroom([pod('a'), pod('b')], history);
    expect(h).toEqual(expect.objectContaining({ pct: 0, reason: 'at-limit', limitedBy: 'llm/b' }));
  });

  test('a replica queueing or under KV pressure right now means no headroom', () => {
    const history = { 'llm/a': { points: series(40) } };
    const queueing = { ...pod('b'), online: true, waiting: 3 };
    expect(modelHeadroom([pod('a'), queueing], history)).toEqual(
      expect.objectContaining({ pct: 0, reason: 'at-limit', limitedBy: 'llm/b' }),
    );
    const full = { ...pod('b'), online: true, kvCachePercent: 91 };
    expect(modelHeadroom([pod('a'), full], history).limitedBy).toBe('llm/b');
    const offline = { ...pod('b'), online: false, waiting: 3 };
    expect(modelHeadroom([pod('a'), offline], history).pct).toBeCloseTo(62.5);
  });

  test('no estimate: the first replica explains why', () => {
    expect(modelHeadroom([pod('a')], {}).reason).toBe('short-history');
    expect(modelHeadroom([], {}).reason).toBe('short-history');
    expect(modelHeadroom([pod('a')]).pct).toBeNull();
  });
});

describe('headroomText', () => {
  test('estimate with its inputs', () => {
    const h = modelHeadroom([{ namespace: 'llm', name: 'a' }], { 'llm/a': { points: series(40) } });
    const { label, title } = headroomText(h);
    expect(label).toBe('+63%');
    expect(title).toContain('before llm/a reaches 85% KV cache (4.00 → 6.50 req/s on that replica)');
    expect(title).toContain('40 samples (R² 1.00)');
  });

  test('capped, at the limit, and no estimate', () => {
    const capped = headroomText({ pct: 300, capped: true, limitedBy: 'x', currentRps: 1, rpsAtLimit: 9, r2: 0.9, points: 30 });
    expect(capped.label).toBe('>+300%');
    expect(capped.title).toMatch(/^Estimate: more than \+300% more traffic/);
    expect(headroomText({ pct: 0, reason: 'at-limit', limitedBy: 'llm/b' })).toEqual({
      label: 'none',
      title: 'llm/b is already queueing or at 85% KV cache.',
    });
    expect(headroomText({ pct: 0, reason: 'at-limit' }).title).toMatch(/^A replica/);
    expect(headroomText({ pct: null, reason: 'noisy' }).title).toMatch(/too loosely related/);
    expect(headroomText({ pct: null, reason: 'other' }).title).toMatch(/30 minutes/);
  });
});
