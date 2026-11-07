import { describe, test, expect } from 'vitest';
import { buildFlow, topFlows } from './gatewayFlow';

const gateway = {
  models: [
    {
      model: 'llama-70b',
      apps: [
        { name: 'chatbot', tokensTotal: 6000, spend: 6 },
        { name: 'search', tokensTotal: 1000, spend: 1 },
      ],
      teams: [{ name: 'core', tokensTotal: 7000, spend: 7 }],
    },
    {
      model: 'qwen-7b',
      apps: [
        { name: 'chatbot', tokensTotal: 2000, spend: 0.5 },
        { name: 'batch', tokensTotal: 0, spend: 0 },
      ],
    },
  ],
};

describe('buildFlow', () => {
  test('sources then targets, largest first, links weighted by tokens', () => {
    const flow = buildFlow(gateway);
    expect(flow.nodes.map((n) => `${n.side}:${n.name}:${n.total}`)).toEqual([
      'source:chatbot:8000',
      'source:search:1000',
      'target:llama-70b:7000',
      'target:qwen-7b:2000',
    ]);
    expect(flow.links).toEqual([
      { source: 0, target: 2, value: 6000 },
      { source: 0, target: 3, value: 2000 },
      { source: 1, target: 2, value: 1000 },
    ]);
    expect(flow.total).toBe(9000);
    expect(flow.folded).toEqual({ sources: 0, targets: 0 });
  });

  test('spend and other dimensions; zero and missing values are dropped', () => {
    const spend = buildFlow(gateway, { metric: 'spend' });
    expect(spend.total).toBe(7.5);
    expect(spend.links[0]).toEqual({ source: 0, target: 2, value: 6 });

    const teams = buildFlow(gateway, { dimField: 'teams', noun: 'team' });
    expect(teams.nodes.map((n) => n.name)).toEqual(['core', 'llama-70b']);
    expect(buildFlow(gateway, { metric: 'nonsense' }).total).toBe(9000);
    expect(buildFlow({ models: [{ model: 'm', apps: [{ name: 'a', tokensTotal: 'x' }] }] }).links).toEqual([]);
  });

  test('folds small sources and targets into "Other" nodes', () => {
    const many = {
      models: ['m1', 'm2', 'm3'].map((model, mi) => ({
        model,
        apps: ['a', 'b', 'c', 'd'].map((name, ai) => ({ name, tokensTotal: (4 - ai) * 100 + (3 - mi) })),
      })),
    };
    const flow = buildFlow(many, { maxSources: 3, maxTargets: 2 });
    expect(flow.nodes.map((n) => n.name)).toEqual(['a', 'b', '2 other apps', 'm1', '2 other models']);
    expect(flow.nodes.filter((n) => n.other).map((n) => n.side)).toEqual(['source', 'target']);
    expect(flow.folded).toEqual({ sources: 2, targets: 2 });
    // Folding keeps the total.
    expect(flow.total).toBe(buildFlow(many).total);
    // One folded name reads in the singular; maxSources of 1 still keeps one.
    expect(buildFlow(many, { maxSources: 4, maxTargets: 1 }).nodes.map((n) => n.name)).toEqual(['a', 'b', 'c', 'd', 'm1', '2 other models']);
    expect(buildFlow(many, { maxSources: 4 - 0, maxTargets: 3 }).folded.targets).toBe(0);
    const twoModels = { models: many.models.slice(0, 2) };
    expect(buildFlow(twoModels, { maxTargets: 1 }).nodes.map((n) => n.name)).toContain('1 other model');
  });

  test('ties are ordered by name; no gateway gives an empty flow', () => {
    const tie = { models: [{ model: 'm', apps: [{ name: 'z', tokensTotal: 5 }, { name: 'a', tokensTotal: 5 }] }] };
    expect(buildFlow(tie).nodes.map((n) => n.name)).toEqual(['a', 'z', 'm']);
    expect(buildFlow(null)).toEqual({ nodes: [], links: [], total: 0, folded: { sources: 0, targets: 0 } });
    expect(buildFlow({ models: [{ model: 'm' }] }).nodes).toEqual([]);
  });
});

describe('topFlows', () => {
  test('largest links with their share of the total', () => {
    const rows = topFlows(buildFlow(gateway), 2);
    expect(rows).toEqual([
      { from: 'chatbot', to: 'llama-70b', value: 6000, share: 6000 / 9000 },
      { from: 'chatbot', to: 'qwen-7b', value: 2000, share: 2000 / 9000 },
    ]);
    expect(topFlows(buildFlow(null))).toEqual([]);
    expect(topFlows({ nodes: [{ name: 'a' }, { name: 'b' }], links: [{ source: 0, target: 1, value: 0 }], total: 0 })[0].share).toBe(0);
  });
});
