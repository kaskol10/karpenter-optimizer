import React, { useCallback, useState } from 'react';
import axios from 'axios';
import { BellRing } from 'lucide-react';
import { API_URL } from '../lib/api';
import { usePolling, useLastRefresh } from '../hooks/usePolling';
import { cn } from '../lib/utils';

const Dot = ({ ok, warn }) => (
  <span
    className={cn('inline-block h-2 w-2 rounded-full', ok ? 'bg-emerald-500' : warn ? 'bg-amber-500' : 'bg-red-500')}
    aria-hidden="true"
  />
);

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// StatusStrip is one line in the header: the cluster connection, whether
// Karpenter was found, when the panels last refreshed (the shared polling
// clock), and how many alerts are firing (only when alerting is on).
// Clicking the alerts count opens the settings where alerting lives.
export function StatusStrip({ config, onOpenAlerts }) {
  const at = useLastRefresh();
  const [alertStatus, setAlertStatus] = useState(null);

  const fetchAlerts = useCallback(async () => {
    try {
      const { data } = await axios.get(`${API_URL}/api/v1/alerts/status`);
      setAlertStatus(data);
    } catch {
      setAlertStatus(null); // older backend or error: hide the count
    }
  }, []);
  usePolling(fetchAlerts, 60000);

  if (!config) return null;
  const connected = Boolean(config.kubernetes?.connected);
  const karpenter = Boolean(config.karpenter?.detected);
  const firing = alertStatus?.enabled ? alertStatus.firing || [] : null;
  const time = at && new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground" aria-label="Status">
      <span className="flex items-center gap-1.5">
        <Dot ok={connected} />
        {connected ? 'Cluster connected' : 'Cluster not connected'}
      </span>
      {connected && (
        <span className="flex items-center gap-1.5">
          <Dot ok={karpenter} warn />
          {karpenter ? 'Karpenter' : 'No Karpenter'}
        </span>
      )}
      {time && (
        <span className="tabular-nums" title="Polling pauses while this browser tab is hidden">
          Updated {time}
        </span>
      )}
      {firing && (
        <button
          type="button"
          onClick={onOpenAlerts}
          title={firing.map((a) => a.title).join('\n') || 'No alerts firing'}
          className={cn(
            'flex items-center gap-1 rounded-full px-2 py-0.5',
            firing.length ? 'bg-destructive/10 font-medium text-destructive' : 'hover:text-foreground',
          )}
        >
          <BellRing className="h-3 w-3" aria-hidden="true" />
          {firing.length ? `${plural(firing.length, 'alert')} firing` : 'No alerts firing'}
        </button>
      )}
    </div>
  );
}
