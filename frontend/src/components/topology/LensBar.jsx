import React from 'react';
import { cn } from '../../lib/utils';
import { LENSES, lensLegend } from '../../lib/topologyLenses';

// LensBar picks how node tiles are coloured and always shows what the
// colours mean.
export function LensBar({ lens, onChange }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="flex flex-wrap rounded-md border p-0.5" role="group" aria-label="Colour nodes by">
        {LENSES.map((l) => (
          <button
            key={l.id}
            type="button"
            onClick={() => onChange(l.id)}
            aria-pressed={lens === l.id}
            className={cn(
              'rounded px-2 py-1 text-xs',
              lens === l.id ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/50',
            )}
          >
            {l.label}
          </button>
        ))}
      </div>
      <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground" aria-label="Legend">
        {lensLegend(lens).map((item, i) => (
          <li key={`${item.fill}-${i}`} className="flex items-center gap-1">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: item.fill }} aria-hidden="true" />
            {item.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
