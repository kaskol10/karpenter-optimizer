import React, { useEffect, useMemo, useState } from 'react';
import { History, Loader2, Radio, X } from 'lucide-react';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';
import { eventMarkers, eventText, formatAgo, formatClock, markerTone } from '../../lib/topologyHistory';

const MODES = [
  { id: 'replay', label: 'Replay' },
  { id: 'compare', label: 'Compare with now' },
];

// TimeScrubber is the Topology timeline: a slider over the recorded history
// with node launches (green), terminations (red) and pod moves (amber)
// marked along it. Replay shows the cluster as it was; Compare keeps the
// live view and outlines what changed since the chosen moment.
export function TimeScrubber({ history, now = Date.now() }) {
  const { range, events, at, compare, setAt, setCompare, backToLive, close, loaded, available, error } = history;
  const mode = compare ? 'compare' : 'replay';
  const selected = at || compare;
  const [draft, setDraft] = useState(selected);
  useEffect(() => setDraft(selected), [selected]);

  const from = range?.from;
  const to = range?.to;
  const markers = useMemo(() => eventMarkers(events, from, to), [events, from, to]);
  const step = range?.intervalSeconds || 60;

  const choose = (t) => (mode === 'compare' ? setCompare(t) : setAt(t));
  const switchMode = (next) => {
    if (next === mode) return;
    // Nothing picked yet: start an hour back (or at the oldest sample).
    const t = selected || Math.max(from, to - 3600);
    if (next === 'compare') setCompare(t);
    else setAt(t);
  };

  let body;
  if (!loaded) {
    body = (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading history…
      </p>
    );
  } else if (!available) {
    body = (
      <p className="text-xs text-muted-foreground">
        This backend keeps no placement history. Upgrade it, or check that <code>PLACEMENT_HISTORY_HOURS</code> is not 0.
      </p>
    );
  } else if (error) {
    body = <p className="text-xs text-destructive">{error}</p>;
  } else if (!range || range.samples < 2) {
    body = (
      <p className="text-xs text-muted-foreground">
        History starts when the backend starts: one sample every {Math.round(step / 60) || 1} min. Check back in a few minutes.
      </p>
    );
  } else {
    body = (
      <div className="space-y-1.5">
        <div className="relative h-3" aria-label="Changes on the timeline">
          {markers.map((m) => (
            <button
              key={m.pos}
              type="button"
              onClick={() => choose(Math.round(m.at))}
              title={`${formatClock(m.at, now)}\n${m.events.slice(0, 6).map(eventText).join('\n')}${m.events.length > 6 ? `\n… ${m.events.length - 6} more` : ''}`}
              aria-label={`${formatClock(m.at, now)}: ${m.added} launched, ${m.removed} removed, ${m.moved} moved`}
              className={cn('absolute top-0 h-3 w-1.5 -translate-x-1/2 rounded-sm hover:scale-125', markerTone(m))}
              style={{ left: `${m.pos * 100}%` }}
            />
          ))}
        </div>
        <input
          type="range"
          className="w-full accent-primary"
          aria-label={mode === 'compare' ? 'Compare with' : 'Replay time'}
          min={from}
          max={to}
          step={step}
          value={draft || to}
          onChange={(e) => {
            const t = Number(e.target.value);
            setDraft(t);
            choose(t);
          }}
        />
        <div className="flex justify-between text-[11px] text-muted-foreground">
          <span>{formatClock(from, now)}</span>
          <span>{formatClock(to, now)}</span>
        </div>
      </div>
    );
  }

  return (
    <section className="space-y-2 rounded-lg border px-3 py-2.5" aria-label="Time travel">
      <div className="flex flex-wrap items-center gap-2">
        <History className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <div className="flex rounded-md border p-0.5" role="group" aria-label="Time travel mode">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => switchMode(m.id)}
              aria-pressed={selected ? mode === m.id : false}
              className={cn(
                'rounded px-2 py-1 text-xs',
                selected && mode === m.id ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/50',
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
        <span className="text-xs" aria-live="polite">
          {selected ? (
            <>
              {mode === 'compare' ? 'Changes since ' : 'Viewing '}
              <strong>{formatClock(draft || selected, now)}</strong>
              <span className="text-muted-foreground"> ({formatAgo(draft || selected, now)})</span>
            </>
          ) : (
            <span className="text-muted-foreground">Live. Pick a moment to replay or compare.</span>
          )}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {selected && (
            <Button variant="outline" size="sm" onClick={backToLive}>
              <Radio className="mr-1.5 h-3.5 w-3.5" /> Back to live
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={close} aria-label="Close time travel">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {body}
    </section>
  );
}
