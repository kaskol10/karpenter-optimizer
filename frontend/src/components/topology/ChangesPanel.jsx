import React from 'react';
import { formatMiB } from '../../lib/gpuFit';
import { diffSummary, lifecycleBrief, lifecycleSteps } from '../../lib/topologyHistory';

const LIST_LIMIT = 8;

function NodeLinks({ names, onSelectNode }) {
  return (
    <span className="inline-flex flex-wrap gap-x-2">
      {names.slice(0, LIST_LIMIT).map((name) => (
        <button key={name} type="button" className="font-mono hover:underline" onClick={() => onSelectNode(name)}>
          {name}
        </button>
      ))}
      {names.length > LIST_LIMIT && <span className="text-muted-foreground">+{names.length - LIST_LIMIT} more</span>}
    </span>
  );
}

// What a Karpenter disruption reason means, for the tooltip.
const REASON_HINTS = {
  Underutilized: 'Consolidated: its pods fit on other nodes, so Karpenter removed it to save cost',
  Empty: 'Consolidated: no workload pods were left on it',
  Drifted: 'Replaced: it no longer matched its NodePool or NodeClass',
  Expired: 'Replaced: it reached the NodePool expireAfter',
  SpotInterrupted: 'AWS reclaimed the spot instance',
  InstanceUnhealthy: 'AWS reported the instance as unhealthy',
  InstanceTerminating: 'The instance was terminated; no disruption decision was seen before it',
  InstanceStopping: 'The instance was stopped; no disruption decision was seen before it',
};
const NO_EVENT = 'no disruption event';
const NOT_SAMPLED = 'not sampled yet';
const GROUP_HINTS = {
  [NO_EVENT]: 'No Karpenter disruption or interruption event was found for it: removed by hand, by another controller, or its events had already expired',
  [NOT_SAMPLED]: 'It left after the last history sample; the reason appears at the next one',
};

// groupByReason groups removed nodes by why they went, biggest group first.
// A node with no removal event in the timeline yet left after the last
// sample; one whose event has no reason had no Karpenter event at all.
export function groupByReason(removed, events) {
  const reasonOf = new Map(events.filter((e) => e.type === 'node-removed').map((e) => [e.node, e.reason || NO_EVENT]));
  const groups = new Map();
  removed.forEach((n) => {
    const r = reasonOf.get(n.name) || NOT_SAMPLED;
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(n.name);
  });
  return Array.from(groups.entries()).sort((a, b) => b[1].length - a[1].length);
}

// RemovedNode is one removed node: its name with how it went in a few words
// ("gone after 6 min · drain failed ×4"), opening to every step with its
// time. A node with no lifecycle (older history) is just its name.
function RemovedNode({ name, event }) {
  const steps = event ? lifecycleSteps(event) : [];
  if (!steps.length) return <span className="font-mono">{name}</span>;
  return (
    <details className="group">
      <summary className="cursor-pointer">
        <span className="font-mono">{name}</span>{' '}
        <span className="text-muted-foreground">· {lifecycleBrief(event)}</span>
      </summary>
      <ol className="mb-1 ml-4 mt-0.5 space-y-0.5 border-l pl-2.5" aria-label={`How ${name} was removed`}>
        {steps.map((st) => (
          <li key={st.kind} className={st.kind === 'drain-failed' ? 'text-amber-700 dark:text-amber-400' : undefined}>
            <span className="mr-1.5 tabular-nums text-muted-foreground">{st.when}</span>
            {st.text}
          </li>
        ))}
      </ol>
    </details>
  );
}

function RemovedGroup({ reason, names, eventOf }) {
  const unknown = reason === NO_EVENT || reason === NOT_SAMPLED;
  const detailed = names.some((n) => eventOf.get(n)?.lifecycle?.length);
  return (
    <li>
      <span
        className={unknown ? 'italic text-muted-foreground' : 'font-medium'}
        title={REASON_HINTS[reason] || GROUP_HINTS[reason]}
      >
        {reason}
      </span>{' '}
      ×{names.length}:{' '}
      {detailed ? (
        <ul className="ml-3.5 mt-0.5 space-y-0.5">
          {names.slice(0, LIST_LIMIT).map((n) => (
            <li key={n}>
              <RemovedNode name={n} event={eventOf.get(n)} />
            </li>
          ))}
          {names.length > LIST_LIMIT && <li className="text-muted-foreground">+{names.length - LIST_LIMIT} more</li>}
        </ul>
      ) : (
        <span className="font-mono">
          {names.slice(0, LIST_LIMIT).join(', ')}
          {names.length > LIST_LIMIT ? ` +${names.length - LIST_LIMIT} more` : ''}
        </span>
      )}
    </li>
  );
}

// ChangesPanel lists what changed between the compare moment and now: new
// and removed nodes (with Karpenter's reason when it was seen), pods that
// moved, and GPUs whose largest free slice shrank.
export function ChangesPanel({ diff, events = [], since, onSelectNode }) {
  const groups = groupByReason(diff.removedNodes, events);
  const eventOf = new Map(events.filter((e) => e.type === 'node-removed').map((e) => [e.node, e]));
  const single = groups.length === 1 && groups[0][1].length === 1 ? groups[0][1][0] : null;
  return (
    <section className="space-y-1.5 rounded-lg border border-dashed px-3 py-2.5 text-xs" aria-label="Changes since">
      <p className="font-medium">
        Since {since}: <span className="font-normal">{diffSummary(diff)}</span>
      </p>
      {diff.addedNodes.length > 0 && (
        <p>
          <span className="mr-1.5 inline-block h-2 w-2 rounded-sm bg-emerald-500" aria-hidden="true" />
          Launched: <NodeLinks names={diff.addedNodes} onSelectNode={onSelectNode} />
        </p>
      )}
      {diff.removedNodes.length > 0 && (
        <div>
          <span className="mr-1.5 inline-block h-2 w-2 rounded-sm border border-dashed border-red-500" aria-hidden="true" />
          Removed ({groups.map(([r, names]) => `${r} ×${names.length}`).join(', ')}):
          {single ? (
            <> <RemovedNode name={single} event={eventOf.get(single)} /></>
          ) : (
            <ul className="ml-3.5 mt-0.5 space-y-0.5">
              {groups.map(([r, names]) => (
                <RemovedGroup key={r} reason={r} names={names} eventOf={eventOf} />
              ))}
            </ul>
          )}
        </div>
      )}
      {diff.movedPods.length > 0 && (
        <details>
          <summary className="cursor-pointer">
            {diff.movedPods.length} pod{diff.movedPods.length === 1 ? '' : 's'} moved
          </summary>
          <ul className="mt-1 space-y-0.5 font-mono">
            {diff.movedPods.slice(0, 50).map((m) => (
              <li key={m.pod}>
                {m.pod}: {m.from} → {m.to}
              </li>
            ))}
          </ul>
        </details>
      )}
      {diff.gpuShrunk.length > 0 && (
        <p>
          Largest free GPU slice shrank on{' '}
          {diff.gpuShrunk.slice(0, LIST_LIMIT).map((g, i) => (
            <React.Fragment key={g.node}>
              {i > 0 && ', '}
              <button type="button" className="font-mono hover:underline" onClick={() => onSelectNode(g.node)}>
                {g.node}
              </button>{' '}
              ({formatMiB(g.beforeMiB)} → {formatMiB(g.afterMiB)})
            </React.Fragment>
          ))}
        </p>
      )}
    </section>
  );
}
