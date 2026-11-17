import { describe, test, expect } from 'vitest';
import {
  OTHER,
  OTHER_COLOR,
  MODEL_COLORS,
  RANGE_VALUES,
  budgetLine,
  count,
  duration,
  errorShare,
  errorTone,
  failedPanels,
  money,
  pct,
  seconds,
  selectOptions,
  spendChart,
  tokenChart,
} from './teamDashboard';

describe('spendChart', () => {
  test('pivots days by model, biggest spender darkest', () => {
    const { rows, series, total } = spendChart([
      { day: '2026-11-02', model: 'small', value: 1 },
      { day: '2026-11-01', model: 'big', value: 5 },
      { day: '2026-11-02', model: 'big', value: 4 },
    ]);
    expect(rows).toEqual([
      { day: '2026-11-01', big: 5 },
      { day: '2026-11-02', small: 1, big: 4 },
    ]);
    expect(series).toEqual([
      { key: 'big', color: MODEL_COLORS[0] },
      { key: 'small', color: MODEL_COLORS[1] },
    ]);
    expect(total).toBe(10);
  });

  test('folds models past six into Other models; ties sort by name', () => {
    const data = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((m, i) => ({ day: '2026-11-01', model: m, value: i < 2 ? 1 : 10 - i }));
    const { rows, series } = spendChart(data);
    expect(series.map((s) => s.key)).toEqual(['c', 'd', 'e', 'f', 'g', OTHER]);
    expect(series.at(-1).color).toBe(OTHER_COLOR);
    expect(rows[0][OTHER]).toBe(2);
  });

  test('empty input', () => {
    expect(spendChart()).toEqual({ rows: [], series: [], total: 0 });
  });
});

describe('tokenChart', () => {
  test('lists only the kinds with data', () => {
    const { rows, kinds } = tokenChart([
      { day: '2026-11-01', input: 10, output: 5 },
      { day: '2026-11-02', input: 12, cached: null, output: 6 },
    ]);
    expect(kinds).toEqual(['input', 'output']);
    expect(rows[0]).toEqual({ day: '2026-11-01', input: 10, cached: null, output: 5 });
    expect(tokenChart().kinds).toEqual([]);
  });
});

describe('formatters', () => {
  test('money', () => {
    expect(money(null)).toBe('—');
    expect(money(0)).toBe('$0.00');
    expect(money(0.004)).toBe('<$0.01');
    expect(money(1234.5)).toBe('$1,234.50');
  });

  test('count', () => {
    expect(count(undefined)).toBe('—');
    expect(count(999.4)).toBe('999');
    expect(count(1234)).toBe('1.2k');
    expect(count(45000)).toBe('45k');
    expect(count(2500000)).toBe('2.50M');
    expect(count(25000000)).toBe('25.0M');
    expect(count(3.2e9)).toBe('3.20B');
  });

  test('pct, seconds, duration', () => {
    expect(pct(null)).toBe('—');
    expect(pct(0.05)).toBe('0.05%');
    expect(pct(2.345)).toBe('2.3%');
    expect(pct(0)).toBe('0.0%');
    expect(seconds(null)).toBe('—');
    expect(seconds(0.25)).toBe('250 ms');
    expect(seconds(1.5)).toBe('1.50 s');
    expect(duration(null)).toBeNull();
    expect(duration(0.001)).toBe('1 min');
    expect(duration(0.5)).toBe('30 min');
    expect(duration(5)).toBe('5 h');
    expect(duration(76)).toBe('3 d 4 h');
    expect(duration(48)).toBe('2 d');
  });
});

describe('budgetLine', () => {
  test('share left, amounts and reset; tone by share', () => {
    expect(budgetLine(null)).toBeNull();
    expect(budgetLine({ remaining: 50, max: 100, remainingShare: 0.5, hoursToReset: 30 })).toEqual({
      value: '50%',
      detail: '$50.00 of $100.00 · resets in 1 d 6 h',
      tone: '',
    });
    expect(budgetLine({ remaining: 10, max: 100, remainingShare: 0.1 }).tone).toBe('warn');
    expect(budgetLine({ remaining: 0, max: 100, remainingShare: 0 }).tone).toBe('bad');
    expect(budgetLine({ remaining: 7 })).toEqual({ value: '$7.00', detail: '', tone: '' });
  });
});

describe('small helpers', () => {
  test('errorTone and errorShare', () => {
    expect(errorTone(null)).toBe('');
    expect(errorTone(0.5)).toBe('');
    expect(errorTone(1)).toBe('warn');
    expect(errorTone(5)).toBe('bad');
    expect(errorShare(1, 0)).toBeNull();
    expect(errorShare(undefined, 10)).toBe(0);
    expect(errorShare(2, 10)).toBe(20);
  });

  test('failedPanels names panels readably, unknown ones as is', () => {
    expect(failedPanels(undefined)).toEqual([]);
    expect(failedPanels({ spendByDay: 'x', budget: 'y', other: 'z' })).toEqual([
      { panel: 'budget', error: 'y' },
      { panel: 'other', error: 'z' },
      { panel: 'spend per day', error: 'x' },
    ]);
  });

  test('selectOptions keeps a value the window no longer lists', () => {
    expect(selectOptions(['a'], '', 'All teams')).toEqual([
      { value: '', label: 'All teams' },
      { value: 'a', label: 'a' },
    ]);
    expect(selectOptions(['a'], 'gone').map((o) => o.value)).toEqual(['', 'gone', 'a']);
    expect(selectOptions(undefined, 'a').map((o) => o.value)).toEqual(['', 'a']);
    expect(RANGE_VALUES).toEqual(['month', '24h', '7d', '30d']);
  });
});
