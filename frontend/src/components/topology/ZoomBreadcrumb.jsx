import React from 'react';
import { ChevronRight } from 'lucide-react';

// ZoomBreadcrumb shows where the Topology view is zoomed (Cluster ›
// NodePool › node › GPU); every step but the last zooms back out to it.
export function ZoomBreadcrumb({ steps }) {
  return (
    <nav aria-label="Zoom level" className="flex flex-wrap items-center gap-1 text-sm">
      {steps.map((step, i) => {
        const last = i === steps.length - 1;
        return (
          <React.Fragment key={step.label}>
            {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />}
            {last ? (
              <span aria-current="page" className="font-semibold font-mono">
                {step.label}
              </span>
            ) : (
              <button type="button" onClick={step.onClick} className="font-mono text-muted-foreground hover:text-foreground hover:underline">
                {step.label}
              </button>
            )}
          </React.Fragment>
        );
      })}
    </nav>
  );
}
