import { describe, test, expect } from 'vitest';
import { formatMoney, modelCost, comparison, costInputsText } from './servingCost';
import { servingPods } from '../test/fixtures';

const llama = [servingPods.r1, servingPods.r2, servingPods.r3];

describe('formatMoney', () => {
  test.each([
    [1234.4, 'USD', '$1,234'],
    [12.4, 'USD', '$12.40'],
    [0.42, 'USD', '$0.42'],
    [0.0423, 'USD', '$0.042'],
    [0, 'USD', '$0'],
    [3.5, 'CNY', 'CN¥3.50'],
    [null, 'USD', '–'],
    [Infinity, 'USD', '–'],
  ])('%s %s → %s', (v, c, text) => expect(formatMoney(v, c)).toBe(text));

  test('defaults to dollars', () => expect(formatMoney(1)).toBe('$1.00'));
});

describe('modelCost', () => {
  test('sums replica costs over the model’s live token rate', () => {
    const cost = modelCost(llama);
    expect(cost.costPerHour).toBeCloseTo(7.5);
    expect(cost.tokensPerSec).toBe(710 + 260 + 710);
    expect(cost.perMTok).toBeCloseTo((7.5 / (1680 * 3600)) * 1e6);
    expect(cost.currency).toBe('USD');
    expect(cost.unknown).toBeNull();
    expect(cost.replicas[0]).toEqual(
      expect.objectContaining({ key: 'llm/llama-70b-r1', share: 0.25, instanceType: 'g6e.12xlarge', capacityType: 'on-demand' }),
    );
  });

  test('blends the hosted price by the model’s own input/output mix', () => {
    const { hosted } = modelCost(llama);
    expect(hosted.promptShare).toBeCloseTo(0.75);
    expect(hosted.blendedPerMTok).toBeCloseTo(0.75 * 0.13 + 0.25 * 0.39);
    expect(hosted.model).toBe('meta-llama/llama-3.3-70b-instruct');
  });

  test('no blended hosted price when the mix is unknown', () => {
    const pods = llama.map((p) => ({ ...p, promptTokensPerSec: null, generationTokensPerSec: null }));
    const { hosted } = modelCost(pods);
    expect(hosted.blendedPerMTok).toBeNull();
    expect(hosted.promptShare).toBeNull();
  });

  test('one unpriced replica means no total (a partial sum would understate it)', () => {
    const cost = modelCost([servingPods.r1, { ...servingPods.r2, cost: null }]);
    expect(cost.unknown).toBe('unpriced');
    expect(cost.costPerHour).toBeNull();
    expect(cost.hosted).not.toBeNull();
    expect(modelCost([]).unknown).toBe('unpriced');
  });

  test('idle models have an hourly cost but no per-token cost', () => {
    const cost = modelCost(llama.map((p) => ({ ...p, tokensPerSec: 0 })));
    expect(cost.costPerHour).toBeCloseTo(7.5);
    expect(cost.perMTok).toBeNull();
    expect(cost.unknown).toBe('no-traffic');
  });

  test('offline replicas cost money but add no tokens; missing rates count as 0', () => {
    const cost = modelCost([servingPods.offline, { ...servingPods.r1, tokensPerSec: undefined }]);
    expect(cost.costPerHour).toBeCloseTo(5);
    expect(cost.tokensPerSec).toBe(0);
  });

  test('currency defaults to USD when the backend leaves it out', () => {
    const pod = { ...servingPods.r1, cost: { ...servingPods.r1.cost, currency: '' } };
    expect(modelCost([pod]).currency).toBe('USD');
  });
});

describe('comparison', () => {
  test('self-hosted vs hosted ratio', () => {
    const vs = comparison(modelCost(llama));
    expect(vs.ratio).toBeCloseTo(((7.5 / (1680 * 3600)) * 1e6) / 0.195);
    expect(vs.cheaper).toBe(false);
    const cheap = { perMTok: 0.05, currency: 'USD', hosted: { blendedPerMTok: 0.2 } };
    expect(comparison(cheap)).toEqual({ ratio: 0.25, cheaper: true });
  });

  test('null when a side is missing or currencies differ', () => {
    expect(comparison(null)).toBeNull();
    expect(comparison({ perMTok: null })).toBeNull();
    expect(comparison({ perMTok: 1, hosted: null })).toBeNull();
    expect(comparison({ perMTok: 1, currency: 'USD', hosted: { blendedPerMTok: null } })).toBeNull();
    expect(comparison({ perMTok: 1, currency: 'CNY', hosted: { blendedPerMTok: 1 } })).toBeNull();
    expect(comparison({ perMTok: 1, currency: 'USD', hosted: { blendedPerMTok: 0 } })).toBeNull();
  });
});

describe('costInputsText', () => {
  test('lists every input of the estimate', () => {
    const text = costInputsText(modelCost(llama));
    expect(text).toContain('llm/llama-70b-r1: $2.50/h = 25% of the node’s GPUs × g6e.12xlarge at $10.00/h, AWS price list');
    expect(text).toContain('Total $7.50/h over 1680 tokens/s');
    expect(text).toContain('meta-llama/llama-3.3-70b-instruct on OpenRouter, $0.13 in / $0.39 out per 1M tokens (75% input)');
    expect(text).toContain('GPU share only');
  });

  test('spot, memory share, unknown sources and unknown mix', () => {
    const pod = {
      ...servingPods.r1,
      promptTokensPerSec: 0,
      generationTokensPerSec: 0,
      cost: { ...servingPods.r1.cost, nodeCapacityType: 'spot', shareBasis: 'gpu-memory', priceSource: 'mystery' },
    };
    const text = costInputsText(modelCost([pod]));
    expect(text).toContain('of the node’s GPU memory');
    expect(text).toContain('(spot ≈ 25% of on-demand), mystery');
    expect(text).toContain('input/output mix unknown');
    const noShareBasis = { ...pod, hostedPrice: null, cost: { ...pod.cost, shareBasis: 'other' } };
    expect(costInputsText(modelCost([noShareBasis]))).not.toContain('OpenRouter');
  });

  test('explains why nothing is shown', () => {
    expect(costInputsText(null)).toMatch(/Not every replica could be priced/);
    expect(costInputsText({ unknown: 'unpriced' })).toMatch(/Not every replica could be priced/);
  });
});
