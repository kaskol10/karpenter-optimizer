import React from 'react';
import { Button } from '../ui/button';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert';
import { ArrowLeft, Crosshair, X } from 'lucide-react';
import { findGpuNeighbours, neighbourPods, podKey } from '../../lib/servingPlacement';
import { getPodKey } from './podUtils';

// FocusBanner explains why the view jumped to a node (a deep link from the
// Serving tab or a shared URL) and who shares the focused pod's GPU.
export function FocusBanner({ focus, nodes, loading, onBack, onClear }) {
  const [ns, name] = (focus.pod || '').split('/');
  const node = nodes.find((n) => n.name === focus.node);
  const placement =
    node && name ? findGpuNeighbours({ namespace: ns, name, node: focus.node }, nodes) : null;
  const neighbours = neighbourPods(placement);
  const podMissing = node && name && !(node.pods || []).some((p) => getPodKey(p) === focus.pod);

  return (
    <Alert className="border-primary/40 bg-primary/5">
      <Crosshair className="h-4 w-4" />
      <AlertTitle className="flex flex-wrap items-center gap-x-2">
        Focused on
        {focus.pod && <span className="font-mono">{focus.pod}</span>}
        <span className="text-muted-foreground font-normal">on</span>
        <span className="font-mono">{focus.node}</span>
      </AlertTitle>
      <AlertDescription className="space-y-2">
        {!loading && !node && (
          <p>
            This node is no longer in the cluster. Karpenter may have consolidated or replaced it,
            so the pod has probably been rescheduled. Go back to Serving to see where it runs now.
          </p>
        )}
        {podMissing && <p>The pod is no longer on this node; it may have been rescheduled.</p>}
        {placement && neighbours.length > 0 && (
          <p>
            Shares {placement.shared.map((sh) => sh.gpu.label).join(', ')} with{' '}
            {neighbours.map((p, i) => (
              <span key={podKey(p)}>
                {i > 0 && ', '}
                <span className="font-mono">{podKey(p)}</span>
              </span>
            ))}
            {placement.precise ? '' : ' (single-GPU node, time-sliced)'}.
          </p>
        )}
        {placement && neighbours.length === 0 && !podMissing && (
          <p>Nothing else is placed on this pod's GPU.</p>
        )}
        <div className="flex flex-wrap gap-2 pt-1">
          {onBack && (
            <Button size="sm" variant="outline" onClick={onBack}>
              <ArrowLeft className="h-3.5 w-3.5 mr-1.5" />
              Back to Serving
            </Button>
          )}
          {onClear && (
            <Button size="sm" variant="ghost" onClick={onClear}>
              <X className="h-3.5 w-3.5 mr-1.5" />
              Clear focus
            </Button>
          )}
        </div>
      </AlertDescription>
    </Alert>
  );
}
