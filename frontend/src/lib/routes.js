// The app's URL scheme: three areas, each with its pages, as paths
// (/cluster/topology, /inference/serving). Old ?tab= links redirect to the
// new paths. The log drawer opens on any page with ?logs=<ns/name>.
//
// A page's focus (a Topology node/pod/GPU, a Serving pod) and its own
// filters (useUrlParam) stay query params.

export const AREAS = [
  {
    id: 'cluster',
    label: 'Cluster',
    pages: [
      { id: 'overview', label: 'Overview' },
      { id: 'nodes', label: 'Nodes' },
      { id: 'topology', label: 'Topology' },
      { id: 'disruptions', label: 'Disruptions' },
    ],
  },
  {
    id: 'inference',
    label: 'Inference',
    pages: [
      { id: 'serving', label: 'Serving' },
      { id: 'gateway', label: 'Gateway' },
    ],
  },
  {
    id: 'optimize',
    label: 'Optimize',
    pages: [
      { id: 'recommendations', label: 'Recommendations' },
      { id: 'workloads', label: 'Workloads' },
    ],
  },
];

export const HOME = 'overview';

const AREA_OF = new Map(AREAS.flatMap((a) => a.pages.map((p) => [p.id, a])));

// areaOf returns the area a page belongs to.
export function areaOf(page) {
  return AREA_OF.get(page) || AREAS[0];
}

// pagePath is the path of a page: "/" for the home page, else /area/page.
export function pagePath(page) {
  if (page === HOME || !AREA_OF.has(page)) return '/';
  return `/${areaOf(page).id}/${page}`;
}

// Params that belong to a page's focus or to the app, not to a page's
// filters: dropped or rewritten by navigation.
export const FOCUS_PARAMS = ['node', 'pod', 'gpu'];
const APP_PARAMS = ['tab', 'logs', ...FOCUS_PARAMS];

function focusFrom(page, q) {
  if (page === 'topology' && q.get('node')) {
    return { node: q.get('node'), pod: q.get('pod') || '', gpu: q.get('gpu') || '' };
  }
  if (page === 'serving' && q.get('pod')) return { pod: q.get('pod') };
  return null;
}

function pageFromPath(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length === 0) return { page: HOME, known: true };
  if (parts.length === 1) {
    // /cluster → its first page.
    const area = AREAS.find((a) => a.id === parts[0]);
    return area ? { page: area.pages[0].id, known: false } : { page: HOME, known: false };
  }
  const [areaId, page] = parts;
  const area = AREA_OF.get(page);
  if (area && area.id === areaId) return { page, known: parts.length === 2 };
  return { page: HOME, known: false };
}

// buildUrl builds the URL for a page, its focus and the log drawer (logs:
// null = closed, '' = open on the pod picker, 'ns/name' = open on a pod). keep
// carries the current page's own params (its filters) when staying on the
// same page; a different page starts clean.
export function buildUrl(page, { focus = null, logs = null, keep = '' } = {}) {
  const q = new URLSearchParams();
  if (focus) {
    if (focus.node) q.set('node', focus.node);
    if (focus.pod) q.set('pod', focus.pod);
    if (focus.gpu) q.set('gpu', focus.gpu);
  }
  new URLSearchParams(keep).forEach((value, key) => {
    if (!APP_PARAMS.includes(key)) q.set(key, value);
  });
  if (typeof logs === 'string') q.set('logs', logs);
  const s = q.toString();
  return `${pagePath(page)}${s ? `?${s}` : ''}`;
}

// parseLocation reads the page, its focus and the log drawer (null when
// closed) from a URL.
// `redirect` is set when the URL is an old ?tab= link or a path that is not
// canonical; the app replaces the address with it on load.
export function parseLocation(pathname = '/', search = '') {
  const q = new URLSearchParams(search);
  const tab = q.get('tab');
  if (tab !== null) {
    // Old links: ?tab=topology&node=… → /cluster/topology?node=…;
    // ?tab=logs&pod=x → the home page with the log drawer on x.
    const isLogs = tab === 'logs';
    const page = AREA_OF.has(tab) ? tab : HOME;
    const focus = isLogs ? null : focusFrom(page, q);
    const logs = isLogs ? q.get('pod') || '' : q.get('logs');
    const keep = new URLSearchParams(q);
    if (isLogs) keep.delete('pod');
    const redirect = buildUrl(page, { focus, logs, keep: keep.toString() });
    return { page, focus, logs, redirect };
  }
  const { page, known } = pageFromPath(pathname);
  const focus = known ? focusFrom(page, q) : null;
  const logs = q.get('logs');
  const redirect = known ? null : buildUrl(page, { logs, keep: search });
  return { page, focus, logs, redirect };
}

// logsParam is the drawer's ?logs= value for a pod ("namespace/name").
export function logsParam(pod) {
  if (!pod) return '';
  if (typeof pod === 'string') return pod;
  return pod.name ? `${pod.namespace}/${pod.name}` : pod.namespace || '';
}
