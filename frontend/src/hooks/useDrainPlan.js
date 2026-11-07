import { useCallback, useMemo } from 'react';
import { useUrlParam } from './useUrlParam';
import { parseSize } from '../lib/gpuFit';
import { parseDrainParam, simulateDrain } from '../lib/drainSim';
import { planPlacement } from '../lib/placementPlanner';

// useDrainPlan holds the Topology what-ifs, all in the URL so they can be
// shared: the Will it fit? size (?fit=40GiB) and replicas (?replicas=2) for
// the placement planner, and the drain simulation's nodes (?drain=a,b).
// Both run over every node (a filter must not hide the room a pod would move
// into), and a drained node is not offered to the planner.
export function useDrainPlan(nodes, currency) {
  const [fitText, setFitText] = useUrlParam('fit');
  const fitMiB = parseSize(fitText);
  const [replicasText, setReplicasText] = useUrlParam('replicas', '1');
  const replicas = Math.min(Math.max(parseInt(replicasText, 10) || 1, 1), 64);
  const [drainText, setDrainText] = useUrlParam('drain');
  const drainNames = useMemo(() => parseDrainParam(drainText), [drainText]);
  const drainSet = useMemo(() => new Set(drainNames), [drainNames]);

  const toggleDrain = useCallback(
    (name) => {
      const next = drainSet.has(name) ? drainNames.filter((n) => n !== name) : [...drainNames, name];
      setDrainText(next.join(','));
    },
    [drainNames, drainSet, setDrainText],
  );
  const clearDrain = useCallback(() => setDrainText(''), [setDrainText]);

  const drainResult = useMemo(
    () => (drainNames.length ? simulateDrain(nodes, drainNames, { currency }) : null),
    [nodes, drainNames, currency],
  );
  const plan = useMemo(
    () => (fitMiB ? planPlacement(nodes.filter((n) => !drainSet.has(n.name)), fitMiB, replicas) : null),
    [nodes, fitMiB, replicas, drainSet],
  );
  // Replica badges per node, only for multi-replica plans (one replica is
  // what the fit rings already show).
  const plannedByNode = useMemo(() => {
    const m = new Map();
    if (replicas > 1) (plan?.placed || []).forEach((p) => m.set(p.node, [...(m.get(p.node) || []), p]));
    return m;
  }, [plan, replicas]);

  return {
    fitText,
    setFitText,
    fitMiB,
    replicasText,
    setReplicasText,
    plan,
    plannedByNode,
    drainSet,
    drainResult,
    toggleDrain,
    clearDrain,
  };
}
