import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { ChangesPanel, groupByReason } from './ChangesPanel';

const removed = (...names) => names.map((name) => ({ name }));
const gone = (node, reason) => ({ type: 'node-removed', node, reason });

describe('groupByReason', () => {
  test('groups by reason, biggest first, and tells "no event" from "not sampled yet"', () => {
    const events = [gone('a', 'Underutilized'), gone('b', 'Underutilized'), gone('c', ''), gone('d', 'Drifted')];
    expect(groupByReason(removed('a', 'b', 'c', 'd', 'e'), events)).toEqual([
      ['Underutilized', ['a', 'b']],
      ['no disruption event', ['c']],
      ['Drifted', ['d']],
      ['not sampled yet', ['e']],
    ]);
  });
});

test('ChangesPanel lists removed nodes under their reason with an explanation', () => {
  const diff = { addedNodes: [], removedNodes: removed('a', 'b', 'c'), movedPods: [], gpuShrunk: [] };
  render(<ChangesPanel diff={diff} events={[gone('a', 'Underutilized'), gone('b', 'Underutilized'), gone('c', 'SpotInterrupted')]} since="13:01" onSelectNode={() => {}} />);
  const panel = screen.getByRole('region', { name: 'Changes since' });
  expect(panel).toHaveTextContent('Removed (Underutilized ×2, SpotInterrupted ×1):');
  expect(panel).toHaveTextContent('Underutilized ×2: a, b');
  expect(screen.getByText('Underutilized')).toHaveAttribute('title', expect.stringContaining('Consolidated'));
  expect(screen.getByText('SpotInterrupted')).toHaveAttribute('title', 'AWS reclaimed the spot instance');
});

test('a removed node opens to how it went', () => {
  const local = (h, m) => new Date(2026, 10, 10, h, m).toISOString();
  const event = {
    ...gone('a', 'Underutilized'),
    at: local(12, 23),
    goneAt: local(12, 28),
    lifecycle: [
      { kind: 'disrupted', at: local(12, 22), last: local(12, 22), count: 1, message: 'Underutilized' },
      { kind: 'drain-failed', at: local(12, 22), last: local(12, 26), count: 2, message: 'Failed to drain node, 1 pods are waiting to be evicted' },
      { kind: 'removed', at: local(12, 28), last: local(12, 28), count: 1 },
    ],
  };
  const diff = { addedNodes: [], removedNodes: removed('a', 'b'), movedPods: [], gpuShrunk: [] };
  render(<ChangesPanel diff={diff} events={[event, gone('b', 'Underutilized')]} since="12:00" onSelectNode={() => {}} />);
  const panel = screen.getByRole('region', { name: 'Changes since' });
  expect(panel).toHaveTextContent('a · gone after 6 min · drain failed ×2');
  const steps = screen.getByRole('list', { name: 'How a was removed' });
  expect(steps).toHaveTextContent('12:22–12:26drain failed ×2: Failed to drain node, 1 pods are waiting to be evicted');
  expect(steps).toHaveTextContent('12:28removed from the cluster');
});
