import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Switch } from './ui/switch';
import { Badge } from './ui/badge';
import { Alert, AlertTitle } from './ui/alert';
import { BellRing, Check, Plus, Trash2, Loader2, Play } from 'lucide-react';
import { cn } from '../lib/utils';
import { API_URL } from '../lib/api';

// Condition rows: key in the config object, label, threshold field + unit.
const CONDITIONS = [
  { key: 'costSpike', label: 'Cost spike', field: 'costSpikePct', unit: '% above 24h avg' },
  { key: 'disruptionBlocked', label: 'Disruption blocked', field: 'disruptionBlockedMin', unit: 'minutes blocked' },
  { key: 'servingPressure', label: 'Serving under pressure', field: 'kvCachePct', unit: 'KV cache %' },
  { key: 'gateway', label: 'Gateway errors', field: 'gatewayErrorRatePct', unit: 'error rate %' },
  { key: 'servingOffline', label: 'Serving pod offline', field: null, unit: null },
];

const REMIND_OPTIONS = [
  { value: '', label: 'No reminders' },
  { value: '1h', label: 'Every 1h' },
  { value: '4h', label: 'Every 4h' },
  { value: '12h', label: 'Every 12h' },
  { value: '24h', label: 'Every 24h' },
];

const CHANNEL_TYPES = ['ntfy', 'discord', 'slack', 'webhook'];

function AlertsSettings() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [cfg, setCfg] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [newChannel, setNewChannel] = useState({ type: 'ntfy', url: '' });
  const [testing, setTesting] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [editingIdx, setEditingIdx] = useState(null);
  const [editUrl, setEditUrl] = useState('');

  const load = () => {
    setLoading(true);
    setError(null);
    axios.get(`${API_URL}/api/v1/alerts/config`)
      .then((res) => {
        setCfg(res.data.config);
      })
      .catch((err) => setError(err.response?.data?.error || err.message))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }
  if (error || !cfg) {
    return (
      <Card>
        <CardContent className="py-4">
          <Alert variant="destructive">
            <AlertTitle>{error || 'Alerting not available'}</AlertTitle>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  const save = async (next) => {
    setSaving(true);
    setSaved(false);
    try {
      const res = await axios.put(`${API_URL}/api/v1/alerts/config`, next);
      setCfg(res.data.config);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setSaving(false);
    }
  };

  const setCondition = (key, patch) => {
    const next = { ...cfg, [key]: { ...cfg[key], ...patch } };
    setCfg(next);
    save(next);
  };

  const addChannel = async () => {
    if (!newChannel.url.trim()) return;
    const next = { ...cfg, channels: [...(cfg.channels || []), { type: newChannel.type, url: newChannel.url.trim() }] };
    setCfg(next);
    await save(next);
    setNewChannel({ type: 'ntfy', url: '' });
  };

  const removeChannel = async (i) => {
    const next = { ...cfg, channels: cfg.channels.filter((_, j) => j !== i) };
    setCfg(next);
    await save(next);
    setEditingIdx(null);
  };

  const startEdit = (i) => {
    setEditingIdx(i);
    setEditUrl(cfg.channels[i].url);
  };

  const commitEdit = async () => {
    if (!editUrl.trim()) return;
    const channels = cfg.channels.map((ch, j) => (j === editingIdx ? { ...ch, url: editUrl.trim() } : ch));
    const next = { ...cfg, channels };
    setCfg(next);
    await save(next);
    setEditingIdx(null);
  };

  const runTest = async (channel, i) => {
    setTesting(i);
    setTestResult(null);
    try {
      await axios.post(`${API_URL}/api/v1/alerts/test`, channel);
      setTestResult({ ok: true, msg: 'Test message sent' });
    } catch (err) {
      setTestResult({ ok: false, msg: err.response?.data?.error || err.message });
    } finally {
      setTesting(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <BellRing className="h-4 w-4" />
            Alerts
          </CardTitle>
          <div className="flex items-center gap-2">
            {saving && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            {saved && <Badge variant="secondary"><Check className="h-3 w-3 mr-1" />Saved</Badge>}
            <Switch checked={cfg.enabled} onCheckedChange={(v) => save({ ...cfg, enabled: v })} aria-label="Enable alerting" />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Conditions */}
        <div className="space-y-2">
          {CONDITIONS.map((c) => (
            <div key={c.key} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
              <div className="flex items-center gap-3">
                <Switch
                  checked={!!cfg[c.key]?.enabled}
                  onCheckedChange={(v) => setCondition(c.key, { enabled: v })}
                  aria-label={`Enable ${c.label}`}
                />
                <span className={cn('text-sm', cfg[c.key]?.enabled ? 'font-medium' : 'text-muted-foreground')}>{c.label}</span>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  type="text"
                  className="h-7 w-16 text-xs"
                  value={cfg[c.key]?.for || '5m'}
                  disabled={!cfg[c.key]?.enabled}
                  onChange={(e) => setCondition(c.key, { for: e.target.value })}
                  aria-label={`${c.label} duration`}
                />
                {c.field && (
                  <>
                    <Input
                      type="number"
                      className="h-7 w-16 text-xs"
                      value={cfg[c.key]?.[c.field] ?? ''}
                      disabled={!cfg[c.key]?.enabled}
                      onChange={(e) => setCondition(c.key, { [c.field]: Number(e.target.value) })}
                      aria-label={`${c.label} threshold`}
                    />
                    <span className="text-xs text-muted-foreground whitespace-nowrap">{c.unit}</span>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Reminders */}
        <div className="flex items-center justify-between rounded-md border px-3 py-2">
          <span className="text-sm">Remind while firing</span>
          <select
            className="h-7 rounded border bg-transparent px-2 text-xs"
            value={cfg.remindWhileFiring || ''}
            onChange={(e) => save({ ...cfg, remindWhileFiring: e.target.value })}
          >
            {REMIND_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>

        {/* Channels */}
        <div className="space-y-2">
          <Label className="text-xs uppercase tracking-wide text-muted-foreground">Channels</Label>
          {(cfg.channels || []).length === 0 && (
            <p className="text-xs text-muted-foreground">No channels configured. Add one below.</p>
          )}
          {(cfg.channels || []).map((ch, i) => (
            <div key={i} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
              <Badge variant="outline" className="shrink-0">{ch.type}</Badge>
              {editingIdx === i ? (
                <Input
                  type="text"
                  className="h-7 flex-1 text-xs"
                  value={editUrl}
                  onChange={(e) => setEditUrl(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && commitEdit()}
                  aria-label="Channel URL"
                />
              ) : (
                <span className="flex-1 truncate font-mono text-xs text-muted-foreground">{ch.url}</span>
              )}
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => (editingIdx === i ? commitEdit() : startEdit(i))}>
                {editingIdx === i ? 'Save' : 'Edit'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className={cn('h-7 px-2 text-xs', testing === i && 'opacity-50')}
                onClick={() => runTest(ch, i)}
                disabled={!!testing}
              >
                {testing === i ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
              </Button>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-destructive" onClick={() => removeChannel(i)} aria-label="Remove channel">
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))}

          {/* Add channel */}
          <div className="flex items-center gap-2">
            <select
              className="h-8 w-28 rounded border bg-transparent px-2 text-xs"
              value={newChannel.type}
              onChange={(e) => setNewChannel({ ...newChannel, type: e.target.value })}
            >
              {CHANNEL_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <Input
              type="url"
              className="h-8 flex-1 text-xs"
              placeholder="https://… (channel URL, stored as a secret)"
              value={newChannel.url}
              onChange={(e) => setNewChannel({ ...newChannel, url: e.target.value })}
            />
            <Button size="sm" variant="outline" className="h-8" onClick={addChannel} disabled={!newChannel.url.trim()}>
              <Plus className="h-3 w-3 mr-1" />Add
            </Button>
          </div>
          {testResult && (
            <p className={cn('text-xs', testResult.ok ? 'text-green-600' : 'text-destructive')}>
              {testResult.msg}
            </p>
          )}
        </div>

        <Alert>
          <AlertTitle className="text-xs">
            Channel URLs are credentials — stored in the server state file. All URLs are SSRF-validated
            (public http/https only, no redirects).
          </AlertTitle>
        </Alert>
      </CardContent>
    </Card>
  );
}

export default AlertsSettings;
