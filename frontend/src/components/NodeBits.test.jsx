import { describe, test, expect } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { GpuSummaryBadge, MetaLine, PricingSourceLabel, gpuSummaryText } from './NodeBits';
import { topologyNodes } from '../test/fixtures';

describe('gpuSummaryText', () => {
  test('HAMi nodes report the GPU memory share and GPU pod count', () => {
    expect(gpuSummaryText(topologyNodes[0])).toBe('4x L40S · 50% GPU mem · 2 GPU pods');
  });

  test('whole-GPU nodes report allocation and memory', () => {
    const node = { gpuCapacity: 8, gpuAllocated: 3, gpuModel: 'H100', gpuMemTotalMiB: 655360, gpuMemAllocatedMiB: 245760 };
    expect(gpuSummaryText(node)).toBe('8x H100 (3/8) · 240/640 GiB');
  });

  test('unknown model and memory fall back to plain counts', () => {
    expect(gpuSummaryText({ gpuCapacity: 1, gpuAllocated: 1 })).toBe('1x GPU (1/1)');
  });
});

describe('GpuSummaryBadge', () => {
  test('renders nothing for CPU-only nodes', () => {
    const { container } = render(<GpuSummaryBadge node={{ gpuCapacity: 0, gpuAllocated: 0 }} />);
    expect(container).toBeEmptyDOMElement();
  });

  test('renders the summary for GPU nodes', () => {
    render(<GpuSummaryBadge node={topologyNodes[1]} />);
    expect(screen.getByText('4x L40S · 53% GPU mem · 4 GPU pods')).toBeInTheDocument();
  });
});

describe('MetaLine', () => {
  test('joins the facts it has and skips missing ones', () => {
    render(<MetaLine items={['g6e.12xlarge', null, 'spot', '', undefined, 'eu-west-1a']} />);
    expect(screen.getByText(/g6e\.12xlarge/).textContent).toBe('g6e.12xlarge · spot · eu-west-1a');
  });

  test('renders nothing when every fact is missing', () => {
    const { container } = render(<MetaLine items={[null, '']} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('PricingSourceLabel', () => {
  test.each([
    ['aws-pricing-api', 'AWS Pricing API'],
    ['hardcoded', 'Estimated (hardcoded)'],
    ['family-estimate', 'Estimated (family-based)'],
    ['ollama-cache', 'Estimated (cached)'],
    ['ollama', 'Estimated (LLM)'],
    ['something-new', 'Estimated'],
  ])('%s reads "%s"', (source, label) => {
    render(<PricingSourceLabel source={source} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  test('renders nothing without a source', () => {
    const { container } = render(<PricingSourceLabel source={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});
