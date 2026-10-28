import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Badge } from './ui/badge';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Separator } from './ui/separator';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './ui/accordion';
import { Check, AlertTriangle } from 'lucide-react';
import { cn } from '../lib/utils';
import { useCurrencyFormatter } from '../lib/currency';

// instanceTypeBase strips a trailing " (N)" node-count suffix so a current
// "m6g.2xlarge (27)" and a recommended "m6g.2xlarge" compare equal.
const instanceTypeBase = (t) => (typeof t === 'string' ? t.replace(/\s*\(\d+\)\s*$/, '').trim() : String(t ?? ''));

// isGPUType recognizes GPU instance families broadly (the old g4/g5-only
// check missed g6, g5g, p3, p4d, trn, etc.).
const GPU_TYPE_RE = /^(g4|g5|g6|p2|p3|p4|p5|trn|vt1|inf2|dl1|ml1)\b/;
const isGPUType = (t) => GPU_TYPE_RE.test(instanceTypeBase(t));

// withNodeCounts distributes `totalNodes` evenly across the recommended
// instance types (the same even allocation the cost model assumes) and
// renders each as "type (count)", matching the current-side format.
// Returns the types unchanged when there is no positive node count.
const withNodeCounts = (types, totalNodes) => {
  const bases = types.map(instanceTypeBase).filter(Boolean);
  if (!totalNodes || totalNodes <= 0 || bases.length === 0) return types;
  const per = Math.floor(totalNodes / bases.length);
  const remainder = totalNodes % bases.length;
  return bases.map((base, i) => `${base} (${per + (i < remainder ? 1 : 0)})`);
};

function NodePoolCard({ recommendation }) {
  const currency = useCurrencyFormatter();
  if (!recommendation) {
    return <div>Error: No recommendation data</div>;
  }
  
  // Support both old format (NodePoolRecommendation) and new format (NodePoolCapacityRecommendation)
  const isNewFormat = recommendation.nodePoolName !== undefined;
  
  const nodePoolName = isNewFormat ? recommendation.nodePoolName : recommendation.name;
  const currentNodes = isNewFormat 
    ? recommendation.currentNodes 
    : (recommendation.currentState?.totalNodes || 0);
  const recommendedNodes = isNewFormat
    ? recommendation.recommendedNodes
    : (recommendation.maxSize > 0 ? Math.ceil(recommendation.maxSize / 2) : 0);
  const currentInstanceTypes = isNewFormat
    ? recommendation.currentInstanceTypes || []
    : (recommendation.currentState?.instanceTypes || []);
  const recommendedInstanceTypes = isNewFormat
    ? recommendation.recommendedInstanceTypes || []
    : (recommendation.instanceTypes || []);
  const currentCapacityType = isNewFormat
    ? recommendation.capacityType || ''
    : (recommendation.currentState?.capacityType || '');
  const recommendedCapacityType = recommendation.capacityType || '';
  const currentCost = isNewFormat
    ? recommendation.currentCost || 0
    : (recommendation.currentState?.estimatedCost || 0);
  const recommendedCost = isNewFormat
    ? recommendation.recommendedCost || 0
    : (recommendation.estimatedCost || 0);
  const currentCPU = isNewFormat
    ? recommendation.currentCPUCapacity || 0
    : (recommendation.currentState?.totalCPU || 0);
  const currentMemory = isNewFormat
    ? recommendation.currentMemoryCapacity || 0
    : (recommendation.currentState?.totalMemory || 0);
  const recommendedCPU = isNewFormat
    ? recommendation.recommendedTotalCPU || 0
    : 0;
  const recommendedMemory = isNewFormat
    ? recommendation.recommendedTotalMemory || 0
    : 0;
  
  const costUnknown = isNewFormat
    ? Boolean(recommendation.currentCostUnknown)
    : false;

  // Recommended types rendered with per-type node counts (even split), so the
  // card reads symmetrically against the current "type (N)" badges.
  const recommendedDisplayTypes = withNodeCounts(recommendedInstanceTypes, recommendedNodes);

  const hasChanges =
    currentNodes !== recommendedNodes ||
    JSON.stringify([...currentInstanceTypes].map(instanceTypeBase).sort()) !==
      JSON.stringify([...recommendedInstanceTypes].map(instanceTypeBase).sort()) ||
    currentCapacityType !== recommendedCapacityType;

  const hasGPU = (recommendation.requirements?.gpu > 0) || recommendedInstanceTypes.some(isGPUType);

  const costSavings = isNewFormat ? (recommendation.costSavings || 0) : (currentCost - recommendedCost);
  const costSavingsPercent = isNewFormat ? (recommendation.costSavingsPercent || 0) : (currentCost > 0 ? ((costSavings / currentCost) * 100) : 0);
  // Only color the card green when the recommendation actually saves money.
  const savesMoney = costSavings > 0 && !costUnknown;

  // Get taints - handle both formats
  const taints = recommendation?.taints || [];
  const taintsArray = Array.isArray(taints) ? taints : [];

  return (
    <Card
      className={cn(
        "h-full",
        hasChanges && (savesMoney ? "border-2 border-green-500" : "border-2 border-yellow-400")
      )}
    >
      <CardHeader>
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-2">
            <CardTitle>{nodePoolName}</CardTitle>
            {hasChanges && (
              <Badge
                variant="default"
                className={cn(savesMoney ? "bg-green-500" : "bg-yellow-500 text-yellow-950")}
                title={savesMoney ? "Recommended config saves money" : "Config change does not save money (may increase cost)"}
              >
                {savesMoney && <Check className="h-3 w-3 mr-1" />}
                {savesMoney ? 'Saves money' : 'Changes recommended'}
              </Badge>
            )}
          </div>
          <Badge variant={recommendedCapacityType === 'on-demand' ? 'default' : 'secondary'}>
            {recommendedCapacityType === 'on-demand' ? 'On-Demand' : 'Spot'}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4 mb-4">
          {/* Current State */}
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground font-semibold">Current</p>
            <div className="space-y-1">
              <p className="text-2xl font-semibold">{currentNodes}</p>
              <p className="text-xs text-muted-foreground">nodes</p>
            </div>
            {currentInstanceTypes.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {currentInstanceTypes.slice(0, 2).map((type, idx) => (
                  <Badge key={idx} variant="outline" className="font-mono text-xs">
                    {typeof type === 'string' ? type : type}
                  </Badge>
                ))}
                {currentInstanceTypes.length > 2 && (
                  <Badge variant="outline" className="font-mono text-xs">
                    +{currentInstanceTypes.length - 2}
                  </Badge>
                )}
              </div>
            )}
            {currentCPU > 0 && (
              <p className="text-xs text-muted-foreground">CPU: {currentCPU.toFixed(2)} cores</p>
            )}
            {currentMemory > 0 && (
              <p className="text-xs text-muted-foreground">Memory: {currentMemory.toFixed(2)} GiB</p>
            )}
            {costUnknown ? (
              <div className="mt-2" title="Some current nodes could not be priced (no instance-type label or no regional price). The figure below is a partial sum.">
                <p className="text-sm font-semibold text-muted-foreground">
                  {currency(currentCost)}/hr <span className="text-xs font-normal">(partial)</span>
                </p>
                <p className="text-[11px] text-muted-foreground">pricing unavailable for some nodes</p>
              </div>
            ) : currentCost > 0 ? (
              <div className="mt-2">
                <p className="text-sm font-semibold">
                  {currency(currentCost)}/hr
                </p>
              </div>
            ) : null}
          </div>

          {/* Recommended State */}
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground font-semibold">Recommended</p>
            <div className="space-y-1">
              <p className={cn("text-2xl font-semibold", savesMoney && "text-green-600")}>{recommendedNodes}</p>
              <p className="text-xs text-muted-foreground">
                {!isNewFormat && recommendation.minSize > 0 && recommendation.maxSize > 0
                  ? `nodes (${recommendation.minSize}-${recommendation.maxSize})`
                  : 'nodes'}
              </p>
            </div>
            {recommendedInstanceTypes.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {recommendedDisplayTypes.slice(0, 2).map((type, idx) => (
                  <Badge key={idx} variant="outline" className="font-mono text-xs">
                    {type}
                  </Badge>
                ))}
                {recommendedDisplayTypes.length > 2 && (
                  <Badge variant="outline" className="font-mono text-xs">
                    +{recommendedDisplayTypes.length - 2}
                  </Badge>
                )}
              </div>
            )}
            {recommendedCPU > 0 && (
              <p className="text-xs text-muted-foreground">CPU: {recommendedCPU.toFixed(2)} cores</p>
            )}
            {recommendedMemory > 0 && (
              <p className="text-xs text-muted-foreground">Memory: {recommendedMemory.toFixed(2)} GiB</p>
            )}
            {recommendedCost > 0 && (
              <div className="mt-2">
                <p className={cn("text-sm font-semibold", savesMoney && "text-green-600")}>
                  {currency(recommendedCost)}/hr
                </p>
              </div>
            )}
            {savesMoney && (
              <p className="text-xs text-green-600 font-medium mt-2">
                Savings: {currency(costSavings)}/hr ({costSavingsPercent.toFixed(1)}%)
              </p>
            )}
            {costUnknown && (
              <p className="text-xs text-muted-foreground mt-2">
                Savings can't be computed: current cost is partially unknown.
              </p>
            )}
          </div>
        </div>

        <Separator className="my-4" />

        {/* Taints */}
        {taintsArray.length > 0 && (
          <div className="mb-4 space-y-2 border-t pt-4">
            <div className="flex items-center gap-2">
              <p className="text-xs font-semibold text-muted-foreground">Taints</p>
              <Badge variant="secondary" className="text-xs">
                {taintsArray.length} configured
              </Badge>
            </div>
            <div className="flex flex-wrap gap-2">
              {taintsArray.map((taint, idx) => {
                const taintKey = taint?.key || taint?.Key || '';
                const taintValue = taint?.value || taint?.Value || '';
                const taintEffect = taint?.effect || taint?.Effect || '';
                const taintString = `${taintKey}${taintValue ? `=${taintValue}` : ''}:${taintEffect}`;
                return (
                  <Badge
                    key={idx}
                    variant="outline"
                    className="font-mono text-xs border-yellow-500 text-yellow-700 bg-yellow-50"
                  >
                    {taintString}
                  </Badge>
                );
              })}
            </div>
          </div>
        )}

        {/* Instance Types - Show All */}
        {recommendedInstanceTypes.length > 0 && (
          <div className="mb-4 space-y-2">
            <p className="text-xs font-semibold">
              Recommended Instance Types ({recommendedInstanceTypes.length})
            </p>
            <div className="flex flex-wrap gap-2">
              {recommendedDisplayTypes.map((type, idx) => (
                <Badge
                  key={idx}
                  variant={isGPUType(type) ? 'destructive' : 'secondary'}
                  className="font-mono text-xs"
                >
                  {type}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Current Instance Types for Comparison */}
        {currentInstanceTypes.length > 0 && hasChanges && (
          <div className="mb-4 space-y-2">
            <p className="text-xs font-semibold">
              Current Instance Types ({currentInstanceTypes.length})
            </p>
            <div className="flex flex-wrap gap-2">
              {currentInstanceTypes.map((type, idx) => {
                const isKept = recommendedInstanceTypes.map(instanceTypeBase).includes(instanceTypeBase(type));
                return (
                  <Badge
                    key={idx}
                    variant="outline"
                    className={cn(
                      "font-mono text-xs",
                      !isKept && "line-through opacity-60"
                    )}
                  >
                    {type}
                  </Badge>
                );
              })}
            </div>
          </div>
        )}

        {/* Reasoning/Explanation */}
        {(recommendation.reasoning || recommendation.aiReasoning) && (
          <Alert className="mt-4">
            <AlertTitle>
              {recommendation.aiReasoning && recommendation.aiReasoning.trim() !== ''
                ? '✨ AI-Enhanced Explanation'
                : (isNewFormat ? 'Explanation' : 'Why these changes?')}
            </AlertTitle>
            <AlertDescription>
              {recommendation.aiReasoning && recommendation.aiReasoning.trim() !== '' ? (
                <div className="space-y-2">
                  <p className="text-sm whitespace-pre-wrap">
                    {recommendation.aiReasoning}
                  </p>
                  {recommendation.reasoning && (
                    <Accordion type="single" collapsible>
                      <AccordionItem value="details">
                        <AccordionTrigger>Show technical details</AccordionTrigger>
                        <AccordionContent>
                          <p className="text-xs whitespace-pre-wrap">
                            {recommendation.reasoning}
                          </p>
                        </AccordionContent>
                      </AccordionItem>
                    </Accordion>
                  )}
                </div>
              ) : (
                <p className="text-sm whitespace-pre-wrap">
                  {recommendation.reasoning}
                </p>
              )}
            </AlertDescription>
          </Alert>
        )}

        {hasGPU && (
          <Alert className="mt-4">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>GPU instances in recommendation</AlertTitle>
            <AlertDescription>
              The recommended mix includes GPU instance types. GPU instances are
              significantly more expensive than CPU-only equivalents and require
              drivers/workloads that use them — verify your workload actually needs
              GPU before applying this recommendation.
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

export default NodePoolCard;
