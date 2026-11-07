// Traffic headroom: roughly how much more traffic a model takes before its
// KV cache reaches the pressure threshold, fitted from serving history.
//
// For each replica, fit KV cache % = a + b × requests/s over its online
// samples (least squares). Where the fit is usable, the request rate at the
// threshold is (threshold − a) / b, and headroom is that rate over the
// current one. Traffic is assumed to spread evenly over replicas, so the
// model's headroom is its tightest replica's.

import { KV_PRESSURE_PCT } from './servingStatus';

export const MIN_HISTORY_SEC = 30 * 60; // plan: hidden until 30 minutes of history
export const MIN_POINTS = 10;
export const MIN_R2 = 0.3; // weaker fits say nothing about traffic
export const MAX_HEADROOM_PCT = 300; // beyond this a linear fit is guesswork

// fitLine returns { a, b, r2 } for y = a + b·x, or null when x does not vary.
export function fitLine(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
    syy += (ys[i] - my) ** 2;
  }
  if (sxx === 0) return null;
  const b = sxy / sxx;
  const a = my - b * mx;
  const r2 = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { a, b, r2 };
}

// replicaHeadroom estimates one replica from its history points:
//   { pct, capped, currentRps, rpsAtLimit, r2, points }   usable estimate
//   { pct: 0, reason: 'at-limit' }                        already queueing / at the threshold
//   { pct: null, reason }                                 'short-history' | 'idle' | 'flat' | 'noisy'
export function replicaHeadroom(points, threshold = KV_PRESSURE_PCT) {
  const usable = (points || []).filter(
    (p) => p.online && p.requestsPerSec != null && p.kvCachePercent != null,
  );
  if (usable.length < MIN_POINTS || usable.at(-1).unix - usable[0].unix < MIN_HISTORY_SEC) {
    return { pct: null, reason: 'short-history' };
  }
  const last = usable.at(-1);
  if ((last.waiting || 0) > 0 || last.kvCachePercent >= threshold) {
    return { pct: 0, reason: 'at-limit' };
  }
  const currentRps = last.requestsPerSec;
  if (!(currentRps > 0)) return { pct: null, reason: 'idle' };

  const fit = fitLine(
    usable.map((p) => p.requestsPerSec),
    usable.map((p) => p.kvCachePercent),
  );
  // KV not rising with traffic (or traffic never varied): no basis to project.
  if (!fit || fit.b <= 0) return { pct: null, reason: 'flat' };
  if (fit.r2 < MIN_R2) return { pct: null, reason: 'noisy' };

  const rpsAtLimit = (threshold - fit.a) / fit.b;
  const raw = (rpsAtLimit / currentRps - 1) * 100;
  const pct = Math.max(0, Math.min(raw, MAX_HEADROOM_PCT));
  return { pct, capped: raw > MAX_HEADROOM_PCT, currentRps, rpsAtLimit, r2: fit.r2, points: usable.length };
}

// modelHeadroom combines a model's replicas: the smallest usable estimate
// wins (traffic spreads evenly, so the tightest replica hits the limit
// first). A replica queueing or at the KV threshold right now (its live
// probe, not just history) means no headroom. null when no replica has an
// estimate; the reason of the first replica explains why.
export function modelHeadroom(replicas, history = {}) {
  const atLimitNow = replicas.find(
    (p) => p.online && ((p.waiting || 0) > 0 || (p.kvCachePercent ?? 0) >= KV_PRESSURE_PCT),
  );
  const estimates = replicas.map((p) => ({
    key: `${p.namespace}/${p.name}`,
    ...replicaHeadroom(history[`${p.namespace}/${p.name}`]?.points),
  }));
  if (atLimitNow) {
    return { pct: 0, reason: 'at-limit', replicas: estimates, limitedBy: `${atLimitNow.namespace}/${atLimitNow.name}` };
  }
  const usable = estimates.filter((e) => e.pct != null);
  if (usable.length === 0) {
    return { pct: null, reason: estimates[0]?.reason || 'short-history', replicas: estimates };
  }
  const tightest = usable.reduce((a, b) => (b.pct < a.pct ? b : a));
  return { ...tightest, replicas: estimates, limitedBy: tightest.key };
}

const REASON_TEXT = {
  'short-history': 'Needs 30 minutes of serving history.',
  idle: 'No traffic right now.',
  flat: 'KV cache use does not rise with traffic in the history, so there is nothing to project from.',
  noisy: 'KV cache use and traffic are too loosely related in the history for a projection.',
};

// headroomText is the label and tooltip for a model's headroom.
export function headroomText(h) {
  if (h.pct == null) return { label: '–', title: REASON_TEXT[h.reason] || REASON_TEXT['short-history'] };
  if (h.reason === 'at-limit') {
    return { label: 'none', title: `${h.limitedBy || 'A replica'} is already queueing or at ${KV_PRESSURE_PCT}% KV cache.` };
  }
  const label = h.capped ? `>+${MAX_HEADROOM_PCT}%` : `+${Math.round(h.pct)}%`;
  const title =
    `Estimate: ${h.capped ? `more than +${MAX_HEADROOM_PCT}%` : `about ${label}`} more traffic before ${h.limitedBy} reaches ${KV_PRESSURE_PCT}% KV cache ` +
    `(${h.currentRps.toFixed(2)} → ${h.rpsAtLimit.toFixed(2)} req/s on that replica). ` +
    `Linear fit of KV cache % against req/s over ${h.points} samples (R² ${h.r2.toFixed(2)}); assumes traffic spreads evenly and requests keep their current size.`;
  return { label, title };
}
