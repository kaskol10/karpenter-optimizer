import { useCallback, useEffect, useState } from 'react';

// Topology semantic zoom lives in the URL, one level per history entry, so a
// zoomed view can be shared and the browser Back button zooms out:
//   (no zoom) or ?zoom=cluster          Cluster: every node as a tile
//   ?zoom=pool&at=<nodepool>            NodePool: that pool's tiles, larger
//   ?zoom=node[&at=<node>]              Node: node cards (one, or all in view)
//   ?zoom=gpu&at=<node>&card=<uuid>     GPU: one card, every slice named
export const ZOOM_LEVELS = ['cluster', 'pool', 'node', 'gpu'];
const ZOOM_PARAMS = ['zoom', 'at', 'card'];
// A Serving → Topology focus link (?node=&pod=&gpu=) ends when the user
// zooms somewhere else.
const FOCUS_PARAMS = ['node', 'pod', 'gpu'];

export function readZoom() {
  const q = new URLSearchParams(window.location.search);
  const zoom = ZOOM_LEVELS.includes(q.get('zoom')) ? q.get('zoom') : 'cluster';
  const at = q.get('at') || '';
  const card = q.get('card') || '';
  const explicit = q.has('zoom');
  // A level that needs a target falls back one level when it is missing.
  if (zoom === 'pool' && !at) return { zoom: 'cluster', at: '', card: '', explicit };
  if (zoom === 'gpu' && (!at || !card)) return { zoom: at ? 'node' : 'cluster', at, card: '', explicit };
  return { zoom, at: zoom === 'cluster' ? '' : at, card: zoom === 'gpu' ? card : '', explicit };
}

// zoomSearch builds the query string for a zoom location, keeping every
// other param (tab, filters, lens).
export function zoomSearch({ zoom = 'cluster', at = '', card = '' }) {
  const q = new URLSearchParams(window.location.search);
  [...ZOOM_PARAMS, ...FOCUS_PARAMS].forEach((k) => q.delete(k));
  q.set('zoom', zoom);
  if (zoom !== 'cluster' && at) q.set('at', at);
  if (zoom === 'gpu' && card) q.set('card', card);
  const s = q.toString();
  return `${window.location.pathname}${s ? `?${s}` : ''}`;
}

// useTopologyZoom returns [location, go]; go pushes a history entry.
export function useTopologyZoom() {
  const [location, setLocation] = useState(readZoom);

  useEffect(() => {
    const onPop = () => setLocation(readZoom());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const go = useCallback((next) => {
    const url = zoomSearch(next);
    if (url !== `${window.location.pathname}${window.location.search}`) {
      window.history.pushState(window.history.state, '', url);
    }
    setLocation(readZoom());
  }, []);

  return [location, go];
}
