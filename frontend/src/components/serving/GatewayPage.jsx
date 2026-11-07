import React, { useCallback, useState } from 'react';
import axios from 'axios';
import { Waypoints } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { EmptyState } from '../ui/empty-state';
import { SkeletonRows } from '../ui/skeleton';
import { API_URL } from '../../lib/api';
import { usePolling } from '../../hooks/usePolling';
import { useUrlParam } from '../../hooks/useUrlParam';
import { GatewayCard } from './GatewayCard';

const VIEWS = ['apps', 'models', 'flow'];
const SPLITS = ['app', 'apikey', 'team'];

// GatewayPage is Inference → Gateway: the LiteLLM AI gateway's health,
// usage split by app / API key / team, and cost by day. It used to sit at
// the top of the Serving tab; on its own page it no longer pushes the model
// servers down. View and split are URL params (?view=models&split=team).
export default function GatewayPage() {
  const [gateway, setGateway] = useState(undefined); // undefined = loading, null = none found
  const [view, setView] = useUrlParam('view', 'apps', VIEWS);
  const [split, setSplit] = useUrlParam('split', 'app', SPLITS);

  const fetchGateway = useCallback(async () => {
    try {
      const response = await axios.get(`${API_URL}/api/v1/serving/gateway`);
      setGateway(response.data.gateway || null);
    } catch (err) {
      setGateway(null);
    }
  }, []);
  usePolling(fetchGateway, 30000);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Waypoints className="h-5 w-5 text-primary" aria-hidden="true" />
          LiteLLM gateway
        </CardTitle>
        <CardDescription>Requests, errors, latency the gateway adds, and who is spending what.</CardDescription>
      </CardHeader>
      <CardContent>
        {gateway === undefined ? (
          <SkeletonRows rows={4} />
        ) : gateway === null ? (
          <EmptyState
            icon={Waypoints}
            title="No LiteLLM gateway detected"
            hint="This page shows LiteLLM proxy pods found in the cluster. Deploy LiteLLM, or check that its pods expose /metrics."
          />
        ) : !gateway.online && !gateway.authError && !gateway.error ? (
          <EmptyState
            icon={Waypoints}
            title="The gateway is not answering"
            hint={`Found ${gateway.pods || 0} LiteLLM pod(s), but none returned metrics. Check that they are running.`}
          />
        ) : (
          <GatewayCard gateway={gateway} view={view} onViewChange={setView} split={split} onSplitChange={setSplit} />
        )}
      </CardContent>
    </Card>
  );
}
