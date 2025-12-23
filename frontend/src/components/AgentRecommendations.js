import React, { useState } from 'react';
import axios from 'axios';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from './ui/card';
import { Button } from './ui/button';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Badge } from './ui/badge';
import { Loader2, Sparkles, TrendingDown, Shield, Zap, Target } from 'lucide-react';
import { cn } from '../lib/utils';
import NodePoolCard from './NodePoolCard';

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
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
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
      setError(err.response?.data?.error || err.message || 'Failed to fetch agent recommendations');
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
              Cost optimization recommendations powered by AI agent
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
          </Alert>
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
                              Save ${plan.estimatedSavings.toFixed(2)}/hr
                            </span>
                          )}
                          <span>
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

        {/* Empty State */}
        {!loading && plans.length === 0 && !error && (
          <div className="text-center py-8 text-muted-foreground">
            <Sparkles className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p>Select a strategy and click "Generate" to get AI-powered recommendations</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default AgentRecommendations;

