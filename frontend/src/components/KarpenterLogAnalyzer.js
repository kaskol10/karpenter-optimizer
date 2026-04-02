import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from './ui/card';
import { Button } from './ui/button';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Badge } from './ui/badge';
import { Textarea } from './ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Loader2, AlertTriangle, CheckCircle, Info, AlertCircle, RefreshCw } from 'lucide-react';
import { cn } from '../lib/utils';
import { logger } from '../lib/logger';

const API_URL =
  window.ENV && window.ENV.hasOwnProperty('REACT_APP_API_URL')
    ? window.ENV.REACT_APP_API_URL
    : process.env.REACT_APP_API_URL || '';

function KarpenterLogAnalyzer() {
  const [karpenterPods, setKarpenterPods] = useState([]);
  const [selectedPod, setSelectedPod] = useState(null);
  const [errorLogs, setErrorLogs] = useState([]);
  const [selectedLog, setSelectedLog] = useState('');
  const [analysis, setAnalysis] = useState(null);
  const [loadingPods, setLoadingPods] = useState(false);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [loadingAnalysis, setLoadingAnalysis] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchKarpenterPods();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchKarpenterPods = async () => {
    setLoadingPods(true);
    setError(null);
    try {
      const response = await axios.get(`${API_URL}/api/v1/karpenter/pods`);
      const pods = response.data.pods || [];
      setKarpenterPods(pods);

      // Auto-select first pod if available
      if (pods.length > 0 && !selectedPod) {
        const firstPod = `${pods[0].namespace}/${pods[0].name}`;
        setSelectedPod(firstPod);
        fetchLogs(pods[0].namespace, pods[0].name);
      }
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to fetch Karpenter pods');
      logger.error('Karpenter pods error:', err);
    } finally {
      setLoadingPods(false);
    }
  };

  const fetchLogs = async (namespace, podName) => {
    if (!namespace || !podName) return;

    setLoadingLogs(true);
    setError(null);
    setErrorLogs([]);
    setSelectedLog('');
    setAnalysis(null);

    try {
      const response = await axios.get(`${API_URL}/api/v1/karpenter/logs`, {
        params: {
          namespace,
          pod: podName,
          errorOnly: true,
          tailLines: 500,
        },
      });

      const logs = response.data.logs || [];
      setErrorLogs(logs);

      // Auto-select first error log if available
      if (logs.length > 0) {
        setSelectedLog(logs[0]);
      }
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to fetch logs');
      logger.error('Logs fetch error:', err);
    } finally {
      setLoadingLogs(false);
    }
  };

  const handlePodSelect = (podValue) => {
    setSelectedPod(podValue);
    const [namespace, name] = podValue.split('/');
    fetchLogs(namespace, name);
  };

  const handleLogSelect = (log) => {
    setSelectedLog(log);
    setAnalysis(null);
  };

  const handleAnalyze = async () => {
    if (!selectedLog.trim()) {
      setError('Please select an error log to analyze');
      return;
    }

    setLoadingAnalysis(true);
    setError(null);
    setAnalysis(null);

    try {
      const response = await axios.post(`${API_URL}/api/v1/karpenter/logs/analyze`, {
        log: selectedLog.trim(),
      });

      setAnalysis(response.data);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to analyze log');
      logger.error('Log analysis error:', err);
    } finally {
      setLoadingAnalysis(false);
    }
  };

  const handleRefresh = () => {
    if (selectedPod) {
      const [namespace, name] = selectedPod.split('/');
      fetchLogs(namespace, name);
    } else {
      fetchKarpenterPods();
    }
  };

  const getSeverityColor = (severity) => {
    switch (severity) {
      case 'critical':
        return 'bg-red-100 text-red-800 border-red-300';
      case 'warning':
        return 'bg-yellow-100 text-yellow-800 border-yellow-300';
      default:
        return 'bg-blue-100 text-blue-800 border-blue-300';
    }
  };

  const getSeverityIcon = (severity) => {
    switch (severity) {
      case 'critical':
        return <AlertCircle className="h-4 w-4" />;
      case 'warning':
        return <AlertTriangle className="h-4 w-4" />;
      default:
        return <Info className="h-4 w-4" />;
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Karpenter Error Log Analyzer</CardTitle>
          <CardDescription>
            Automatically fetch and analyze Karpenter error logs from your cluster
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Karpenter Pod Selection */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label htmlFor="pod-select" className="text-sm font-medium">
                Karpenter Pod
              </label>
              <Button
                onClick={handleRefresh}
                variant="outline"
                size="sm"
                disabled={loadingPods || loadingLogs}
              >
                <RefreshCw
                  className={cn('h-4 w-4 mr-2', (loadingPods || loadingLogs) && 'animate-spin')}
                />
                Refresh
              </Button>
            </div>
            <Select
              value={selectedPod || ''}
              onValueChange={handlePodSelect}
              disabled={loadingPods || karpenterPods.length === 0}
            >
              <SelectTrigger id="pod-select">
                <SelectValue
                  placeholder={
                    loadingPods
                      ? 'Loading pods...'
                      : karpenterPods.length === 0
                        ? 'No Karpenter pods found'
                        : 'Select a pod'
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {karpenterPods.map((pod, idx) => (
                  <SelectItem key={idx} value={`${pod.namespace}/${pod.name}`}>
                    {pod.namespace}/{pod.name} ({pod.status}, {pod.ready})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Error Logs Selection */}
          {selectedPod && (
            <div className="space-y-2">
              <label htmlFor="log-select" className="text-sm font-medium">
                Error Logs{' '}
                {loadingLogs && <span className="text-muted-foreground">(Loading...)</span>}
              </label>
              {errorLogs.length > 0 ? (
                <Select value={selectedLog} onValueChange={handleLogSelect} disabled={loadingLogs}>
                  <SelectTrigger id="log-select">
                    <SelectValue placeholder={`Select an error log (${errorLogs.length} found)`} />
                  </SelectTrigger>
                  <SelectContent>
                    {errorLogs.map((log, idx) => {
                      // Try to extract a short description from the log
                      let description = `Error ${idx + 1}`;
                      try {
                        const parsed = JSON.parse(log);
                        if (parsed.message) {
                          description = parsed.message.substring(0, 60);
                          if (parsed.message.length > 60) description += '...';
                        }
                        if (parsed.Pod?.name) {
                          description += ` (${parsed.Pod.namespace}/${parsed.Pod.name})`;
                        }
                      } catch (e) {
                        // Not JSON, use first 60 chars
                        description = log.substring(0, 60);
                        if (log.length > 60) description += '...';
                      }
                      return (
                        <SelectItem key={idx} value={log}>
                          {description}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              ) : (
                <div className="text-sm text-muted-foreground">
                  {loadingLogs
                    ? 'Loading error logs...'
                    : 'No error logs found in the last 500 lines'}
                </div>
              )}
            </div>
          )}

          {/* Selected Log Display */}
          {selectedLog && (
            <div className="space-y-2">
              <label htmlFor="log-display" className="text-sm font-medium">
                Selected Log (JSON)
              </label>
              <Textarea
                id="log-display"
                value={selectedLog}
                onChange={(e) => setSelectedLog(e.target.value)}
                className="min-h-[150px] font-mono text-sm"
                readOnly={false}
              />
            </div>
          )}

          {/* Analyze Button */}
          <div className="flex gap-2">
            <Button onClick={handleAnalyze} disabled={loadingAnalysis || !selectedLog.trim()}>
              {loadingAnalysis ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Analyzing...
                </>
              ) : (
                'Analyze Log'
              )}
            </Button>
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Error</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {analysis && (
            <div className="space-y-4 mt-6">
              <Alert>
                <CheckCircle className="h-4 w-4" />
                <AlertTitle>Analysis Complete</AlertTitle>
                <AlertDescription>{analysis.summary}</AlertDescription>
              </Alert>

              {analysis.explanation && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg">Explanation</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm whitespace-pre-wrap">{analysis.explanation}</p>
                  </CardContent>
                </Card>
              )}

              {analysis.errorCauses && analysis.errorCauses.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg">Error Causes</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-3">
                      {analysis.errorCauses.map((cause, idx) => (
                        <div
                          key={idx}
                          className={cn('p-3 rounded-lg border', getSeverityColor(cause.severity))}
                        >
                          <div className="flex items-start gap-2">
                            {getSeverityIcon(cause.severity)}
                            <div className="flex-1 space-y-1">
                              <div className="flex items-center gap-2">
                                <Badge variant="outline" className="text-xs">
                                  {cause.category}
                                </Badge>
                                <Badge
                                  variant="outline"
                                  className={cn(
                                    'text-xs',
                                    cause.severity === 'critical' && 'border-red-500 text-red-700',
                                    cause.severity === 'warning' &&
                                      'border-yellow-500 text-yellow-700'
                                  )}
                                >
                                  {cause.severity}
                                </Badge>
                              </div>
                              <p className="text-sm font-medium">{cause.error}</p>
                              <p className="text-sm opacity-90">{cause.explanation}</p>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}

              {analysis.recommendations && analysis.recommendations.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg">Recommendations</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ul className="list-disc list-inside space-y-2">
                      {analysis.recommendations.map((rec, idx) => (
                        <li key={idx} className="text-sm">
                          {rec}
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              )}

              {analysis.parsedError && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg">Parsed Log Details</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2 text-sm">
                      <div>
                        <span className="font-medium">Pod:</span>{' '}
                        {analysis.parsedError.Pod?.name || 'N/A'} (
                        {analysis.parsedError.Pod?.namespace || 'N/A'})
                      </div>
                      <div>
                        <span className="font-medium">NodePool:</span>{' '}
                        {analysis.parsedError.NodePool?.name || 'N/A'}
                      </div>
                      {analysis.parsedError.Taints && analysis.parsedError.Taints.length > 0 && (
                        <div>
                          <span className="font-medium">Taints:</span>{' '}
                          <div className="mt-1 flex flex-wrap gap-1">
                            {analysis.parsedError.Taints.map((taint, idx) => (
                              <Badge key={idx} variant="outline" className="text-xs">
                                {taint}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default KarpenterLogAnalyzer;
