import React from 'react';
import { AlertTriangle, Check, Gpu } from 'lucide-react';
import { Badge } from './ui/badge';
import { cn } from '../lib/utils';

// Small pieces shared by the node views (Nodes tab, Topology) and the cost
// summaries, so each fact is shown the same way everywhere.

// MetaLine renders secondary facts as one quiet line ("g6e.12xlarge · spot ·
// eu-west-1b") instead of a row of badges. Falsy items are skipped, so
// callers can pass optional facts directly.
export function MetaLine({ items, className }) {
  const parts = items.filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <p className={cn('text-xs text-muted-foreground', className)}>
      {parts.map((part, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span aria-hidden="true"> · </span>}
          {part}
        </React.Fragment>
      ))}
    </p>
  );
}

// gpuSummaryText describes a node's GPUs. On HAMi nodes (fractional GPUs) the
// memory share is the meaningful number, since whole-GPU counts mislead.
export function gpuSummaryText(node) {
  const cards = `${node.gpuCapacity || 0}x ${node.gpuModel || 'GPU'}`;
  const memKnown = (node.gpuMemTotalMiB || 0) > 0;
  if (node.hamiDetected && memKnown) {
    const pct = Math.min(Math.round((node.gpuMemAllocatedMiB / node.gpuMemTotalMiB) * 100), 100);
    return `${cards} · ${pct}% GPU mem · ${node.gpuPods || 0} GPU pods`;
  }
  let text = `${cards} (${node.gpuAllocated || 0}/${node.gpuCapacity || 0})`;
  if (memKnown) {
    text += ` · ${(node.gpuMemAllocatedMiB / 1024).toFixed(0)}/${(node.gpuMemTotalMiB / 1024).toFixed(0)} GiB`;
  }
  return text;
}

// GpuSummaryBadge is the one badge a GPU node header carries: card count and
// model, plus memory or allocation. Renders nothing for CPU-only nodes.
export function GpuSummaryBadge({ node }) {
  if (!(node.gpuCapacity > 0 || node.gpuAllocated > 0)) return null;
  return (
    <Badge variant="outline" className="gap-1 border-purple-500 text-purple-700 dark:text-purple-300" title={node.gpuModel || 'GPU'}>
      <Gpu className="h-3.5 w-3.5" aria-hidden="true" />
      {gpuSummaryText(node)}
    </Badge>
  );
}

const PRICING_SOURCE_LABELS = {
  'aws-pricing-api': 'AWS Pricing API',
  hardcoded: 'Estimated (hardcoded)',
  'family-estimate': 'Estimated (family-based)',
  'ollama-cache': 'Estimated (cached)',
  ollama: 'Estimated (LLM)',
};

// PricingSourceLabel says where a cost figure came from: live AWS pricing
// (check) or an estimate (warning), with the kind of estimate.
export function PricingSourceLabel({ source, className }) {
  if (!source) return null;
  const live = source === 'aws-pricing-api';
  const Icon = live ? Check : AlertTriangle;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 font-semibold',
        live ? 'text-green-700 dark:text-green-400' : 'text-yellow-700 dark:text-yellow-400',
        className,
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {PRICING_SOURCE_LABELS[source] || 'Estimated'}
    </span>
  );
}
