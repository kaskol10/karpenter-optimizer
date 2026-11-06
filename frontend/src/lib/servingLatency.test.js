import { describe, test, expect } from 'vitest';
import { latencySplit, formatSeconds } from './servingLatency';
import { allServingPods, servingPods } from '../test/fixtures';

describe('latencySplit', () => {
  test('splits mean E2E into first token and generation', () => {
    const s = latencySplit(servingPods.r1, allServingPods);
    expect(s.ttft).toBeCloseTo(0.21);
    expect(s.decode).toBeCloseTo(1.59);
    expect(s.total).toBeCloseTo(1.8);
  });

  test('replicas of one model share the slowest replica as their scale', () => {
    const fast = latencySplit(servingPods.r1, allServingPods);
    const slow = latencySplit(servingPods.r2, allServingPods);
    expect(fast.scale).toBeCloseTo(5.1);
    expect(slow.scale).toBeCloseTo(5.1);
    expect(slow.ttftPct + slow.decodePct).toBeCloseTo(100);
    expect(fast.ttftPct + fast.decodePct).toBeCloseTo((1.8 / 5.1) * 100);
  });

  test('other models do not stretch the scale', () => {
    const s = latencySplit(servingPods.qwen, allServingPods);
    expect(s.scale).toBeCloseTo(servingPods.qwen.e2eSeconds);
  });

  test('offline peers are ignored', () => {
    const offlineSlow = { ...servingPods.r3, online: false, e2eSeconds: 60 };
    const s = latencySplit(servingPods.r1, [servingPods.r1, offlineSlow]);
    expect(s.scale).toBeCloseTo(1.8);
  });

  test('a mean TTFT above the mean E2E (counter skew) is clamped', () => {
    const s = latencySplit({ ...servingPods.r1, ttftSeconds: 3, e2eSeconds: 2 });
    expect(s.ttft).toBe(2);
    expect(s.decode).toBe(0);
  });

  test('no split without both means', () => {
    expect(latencySplit({ ...servingPods.r1, ttftSeconds: null })).toBeNull();
    expect(latencySplit({ ...servingPods.r1, e2eSeconds: undefined })).toBeNull();
    expect(latencySplit({ ...servingPods.r1, e2eSeconds: 0 })).toBeNull();
  });
});

describe('formatSeconds', () => {
  test.each([
    [0.214, '0.21s'],
    [1.94, '1.9s'],
    [12.4, '12s'],
    [null, ''],
  ])('%s -> %s', (s, out) => expect(formatSeconds(s)).toBe(out));
});
