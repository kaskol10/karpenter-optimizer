import React, { useState } from 'react';
import axios from 'axios';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from './ui/card';
import { Button } from './ui/button';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Badge } from './ui/badge';
import { Skeleton, SkeletonRows } from './ui/skeleton';
import { EmptyState } from './ui/empty-state';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Loader2, Sparkles, TrendingDown, Shield, Zap, Target, Info } from 'lucide-react';
import { cn } from '../lib/utils';
import NodePoolCard from './NodePoolCard';
import { useCurrencyFormatter } from '../lib/currency';

// Use runtime configuration from window.ENV (set via config.js) or build-time env var
const API_URL = (window.ENV && window.ENV.hasOwnProperty('REACT_APP_API_URL')) 
  ? window.ENV.REACT_APP_API_URL 
  : (process.env.REACT_APP_API_URL || '');

const STRATEGY_INFO = {
  'balanced': {
    label: 'Balanced',
    description: 'Balance cost savings and stability',
    icon: Shield,
    color: 'bg-blue-500',
  },
  'aggressive': {
    label: 'Aggressive',
    description: 'Maximize cost savings',
    icon: TrendingDown,
    color: 'bg-red-500',
  },
  'conservative': {
    label: 'Conservative',
    description: 'Prioritize stability',
    icon: Shield,
    color: 'bg-green-500',
  },
  'spot-first': {
    label: 'Spot First',
    description: 'Prioritize spot instance conversion',
    icon: Zap,
    color: 'bg-yellow-500',
  },
  'right-size': {
    label: 'Right Size',
    description: 'Focus on right-sizing',
    icon: Target,
    color: 'bg-purple-500',
  },
};

function AgentRecommendations({ onRecommendationsGenerated, onClusterCostUpdate }) {
  const currency = useCurrencyFormatter();
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [noKarpenter, setNoKarpenter] = useState(false);
  const [strategy, setStrategy] = useState('balanced');
  const [selectedPlan, setSelectedPlan] = useState(null);

  const handleGenerateRecommendations = async () => {
    setLoading(true);
    setError(null);
    setPlans([]);
    setSelectedPlan(null);

    try {
      const response = await axios.get(`${API_URL}/api/v1/agent/cost-optimization`, {
        params: { strategy },
      });

      const agentData = response.data;
      setPlans(agentData.plans || []);

      // Extract recommendations from plans and notify parent
      const allRecommendations = [];
      let totalCurrentCost = 0;
      let totalRecommendedCost = 0;
      let totalCurrentNodes = 0;
      let totalRecommendedNodes = 0;

      agentData.plans?.forEach(plan => {
        plan.recommendations?.forEach(rec => {
          allRecommendations.push(rec);
          totalCurrentCost += rec.currentCost || 0;
          totalRecommendedCost += rec.recommendedCost || 0;
          totalCurrentNodes += rec.currentNodes || 0;
          totalRecommendedNodes += rec.recommendedNodes || 0;
        });
      });

      if (onRecommendationsGenerated) {
        onRecommendationsGenerated(allRecommendations);
      }

      if (onClusterCostUpdate) {
        onClusterCostUpdate({
          current: totalCurrentCost,
          recommended: totalRecommendedCost,
          savings: totalCurrentCost - totalRecommendedCost,
          clusterNodes: {
            current: totalCurrentNodes,
            recommended: totalRecommendedNodes,
          },
        });
      }
    } catch (err) {
      const data = err.response?.data;
      if (data?.code === 'karpenter_not_found') {
        setNoKarpenter(true);
        setError(null);
      } else {
        setError(data?.error || err.message || 'Failed to fetch agent recommendations');
      }
      console.error('Agent recommendations error:', err);
    } finally {
      setLoading(false);
    }
  };

  const handlePlanSelect = (plan) => {
    setSelectedPlan(plan);
    if (plan && plan.recommendations && plan.recommendations.length > 0) {
      if (onRecommendationsGenerated) {
        onRecommendationsGenerated(plan.recommendations);
      }
    }
  };

  const strategyInfo = STRATEGY_INFO[strategy] || STRATEGY_INFO['balanced'];
  const StrategyIcon = strategyInfo.icon;

  return (
    <Card>
      <CardHeader>
        <div className="flex justify-between items-start">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-purple-500" />
              AI Agent Recommendations
            </CardTitle>
            <CardDescription>
              Strategy-based, AI-assisted NodePool optimization plans. Distinct from the
              cluster-wide scan in Overview.
              <div className="mt-1">
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 text-xs text-primary underline underline-offset-2 hover:text-primary/80"
                      aria-label="How these numbers are made"
                    >
                      <Info className="h-3 w-3" />
                      How these numbers are made
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-80 space-y-2 text-xs text-muted-foreground" align="start">
                    <p className="font-semibold text-foreground">How these numbers are made</p>
                    <ul className="list-disc list-inside space-y-1">
                      <li>On-demand price comes from the live AWS Pricing API for the configured region.</li>
                      <li>Spot cost is an estimate at 25% of on-demand (75% discount) — not a live Spot quote.</li>
                      <li>Candidates are filtered by region + architecture (arm64/amd64) and CPU/memory ratio.</li>
                      <li>Combinations of 1–3 instance types are tried and sorted by cost efficiency.</li>
                      <li>Recommendations that would raise cost by more than 10% are dropped.</li>
                      <li>"Confidence" is the LLM's self-assessment — indicative only, not a measurement.</li>
                    </ul>
                  </PopoverContent>
                </Popover>
              </div>
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Strategy Selector */}
        <div className="flex items-center gap-4">
          <div className="flex-1">
            <label className="text-sm font-medium mb-2 block">Optimization Strategy</label>
            <Select value={strategy} onValueChange={setStrategy}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select strategy" />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(STRATEGY_INFO).map(([key, info]) => {
                  const Icon = info.icon;
                  return (
                    <SelectItem key={key} value={key}>
                      <div className="flex items-center gap-2">
                        <Icon className="h-4 w-4" />
                        <div>
                          <div className="font-medium">{info.label}</div>
                          <div className="text-xs text-muted-foreground">{info.description}</div>
                        </div>
                      </div>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
          <div className="pt-6">
            <Button 
              onClick={handleGenerateRecommendations} 
              disabled={loading}
              className="min-w-[140px]"
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Analyzing...
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4 mr-2" />
                  Generate
                </>
              )}
            </Button>
          </div>
        </div>

        {/* Strategy Info Badge */}
        {strategy && (
          <div className="flex items-center gap-2">
            <Badge variant="outline" className={cn("flex items-center gap-1", strategyInfo.color, "text-white")}>
              <StrategyIcon className="h-3 w-3" />
              {strategyInfo.label}
            </Badge>
            <span className="text-sm text-muted-foreground">{strategyInfo.description}</span>
          </div>
        )}

        {/* Error Display */}
        {error && (
          <Alert variant="destructive">
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
            <Button variant="outline" size="sm" className="mt-2" onClick={handleGenerateRecommendations}>
              Retry
            </Button>
          </Alert>
        )}

        {/* Loading skeleton while the agent analyzes */}
        {loading && (
          <div className="space-y-3 py-4">
            <Skeleton className="h-5 w-40" />
            <SkeletonRows rows={3} />
          </div>
        )}

        {/* Plans Overview */}
        {plans.length > 0 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold">
                Optimization Plans ({plans.length})
              </h3>
              <Badge variant="secondary">
                {plans.reduce((sum, plan) => sum + (plan.recommendations?.length || 0), 0)} recommendations
              </Badge>
            </div>

            {/* Plans List */}
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {plans.map((plan, index) => (
                <Card
                  key={plan.id || index}
                  className={cn(
                    "cursor-pointer transition-all hover:border-primary",
                    selectedPlan?.id === plan.id && "border-2 border-primary"
                  )}
                  onClick={() => handlePlanSelect(plan)}
                >
                  <CardContent className="pt-4">
                    <div className="flex items-center justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <h4 className="font-semibold">{plan.nodePoolName}</h4>
                          <Badge variant="outline" className="text-xs">
                            {plan.strategy}
                          </Badge>
                          <Badge 
                            variant={
                              plan.riskLevel === 'low' ? 'default' :
                              plan.riskLevel === 'medium' ? 'secondary' : 'destructive'
                            }
                            className="text-xs"
                          >
                            {plan.riskLevel} risk
                          </Badge>
                        </div>
                        <div className="flex items-center gap-4 text-sm text-muted-foreground">
                          <span>
                            {plan.recommendations?.length || 0} recommendation{plan.recommendations?.length !== 1 ? 's' : ''}
                          </span>
                          {plan.estimatedSavings > 0 && (
                            <span className="text-green-600 font-semibold">
                              Save {currency(plan.estimatedSavings)}/hr
                            </span>
                          )}
                          <span
                            className="cursor-help"
                            title="LLM self-assessed confidence score. Indicative only, not a measured value — treat as a rough signal of how strongly the plan fits the current cluster state."
                          >
                            Confidence: {(plan.confidence * 100).toFixed(0)}%
                          </span>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>

            {/* Selected Plan Recommendations */}
            {selectedPlan && selectedPlan.recommendations && selectedPlan.recommendations.length > 0 && (
              <div className="space-y-4 mt-6">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-semibold">
                    Recommendations for {selectedPlan.nodePoolName}
                  </h3>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelectedPlan(null)}
                  >
                    Clear Selection
                  </Button>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {selectedPlan.recommendations.map((rec, index) => (
                    <NodePoolCard key={index} recommendation={rec} />
                  ))}
                </div>
              </div>
            )}

            {/* All Recommendations (if no plan selected) */}
            {!selectedPlan && plans.length > 0 && (
              <div className="space-y-4 mt-6">
                <h3 className="text-lg font-semibold">All Recommendations</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {plans.flatMap(plan => 
                    (plan.recommendations || []).map((rec, index) => (
                      <NodePoolCard 
                        key={`${plan.id || plan.nodePoolName}-${index}`} 
                        recommendation={rec} 
                      />
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* No Karpenter empty state */}
        {noKarpenter && (
          <EmptyState
            icon={Shield}
            title="Recommendations require Karpenter NodePools"
            hint="Karpenter is not installed in this cluster. Use the Overview tab for cluster-wide analysis instead."
          />
        )}

        {/* Idle empty state */}
        {!loading && plans.length === 0 && !error && !noKarpenter && (
          <EmptyState
            icon={Sparkles}
            title="Ready to optimize"
            hint="Select an optimization strategy and click Generate to get AI-powered, NodePool-based recommendations."
          />
        )}
      </CardContent>
    </Card>
  );
}

export default AgentRecommendations;

