import { describe, test, expect, vi } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { SimpleSelect } from './simple-select';

const OPTIONS = [
  { value: '', label: 'All' },
  { value: 'gpu-l40s', label: 'gpu-l40s' },
];

describe('SimpleSelect', () => {
  // Radix Select throws on an item whose value is ''. That is how "All" and
  // "Off" options are modelled, and it crashed the Log Explorer before (#140).
  test('renders an option whose value is the empty string', () => {
    render(<SimpleSelect ariaLabel="NodePool" value="" onValueChange={vi.fn()} options={OPTIONS} />);
    expect(screen.getByRole('combobox', { name: 'NodePool' })).toHaveTextContent('All');
  });

  test('shows the label of a non-empty value', () => {
    render(<SimpleSelect ariaLabel="NodePool" value="gpu-l40s" onValueChange={vi.fn()} options={OPTIONS} />);
    expect(screen.getByRole('combobox', { name: 'NodePool' })).toHaveTextContent('gpu-l40s');
  });
});
