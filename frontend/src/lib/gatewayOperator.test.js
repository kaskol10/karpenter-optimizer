import { describe, test, expect } from 'vitest';
import { deploymentRows, deploymentState, fallbackShare, gatewayLineFor, normalizeModel, sameModel } from './gatewayOperator';

describe('model names', () => {
  test('normalizeModel drops a provider prefix only', () => {
    expect(normalizeModel('hosted_vllm/meta-llama/Llama-3.3-70B')).toBe('meta-llama/llama-3.3-70b');
    expect(normalizeModel('meta-llama/Llama-3.3-70B')).toBe('meta-llama/llama-3.3-70b');
    expect(normalizeModel(' Qwen ')).toBe('qwen');
    expect(normalizeModel('')).toBe('');
    expect(normalizeModel(null)).toBe('');
  });

  test('sameModel matches across prefixes and orgs', () => {
    expect(sameModel('hosted_vllm/meta-llama/Llama-3.3-70B', 'meta-llama/llama-3.3-70b')).toBe(true);
    expect(sameModel('openai/Llama-3.3-70B', 'meta-llama/Llama-3.3-70B')).toBe(true);
    expect(sameModel('llama-70b', 'meta-llama/Llama-3.3-70B')).toBe(false);
    expect(sameModel('', 'x')).toBe(false);
  });
});

describe('deployments', () => {
  test('states and their tones', () => {
    expect(deploymentState(0)).toEqual({ label: 'Healthy', tone: '' });
    expect(deploymentState(1).tone).toBe('warn');
    expect(deploymentState(2).label).toBe('Outage');
    expect(deploymentState(7).label).toBe('Unknown');
  });

  test('rows find the serving group they route to', () => {
    const groups = [{ model: 'meta-llama/Llama-3.3-70B', kvMax: 80 }];
    const rows = deploymentRows(
      [
        { model: 'hosted_vllm/meta-llama/Llama-3.3-70B', apiBase: 'http://a', state: 1 },
        { model: 'openai/gpt-4o', apiBase: '', state: 0 },
      ],
      groups,
    );
    expect(rows[0]).toEqual(expect.objectContaining({ label: 'Partial outage', tone: 'warn', serving: groups[0] }));
    expect(rows[1].serving).toBeNull();
    expect(deploymentRows()).toEqual([]);
  });

  test('fallbackShare', () => {
    expect(fallbackShare({ requests: 200, fallbacks: 5 })).toBe(2.5);
    expect(fallbackShare({ requests: 0, fallbacks: 5 })).toBeNull();
    expect(fallbackShare({ requests: 10 })).toBeNull();
    expect(fallbackShare(null)).toBeNull();
  });
});

describe('gatewayLineFor', () => {
  const gateway = {
    models: [
      {
        model: 'meta-llama/Llama-3.3-70B',
        requestsPerSec: 4.2,
        errorRatePct: 0.3,
        teams: [{ name: 'search' }, { name: 'ads' }, { name: '(unattributed)' }],
        apps: [{ name: 'bot' }],
      },
      { model: 'qwen' },
    ],
  };

  test('sums up the gateway model a served model is reached through', () => {
    expect(gatewayLineFor('meta-llama/Llama-3.3-70B', gateway)).toEqual({
      model: 'meta-llama/Llama-3.3-70B',
      teams: 2,
      apps: 1,
      requestsPerSec: 4.2,
      errorRatePct: 0.3,
    });
    expect(gatewayLineFor('Qwen', gateway)).toEqual({ model: 'qwen', teams: 0, apps: 0, requestsPerSec: null, errorRatePct: null });
  });

  test('null when not behind the gateway', () => {
    expect(gatewayLineFor('mistral', gateway)).toBeNull();
    expect(gatewayLineFor('x', null)).toBeNull();
  });
});
