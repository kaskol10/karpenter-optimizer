import { describe, test, expect } from 'vitest';
import {
  NO_FALLBACK_ID,
  buildFallbackMap,
  compact,
  layoutFallbackMap,
  neighbours,
  ordinal,
  reasonLabel,
  resolveGroup,
  runsOn,
  settingsLines,
  sharePct,
} from './fallbackMap';
import { routing } from '../test/routingFixture';

const ids = (nodes) => nodes.map((n) => n.id);
const link = (map, from, to) => map.links.find((l) => l.from === from && l.to === to);

describe('helpers', () => {
  test('ordinal, compact, sharePct', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '101st']);
    expect([7, 1027, 2_500_000].map(compact)).toEqual(['7', '1.0k', '2.5M']);
    expect([0.4, 4.25, 12.6].map(sharePct)).toEqual(['<1%', '4.3%', '13%']);
  });

  test('reasonLabel turns exception classes into words', () => {
    expect(reasonLabel('Hosted_vllm.ContextWindowExceededError')).toBe('Context window exceeded');
    expect(reasonLabel('RouterRateLimitError')).toBe('Router rate limit');
    expect(reasonLabel('Hosted_vllm.APIConnectionError')).toBe('Api connection');
    expect(reasonLabel('None')).toBe('Unknown error');
    expect(reasonLabel('')).toBe('Unknown error');
    expect(reasonLabel('Error')).toBe('Error');
  });

  test('resolveGroup follows aliases and wildcards', () => {
    const { config } = routing;
    expect(resolveGroup(config, 'acme/small')).toBe('acme/small');
    expect(resolveGroup(config, 'acme/old-small')).toBe('acme/small');
    expect(resolveGroup(config, 'acme/anything.else')).toBe('acme/*');
    expect(resolveGroup(config, 'other/model')).toBe('');
    expect(resolveGroup(config, 'acme/broken')).toBe('');
    expect(resolveGroup({}, 'x')).toBe('');
  });

  test('runsOn names the host and spots an external API', () => {
    const [, small, , , together, bedrock] = routing.config.groups;
    expect(runsOn(small)).toEqual({ text: '2 hosts · 2 deployments', external: false, hosts: ['vllm.acme.example', 'vllm-b.acme.example'] });
    expect(runsOn(together)).toMatchObject({ text: 'api.together.xyz', external: true });
    expect(runsOn(bedrock)).toMatchObject({ text: 'bedrock', external: true });
    expect(runsOn(undefined)).toEqual({ text: '', external: false, hosts: [] });
    expect(runsOn({ deployments: [{ model: 'x' }, { model: 'x' }] }).text).toBe('unknown · 2 deployments');
  });

  test('settingsLines says when LiteLLM moves on', () => {
    expect(settingsLines(routing.config.settings)).toEqual([
      { label: 'Retries', text: 'None: a failed request goes straight to the fallback' },
      { label: 'Cooldown', text: 'A deployment is skipped for 5 s after more than 60 failures in a minute' },
      { label: 'Timeout', text: '60 s, 120 s when streaming' },
    ]);
    expect(settingsLines({ numRetries: 2, cooldownSeconds: 30, streamTimeoutSeconds: 90, routingStrategy: 'least-busy', defaultFallbacks: ['a', 'b'] })).toEqual([
      { label: 'Retries', text: '2 retries on the same group before the fallback' },
      { label: 'Cooldown', text: 'A deployment is skipped for 30 s after repeated failures' },
      { label: 'Timeout', text: '90 s when streaming' },
      { label: 'Load balancing', text: 'least-busy' },
      { label: 'Default fallback', text: 'a → b, for groups with none of their own' },
    ]);
    expect(settingsLines({ numRetries: 1, allowedFails: 1, timeoutSeconds: 30 })).toEqual([
      { label: 'Retries', text: '1 retry on the same group before the fallback' },
      { label: 'Cooldown', text: 'A deployment is skipped for a while after more than 1 failure in a minute' },
      { label: 'Timeout', text: '30 s' },
    ]);
    expect(settingsLines()).toEqual([]);
  });
});

describe('buildFallbackMap', () => {
  test('columns: aliases, groups with a fallback plus a folded rest, targets', () => {
    const map = buildFallbackMap(routing);
    const [aliases, groups, targets] = map.columns;
    // The most shared target first; groups ordered by their first target.
    expect(ids(targets)).toEqual(['t:together/small', 't:acme/small', 't:bedrock/haiku']);
    expect(ids(groups)).toEqual(['g:acme/large', 'g:acme/small', NO_FALLBACK_ID]);
    // The alias of a folded group is not drawn; the broken one always is.
    expect(ids(aliases)).toEqual(['a:acme/old-small', 'a:acme/broken']);
    expect(aliases[1].flags).toEqual([{ text: 'Points to nothing', tone: 'bad' }]);

    const folded = groups[2];
    expect(folded).toMatchObject({ kind: 'folded', label: '1 group with no fallback', members: ['acme/embed'] });
    expect(map.totals).toEqual({ groups: 6, withFallback: 2, without: 1, used: 1061, failed: 5 });
    expect(map.hasObserved).toBe(true);
    expect(map.window).toBe('7d');
  });

  test('links carry order, kind, state and what happened', () => {
    const map = buildFallbackMap(routing);
    // Requests for the alias count for its group.
    expect(link(map, 'acme/small', 'together/small')).toMatchObject({ order: 1, state: 'used', used: 1020, failed: 0, label: '1st · 1.0k×' });
    expect(link(map, 'acme/small', 'together/small').reasons).toEqual([
      { reason: 'RouterRateLimitError', status: '429', succeeded: 620, failed: 0 },
      { reason: 'Hosted_vllm.ServiceUnavailableError', status: '503', succeeded: 400, failed: 0 },
    ]);
    expect(link(map, 'acme/small', 'bedrock/haiku')).toMatchObject({ order: 2, state: 'unused', label: '2nd' });
    expect(link(map, 'acme/large', 'acme/small')).toMatchObject({ order: 1, state: 'unused', kinds: ['context_window'], label: '1st · context window only' });
    expect(link(map, 'acme/large', 'together/small')).toMatchObject({ state: 'used', used: 41, failed: 5 });
    expect(map.links.find((l) => l.state === 'alias')).toMatchObject({ source: 'a:acme/old-small', target: 'g:acme/small' });
  });

  test('nodes say where they run, how often they fell back and what is wrong', () => {
    const map = buildFallbackMap(routing);
    const [, groups, targets] = map.columns;
    const small = groups.find((n) => n.name === 'acme/small');
    // 1,020 fallbacks of the 10,000 requests for it and its alias.
    expect(small).toMatchObject({ sub: '2 hosts · 2 deployments', fact: '1.0k fallbacks · 10% of requests', requests: 10000, flags: [] });
    const large = groups.find((n) => n.name === 'acme/large');
    expect(large.fact).toBe('41 fallbacks · 8.2% of requests');
    expect(large.flags).toEqual([{ text: '5 fallbacks failed', short: '5 failed', tone: 'bad' }]);

    expect(targets[0]).toMatchObject({ name: 'together/small', sub: 'api.together.xyz', external: true, sharedBy: 2, fact: '1.1k served in 7d' });
    expect(targets[0].flags).toEqual([
      { text: '5 failed here too', tone: 'bad' },
      { text: 'External API', tone: 'warn' },
    ]);
    expect(targets[1]).toMatchObject({ name: 'acme/small', external: false, fact: 'Not used in 7d', flags: [] });
  });

  test('showAll lists every group; a wildcard is not flagged for having no fallback', () => {
    const map = buildFallbackMap(routing, { showAll: true });
    const [aliases, groups] = map.columns;
    expect(ids(groups)).toEqual(['g:acme/large', 'g:acme/small', 'g:acme/*', 'g:acme/embed']);
    expect(groups[2].flags).toEqual([{ text: 'Wildcard: any other name', tone: '' }]);
    expect(groups[3].flags).toEqual([{ text: 'No fallback', tone: 'warn' }]);
    expect(groups[3].fact).toBe('');
    expect(ids(aliases)).toEqual(['a:acme/old-small', 'a:acme/old-embed', 'a:acme/broken']);
    expect(aliases[1].flags).toEqual([{ text: 'Hidden', tone: '' }]);
  });

  test('issues: the config ones plus what traffic and hosts show, worst first', () => {
    const { issues } = buildFallbackMap(routing);
    expect(issues.map((i) => i.severity)).toEqual(['error', 'warn', 'warn', 'info']);
    expect(issues[0].text).toContain('Alias acme/broken');
    expect(issues[2].text).toBe('5 requests failed on the fallback too in 7d: acme/large → together/small.');
    expect(issues[3].text).toBe(
      '2 fallbacks not taken in 7d (acme/small → bedrock/haiku, acme/large → acme/small): untested until the day they are needed.',
    );
  });

  test('a fallback taken that is not in the config, and one that points nowhere', () => {
    const odd = {
      config: {
        groups: [{ name: 'a', deployments: [{ model: 'openai/a', provider: 'openai', apiBase: 'https://api.together.xyz/v1' }] }],
        fallbacks: [
          { from: 'ghost', to: ['a'], kind: 'general' },
          { from: 'a', to: ['missing'], kind: 'content_policy' },
        ],
      },
      observed: { range: '24h', fallbacks: [{ from: 'a', to: 'b', succeeded: 0, failed: 1 }] },
    };
    const map = buildFallbackMap(odd);
    expect(link(map, 'a', 'b')).toMatchObject({ state: 'unconfigured', order: 0, label: 'not in config · 1×', reasons: [] });
    expect(map.issues[0]).toMatchObject({ severity: 'error', subjects: ['a'] });
    expect(map.issues[0].text).toContain('1 fallback taken that is not in this config (a → b)');
    expect(map.issues.find((i) => i.text.includes('failed on the fallback too')).text).toBe('1 request failed on the fallback too in 24h: a → b.');
    expect(map.issues.find((i) => i.text.includes('not taken')).text).toContain('2 fallbacks not taken in 24h (ghost → a, a → missing)');

    const [, groups, targets] = map.columns;
    expect(groups.find((n) => n.name === 'ghost').flags[0]).toEqual({ text: 'Not in model_list', tone: 'bad' });
    expect(groups.find((n) => n.name === 'a').flags).toEqual([
      { text: 'Fallback not in config', tone: 'bad' },
      { text: '1 fallbacks failed', short: '1 failed', tone: 'bad' },
    ]);
    // A group with fallbacks but no known request count keeps the plain count.
    expect(groups.find((n) => n.name === 'a').fact).toBe('1 fallbacks in 24h');
    expect(targets.find((t) => t.name === 'missing').flags[0]).toEqual({ text: 'Not in model_list', tone: 'bad' });
    expect(link(map, 'a', 'missing').label).toBe('1st · content policy only');
  });

  test('without traffic data, links are just configured', () => {
    const map = buildFallbackMap({ config: routing.config, observed: null });
    expect(map.hasObserved).toBe(false);
    expect(link(map, 'acme/small', 'together/small')).toMatchObject({ state: 'configured', label: '1st' });
    expect(map.columns[1][0].fact).toBe('');
    expect(map.columns[2][0].fact).toBe('2 groups');
    expect(map.columns[2][2].fact).toBe('1 group');
    expect(map.issues.some((i) => i.text.includes('not taken'))).toBe(false);
    // Only some targets are external here, so no "every fallback leaves" note.
    expect(map.issues.some((i) => i.text.includes('external API'))).toBe(false);
  });

  test('every fallback external: says where prompts go', () => {
    const config = { ...routing.config, fallbacks: [routing.config.fallbacks[1]] };
    const { issues } = buildFallbackMap({ config, observed: null });
    expect(issues.at(-1)).toMatchObject({ severity: 'info', subjects: ['together/small'] });
    expect(issues.at(-1).text).toContain('Every fallback leaves your servers for an external API (api.together.xyz)');
    const quiet = buildFallbackMap({ config, observed: { range: '24h', fallbacks: [] } });
    expect(quiet.issues.at(-1).text).toBe('1 fallback not taken in 24h (acme/large → together/small): untested until the day it is needed.');
    expect(quiet.columns[1][0].fact).toBe('No fallbacks in 24h');
  });

  test('an empty answer builds an empty map', () => {
    const map = buildFallbackMap(undefined);
    expect(map.columns).toEqual([[], [], []]);
    expect(map.links).toEqual([]);
    expect(map.totals).toEqual({ groups: 0, withFallback: 0, without: 0, used: 0, failed: 0 });
    expect(buildFallbackMap({ config: { groups: [{ name: 'a', deployments: [] }] } }).columns[1][0].label).toBe('1 group with no fallback');
  });
});

describe('neighbours and layout', () => {
  test('neighbours lights a node, its links and, from an alias, the chain', () => {
    const map = buildFallbackMap(routing);
    expect(neighbours(map, null)).toBeNull();
    const group = neighbours(map, 'g:acme/small');
    expect([...group.nodes].sort()).toEqual(['a:acme/old-small', 'g:acme/small', 't:bedrock/haiku', 't:together/small']);
    expect(group.links.size).toBe(3);
    const alias = neighbours(map, 'a:acme/old-small');
    expect(alias.nodes.has('t:together/small')).toBe(true);
    expect(alias.links.size).toBe(3);
    const target = neighbours(map, 't:together/small');
    expect([...target.nodes].sort()).toEqual(['g:acme/large', 'g:acme/small', 't:together/small']);
  });

  test('layout puts three columns, sizes used links and places labels near the source', () => {
    const map = buildFallbackMap(routing);
    const lay = layoutFallbackMap(map);
    expect(lay.colX).toEqual([0, 365, 730]);
    expect(lay.box.get('g:acme/small')).toMatchObject({ x: 365, w: 270, h: 58 });
    expect(lay.height).toBe(28 + 3 * 70);
    const busy = lay.links.find((l) => l.from === 'acme/small' && l.to === 'together/small');
    const idle = lay.links.find((l) => l.from === 'acme/small' && l.to === 'bedrock/haiku');
    const alias = lay.links.find((l) => l.state === 'alias');
    expect(busy.width).toBe(14);
    expect(idle.width).toBe(1.5);
    expect(alias.width).toBe(1.5);
    expect(busy.d).toMatch(/^M635,[\d.]+ C682.5,/);
    expect(busy.labelX).toBeGreaterThan(635);
    expect(busy.labelX).toBeLessThan(682.5);
    // Links leave a node at different heights.
    expect(new Set(lay.links.filter((l) => l.source === 'g:acme/small').map((l) => l.d.split(' ')[0])).size).toBe(2);
    expect(layoutFallbackMap(buildFallbackMap(undefined)).height).toBe(28 + 70);
  });
});
