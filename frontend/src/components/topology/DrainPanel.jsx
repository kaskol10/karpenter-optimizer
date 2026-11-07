import React from 'react';
import { ArrowRight, FlaskConical, X } from 'lucide-react';
import { formatMoney } from '../../lib/servingCost';
import { NOT_MODELLED } from '../../lib/drainSim';
import { cardPhrase } from '../../lib/gpuFit';

const key = (p) => `${p.namespace}/${p.name}`;

// DrainPanel shows a drain simulation (lib/drainSim.js): which nodes are
// drained, where each pod would land, what does not fit, and the monthly
// saving. Always labelled approximate, with what it does not model.
export function DrainPanel({ result, onRemove, onClear, onSelectNode }) {
  const moved = result.moves.length;
  const failed = result.unplaced.length;
  return (
    <section aria-label="Drain simulation" className="rounded-lg border border-sky-300 bg-sky-50/60 p-3 text-sm dark:border-sky-500/40 dark:bg-sky-500/5">
      <div className="flex flex-wrap items-center gap-2">
        <FlaskConical className="h-4 w-4 text-sky-600" aria-hidden="true" />
        <h3 className="font-semibold">Drain simulation</h3>
        <span className="rounded border border-sky-300 px-1.5 text-[10px] font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-300">approximate</span>
        <ul className="flex flex-wrap gap-1" aria-label="Nodes to drain">
          {result.drained.map((n) => (
            <li key={n} className="inline-flex items-center gap-1 rounded-full border bg-card px-2 py-0.5 font-mono text-xs">
              {n}
              <button type="button" onClick={() => onRemove(n)} aria-label={`Stop simulating ${n}`} className="rounded-full hover:bg-muted">
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
        <button type="button" onClick={onClear} className="ml-auto text-xs text-muted-foreground hover:text-foreground hover:underline">
          Clear
        </button>
      </div>

      <p className="mt-2">
        {moved} pod{moved === 1 ? '' : 's'} would move
        {failed > 0 ? (
          <span className="font-semibold text-red-700 dark:text-red-400">
            , {failed} would not fit anywhere
          </span>
        ) : (
          ', and everything fits'
        )}
        {result.goesWithNode.length > 0 && <>; {result.goesWithNode.length} DaemonSet pod{result.goesWithNode.length === 1 ? ' goes' : 's go'} with the node</>}.
        {result.savingsPerMonth != null && (
          <>
            {' '}
            Removing {result.drained.length === 1 ? 'it' : 'them'} saves about{' '}
            <span className="font-semibold">{formatMoney(result.savingsPerMonth, result.currency)}/month</span> ({formatMoney(result.savingsPerHour, result.currency)}/h).
          </>
        )}
      </p>

      {failed > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-red-700 dark:text-red-400" aria-label="Pods that would not fit">
          {result.unplaced.map((u) => (
            <li key={key(u.pod)}>
              <span className="font-mono">{key(u.pod)}</span> from {u.from}: {u.reason}
            </li>
          ))}
        </ul>
      )}

      {moved > 0 && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer select-none text-muted-foreground">Where each pod would land</summary>
          <ul className="mt-1 max-h-56 space-y-0.5 overflow-y-auto" aria-label="Pod moves">
            {result.moves.map((m) => (
              <li key={key(m.pod)} className="flex flex-wrap items-center gap-1">
                <span className="font-mono">{key(m.pod)}</span>
                <ArrowRight className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                <button type="button" onClick={() => onSelectNode(m.to)} className="font-mono underline-offset-2 hover:underline">
                  {m.to}
                </button>
                {m.gpus.length > 0 && <span className="text-muted-foreground">(on {m.gpus.map(cardPhrase).join(', ')})</span>}
                {!m.samePool && <span className="text-amber-700 dark:text-amber-400">· other NodePool</span>}
              </li>
            ))}
          </ul>
        </details>
      )}

      <p className="mt-2 text-[11px] text-muted-foreground">
        First fit on CPU, memory and per-GPU memory requests. Not modelled: {NOT_MODELLED.join(', ')}.
      </p>
    </section>
  );
}
