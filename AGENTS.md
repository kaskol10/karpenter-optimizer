# AGENTS.md - AI Assistant Guidelines

This document provides context and guidelines for AI coding assistants working on the Karpenter Optimizer project.

## Project Overview

**Karpenter Optimizer** is a tool for optimizing Karpenter NodePool configurations based on actual cluster usage data. It analyzes Kubernetes workloads and node capacity to provide cost-optimized instance type recommendations.

### Key Purpose
- Analyze actual node capacity and usage (CPU/Memory) from Kubernetes cluster
- Generate cost-optimized NodePool recommendations using AWS instance types
- Provide AI-enhanced explanations of recommendations and their benefits
- Support both spot and on-demand instance type optimization

## Architecture

### Backend (Go)
- **Location**: `cmd/api/` (main entry), `internal/` (core logic)
- **Framework**: Gin (HTTP router)
- **Key Components**:
  - `internal/api/server.go` - REST API endpoints
  - `internal/recommender/recommender.go` - Legacy recommendation logic (cluster-summary based)
  - `internal/recommender/node_pool_recommender.go` - **PRIMARY** recommendation engine (NodePool-based)
  - `internal/kubernetes/client.go` - Kubernetes API client (nodes, pods, NodePools); `pods.go` adds `ListPods` (compact `PodSummary` for the Log Explorer picker) and generic `GetPodLogs` (no Karpenter gate — the gated `GetKarpenterLogs` stays for `/karpenter/logs`), plus `NewClientWithClientset` for DI and `IsNotFound` for 404 mapping
 - `internal/awspricing/client.go` - AWS Pricing API client for region-aware instance pricing, currency selection, regional endpoints, and transient endpoint failover
 - `internal/power/power.go` - Static EC2-family wattage table; `Estimate(instanceTypes)` returns fleet watts + coverage
 - `internal/ollama/client.go` - Ollama LLM client for AI explanations
 - `internal/llmhealth/probe.go` - Probes vLLM/sglang pods (`PodHealth`); rate diffs (tok/s, req/s) come from successive counter samples. `Metrics` (probe.go + `metrics.go`) is the exported Prometheus text-exposition parser (gauge/counter/histogram query helpers, per-label-variant histograms) shared by the serving and LiteLLM probers
 - `internal/litellm/probe.go` - Probes LiteLLM AI-gateway proxy pods' `/metrics` (discovered via `kubernetes.Client.FindLiteLLMPods`); aggregates replicas into `GatewayHealth` (in-flight, admission queue/rejections, error rate, E2E/TTFT/queue/overhead p95, spend, per-model breakdown, and breakdowns by three split dimensions — app `metadata_trace_name`, API key `api_key_alias`, team `team_alias` — each exposed top-level and nested per model). Bearer auth via `LITELLM_METRICS_API_KEY`; 401/403 → `AuthError` hint
 - `internal/hostedprices/catalog.go` - Daily copy of OpenRouter's public model price list (`GET https://openrouter.ai/api/v1/models`, no key) for the Serving tab's hosted comparison. `Catalog.Run(ctx)` refreshes every 24h (1h retry after a failure, logged once); `Lookup(model)` matches by Hugging Face id / id / canonical slug ignoring case, plus a `-instruct` fallback; free and variable-price entries are skipped. Started lazily by the first `/serving` request that finds pods (`Server.startHostedPrices`), so clusters without LLMs never call out. Optional: no egress = no comparison
 - `internal/usage/usage.go` - Actual pod and GPU usage for the Topology tab, **display only** (recommendations keep the no-Prometheus rule). `Prometheus` provider (`PROMETHEUS_URL`): p95 over 24h per pod via `quantile_over_time` over cAdvisor CPU/memory, plus DCGM `DCGM_FI_DEV_FB_USED` per GPU UUID (optional). `MetricsServer` provider: live pod usage from `metrics.k8s.io` through `kubernetes.Client.RawGet` (no metrics client dependency; `ParseQuantity` handles the quantity forms). `Collector` tries providers in order, caches the first answer (or a miss) for 60s, logs each provider's first failure once. Built by `newUsageCollector` in `internal/api/topology_usage.go`
 - `internal/placementhistory/store.go` - In-memory, delta-encoded record of where every pod ran (Topology time travel). `Snapshot` = nodes (identity, capacity, requested totals, GPU fields, last Karpenter `DisruptionReason`) + pods (placement, requests, HAMi devices). `Store.Add` keeps a full keyframe every `keyEvery` samples and a delta in between, pruning whole segments past the retention so the oldest entry is always a keyframe; `At(t)` rebuilds the latest sample at or before t; `Events(since)` diffs consecutive samples into `node-added`, `node-removed` (with the reason and its pod count) and `pod-moved` (same pod name, new node). Stdlib only. Fed by `Server.startPlacementSampler` → `samplePlacement` (`internal/api/placement_history.go`: `buildTopologyNodes` with 1000 pods per node + `kubernetes.Client.NodeDisruptionReasons`, which reads Karpenter Node events once per tick and parses "Disrupting Node: Underutilized" (with or without a "/Delete" suffix); per node the most telling reason wins (`reasonRank`: disruption decision > SpotInterrupted/InstanceUnhealthy > InstanceTerminating/InstanceStopping, which follow every termination), the latest among equals)
 - `internal/placementdurable/` - Durable copy of the placement history. `Store` interface (`Add(Record)`, `Load(now, retention)`, `Close`) and `PostgresStore` (table `placement_history`: `t` primary key, `keyframe`, `body` JSONB; partial index on keyframes). `Load` and the purge on every `Add` keep everything from the latest keyframe at or before `now - retention`, so the window can always be rebuilt. `placementhistory.Store.Add` returns the `Record` it stored (JSON keyframe or delta, `persist.go`), `Store.Load(records, now)` restores them on an empty store (skips leading deltas, unreadable rows, and everything when the newest is past the retention), and `ForceKeyframe()` makes the next sample a keyframe after a failed write. Wired in `internal/api/placement_history.go`: `initPlacementDurable` (DSN `PLACEMENT_HISTORY_DSN` → serving → gateway via `config.resolvePlacementHistoryDSN`; unreachable = memory only) restores on startup, `samplePlacement` writes each record
 - `internal/history/store.go` - In-memory cluster-trend ring buffer (CPU/mem/GPU/cost) for the cluster sparklines
 - `internal/servinghistory/store.go` - In-memory per-pod serving-metric ring buffer; `Add(ns,name,Point)`, `Series(ns,name,window)`, `LastIssue(ns,name,window,kvThresholdPct)` — powers `/serving/history` trends
 - `internal/gatewayhistory/` - Per-day LiteLLM gateway cost/token store (split dim + value). `Store` interface with `Add(deltas)` / `Daily(dim,since)` / `Close()`; `NewMemStore` (in-memory, resets on restart) and `NewPostgres` (durable, CNPG; schema auto-created, idempotent upserts, retention purge). A sampler (`Server.startGatewayHistorySampler` → `Server.sampleGateway`) diffs cumulative spend/token counters each 60s tick (clamps resets to 0) and writes `Delta`s — powers `/serving/gateway/history`
- `internal/servingdurable/` - Durable per-pod serving-sample store (clone of the `gatewayhistory` pattern). Table `serving_history` keyed by `(pod_key, t)` with retention index; `Add(points)` upserts and `Query(since)` returns closed-period rows. DSN from `SERVING_HISTORY_DSN`, falling back to the gateway `GATEWAY_HISTORY_DB_*` parts so both histories can share one CNPG. The serving sampler writes here when a DSN resolves, and `/serving/history?window=7d` merges durable rows with the live in-memory series (in-memory wins on overlap)
- `internal/alerts/` - Opt-in alerting engine. `Manager` (config + `pending→firing→cleared` state machine persisted to `alerts.stateFile`, restart-safe), `Evaluator` (table-driven conditions: cost spike vs 24h avg, disruption blocked >N min, serving KV-cache pressure, gateway errors/503s, serving pod offline — each with a `for` duration, min 30s, and a held-clear window), and `Senders` for ntfy/Discord/Slack/generic JSON webhook — all outbound URLs pass `ssrf.go` validation (http(s) only, no redirects, resolve-then-pin, refuse link-local/metadata/multicast) and are treated as credentials (`MaskURL` keeps host, redacts path to `/*`; `PUT` restores by index). Runs on the existing 60s sampler tick via `Server.tickAlerts` from a `Snapshot` of values the server already computes; `GET/PUT /api/v1/alerts/config` + `POST /api/v1/alerts/test` in `internal/api/alerts.go`
- `internal/api/metrics.go` - Opt-in Prometheus `/metrics` exporter (`METRICS_ENABLED`). A `prometheus.Collector` reads an **atomic snapshot** (`metricsSnapState`) that the samplers publish section-by-section (`recordClusterMetrics` from `sampleCluster`, `recordServingMetrics` from `sampleServing`, `recordGatewayMetrics` from `sampleGateway`, `recordDisruptionMetrics` from `tickAlerts`) — a scrape performs zero extra K8s/AWS Pricing calls. Gauges are `karpenter_optimizer_*` (cluster, per-NodePool, serving pod, gateway, disruptions). Route not registered (404) when disabled

### Frontend (React)
- **Location**: `frontend/src/`
- **Tooling**: Vite (`npm start` on :3000 with `/api` proxied to :8080, `npm run build` into `build/`; pages other than the Overview, the Log Explorer and the Overview's `Sparkline` are `React.lazy` chunks under one `Suspense` in `App.jsx`, so keep page imports lazy and recharts out of the entry chunk; `frontend/.dockerignore` keeps `node_modules`/`build`/`coverage` out of the image context), Vitest, ESLint (`eslint-config-react-app`); Node 22.12+. Files containing JSX use the `.jsx` extension (Vite parses by extension). Build-time env vars keep the `REACT_APP_` prefix (`import.meta.env.REACT_APP_*`, via `envPrefix`); production images configure the API URL at runtime through `public/config.js`
- **UI conventions**:
  - Dropdowns: use `components/ui/simple-select.jsx` (`SimpleSelect`, options `[{value,label}]`) or the Radix `Select` primitives. Never a native `<select>`. `SimpleSelect` maps an empty-string value ("All", "Off") to an internal sentinel, because Radix throws on `SelectItem value=""` (the cause of the #140 Log Explorer crash)
  - Card headers carry at most three badges: the name, one status, and one key fact. Secondary facts go in a quiet `MetaLine` ("g6e.12xlarge · spot · eu-west-1b", `components/NodeBits.jsx`)
  - Shared node pieces live in `components/NodeBits.jsx`: `GpuSummaryBadge`/`gpuSummaryText` (HAMi nodes show the GPU memory share), `PricingSourceLabel` (live AWS price vs estimate), `MetaLine`
  - Icons are lucide-react (`Gpu` for GPUs), never emoji
- **Key Components**:
  - `App.jsx` - Main application component. Navigation is three areas (`lib/routes.js` `AREAS`: Cluster = overview/nodes/topology/disruptions, Inference = serving/gateway, Optimize = recommendations/workloads), an area row (`NavItem`, links; an area reopens its last page) and a page row (`PageNav`). The page lives in the **path** (`pagePath`: `/` for overview, else `/<area>/<page>`) and its focus in the query (`?node=&pod=&gpu=` on Topology, `?pod=` on Serving), read by `parseLocation(pathname, search)` and written by `buildUrl(page, {focus, logs, keep})` with `pushState` + `popstate`. On load, old `?tab=` links and non-canonical paths are rewritten in place (`parseLocation(...).redirect`, `replaceState`); `?tab=logs&pod=x` → `/?logs=x`. The **log drawer** (`components/LogDrawer.jsx`, Radix Dialog around `LogExplorer`) is open while `?logs=` is present (`''` = picker, `ns/name` = that pod); `openLogs(pod)` pushes it on top of the current page (`history.state.drawer`), `closeLogs` steps back or drops the param. `navigate()` keeps the drawer and the page's own filters (`hooks/useUrlParam.js`, written with `replaceState`) when staying on the same page and drops the filters when switching pages. nginx's `try_files … /index.html` serves every path. The header holds `StatusStrip.jsx` (cluster connection and Karpenter from `/config`, last refresh from the shared polling clock, firing alerts from `GET /api/v1/alerts/status` polled every 60s and hidden when alerting is off) and the **command palette** (`components/CommandPalette.jsx`, ⌘K/Ctrl+K via `isPaletteShortcut` or the Search button; Radix Dialog combobox). `lib/commandPalette.js` builds items from `/topology` and `/serving` (fetched on open, reused for 60s): pages, actions (logs, theme), nodes (`?zoom=node&at=`), pods (topology focus), GPUs by UUID (`?zoom=gpu&at=&card=`), models (serving focus on the first replica); `search` scores every query word (exact > prefix > word prefix > substring > 3+ char subsequence, hint/keywords at half weight); `commandResults` handles the verbs `drain <node>` (`?drain=`), `logs <pod>` and `fit <size> [replicas]` (`?fit=&replicas=`). A palette jump calls `navigate(page, focus, params)` (params replace the page's own) and bumps `navSeq` in the page `key`, so a page already open remounts with the new params.
  - `lib/api.js` - The only place that resolves the API base URL (`API_URL`: runtime `window.ENV.REACT_APP_API_URL`, else build-time env, else same-origin) and installs the optional `API_AUTH_TOKEN` bearer header (`installApiAuth`, called from `index.jsx`). Import `API_URL` from here; never redefine it in a component
  - `lib/pollingClock.js` + `hooks/usePolling.js` - One polling clock for every auto-refreshing panel. Subscribers fire on wall-clock-aligned boundaries of their interval (all 30s pollers on :00/:30), pause while the tab is hidden and catch up once on return. `usePolling(fn, ms, enabled)` runs a stable (`useCallback`) fn now and on the clock; `usePollingTick(fn, ms, enabled)` runs only on the clock (panels with their own initial load and an auto-refresh toggle); `useLastRefresh()` feeds the header. Do not add raw `setInterval` polling Owns the dark/light **theme toggle** (header sun/moon, persisted to `localStorage` key `karpenter-optimizer-theme`, default = `matchMedia` system preference; `index.jsx` applies `.dark` to `<html>` before first paint to avoid flash) and the icon-based `NavItem` tab bar (lucide icons, active `primary` underline, `hover:bg-muted/40`, live disruption count badge on the Disruptions tab, `key={activeTab}` fade/slide-in page transition on `<main>`)
  - `components/AlertsSettings.jsx` - Alerting settings dialog (conditions with thresholds + `for` durations, remind-while-firing interval, channel list with masked URLs + per-channel test button); talks to `/api/v1/alerts/config` (GET/PUT) and `/api/v1/alerts/test`. Channel URLs are credentials: a masked URL (`/*` sentinel) is sent back on save and the server restores the stored value by index
  - `components/ui/empty-state.jsx` + `components/ui/skeleton.jsx` - Shared empty-state card (icon + title + hint + optional retry/action) and pulse `Skeleton`/`SkeletonRows` used by every tab (no layout shift while loading); error banners carry a retry button
  - `components/GlobalClusterSummary.jsx` - Cluster overview and recommendation trigger
  - `components/NodePoolCard.jsx` - Displays individual NodePool recommendations
 - `components/LogExplorer.jsx` - Log Explorer (generic, any pod), shown in the `LogDrawer` over any page. Pod picker (namespace dropdown + name/namespace typeahead, Karpenter pods flagged + sorted to top, restart count) → log viewer (container select, tail 100/500/1000/5000, since 5m/15m/1h/1d, "previous terminated container" toggle, client-side error-only filter, search with match highlight + prev/next, error-line tinting). "Analyze selection" / "Analyze errors" / "Analyze last 50" POST to `POST /api/v1/logs/analyze`; results render `summary`/`explanation`/`errorCauses`/`recommendations` (Karpenter `parsedError` block only when present). Accepts a `seedPod` ("namespace/name" or "namespace") prop for deep-links from other tabs (Workloads row **Logs**). Replaces the old Karpenter-only `KarpenterLogAnalyzer`
 - `components/NodeUsageView.jsx` - Real-time node resource usage visualization
 - `components/serving/` - Serving tab, one component per file: `ServingHealth.jsx` (the tab: data fetching, sort, view, layout), `ServingCard.jsx` (`ServingCard` + `DiagnosisPanel`; each card has the DOM id `servingCardId(pod)` and a `highlighted` ring), `ModelRow.jsx` (one model: replica status dots, aggregate stats, expands into its cards), `TriageList.jsx` (the **Needs attention** list), `ServingTrends.jsx`, `GatewayCard.jsx` (rendered by `GatewayPage.jsx`, the Inference → Gateway page, which fetches `/serving/gateway` itself and keeps `?view=`/`?split=` in the URL), `GatewayCostHistory.jsx`, and `shared.jsx` (`MetricTip`, `CopyableNode`, `copyText`, `STATUS_TONE_CLASSES`, formatters). Together: LLM serving (vLLM/sglang) inference health, **grouped by model** by default (`?view=model|replicas`; `lib/servingModels.js` `groupByModel` sums throughput/load and takes the worst replica's latency/KV, `sortModels` applies the same sort keys to rows; rows with a non-OK replica start expanded, user toggles win) with estimated **cost per 1M tokens** (`lib/servingCost.js` `modelCost`: replica costs summed over live tokens/s, only when every replica is priced; hosted price blended by the model's prompt/generation mix; `comparison` only in USD; `costInputsText` lists the inputs in a `MetricTip`) and **traffic headroom** (`lib/servingHeadroom.js` `modelHeadroom`: per-replica least-squares fit of KV % on req/s from history, ≥30 min and ≥10 samples, R² ≥ 0.3, capped at +300%, tightest replica wins, live queueing/KV pressure = none), under a **triage list** (`lib/servingTriage.js` `buildTriage`: non-OK replicas worst first, `issueSince` dates the current issue run from trend history with the same rules as `servinghistory.LastIssueIn`, actions Topology / Logs / kubectl copy menu via `kubectlCommands`) + sort (default **Needs attention**: `sortByAttention` orders worst-first by each status's `severity` — offline, under pressure, busy, slow, OK — then tokens/s; `?sort=throughput|requests|queue|name` for the others) + per-server status badge (OK/Busy/Slow/Under pressure via `getServingStatus` in `lib/servingStatus.js`) with an inline **diagnosis panel** on non-OK cards (reasons, "Try first" fix, link to Topology) + **GPU noisy-neighbour detection** (computed server-side and returned by `/api/v1/serving` as `gpuNeighbours`, read by `lib/servingPlacement.js` `placementFromServing`; the Topology tab's `findGpuNeighbours` applies the same rules to topology data: pods on the same physical GPU by HAMi UUID, or time-slicing on single-GPU nodes; a troubled server names its neighbours and leads its fixes with moving them; healthy servers show a quiet "Shares GPU … with N pods" chip) + per-card **Show in topology** deep links (`onOpenTopology(topologyFocusFor(pod, placement))` → `{node, pod, gpu}`) + **Logs** deep links (`onOpenLogs(pod)` → the log drawer, `?logs=ns/name`) + a per-card **latency split** bar (mean time to first token vs mean generation time, `lib/servingLatency.js` `latencySplit`; scaled to the slowest online replica of the same model so outliers stick out; means because they add up, p95s do not) + per-metric **help popovers** (`MetricTip`: a `?` button next to each label opens its definition; replaces the old "What do these metrics mean?" accordion) + per-card **collapsible** Trends sparklines (TTFT p95, E2E p95, KV cache %, throughput, req/s over 1h/6h/24h; collapsed by default showing a KV%/throughput/last-issue summary line) + per-card GPU card-UUID badges (`gpuDevices` from the HAMi annotation, short UUID + memory, full UUID in tooltip) + **LiteLLM Gateway card** (stat tiles: in-flight, queued, 503s, error rate, E2E p95, overhead p95, req/s; **Split by** segmented control — App / API key / Team, default App — driving both the breakdown table and the expandable per-model detail; per-model table with **expandable rows** revealing the per-model breakdown for the selected split dimension (tokens in/out/total + spend); **Apps/Models/Flow toggle** (`?view=apps|models|flow`, default Apps; **Flow** is `GatewayFlow.jsx`, a recharts `Sankey` from Split-by values to models sized by tokens or spend, built by `lib/gatewayFlow.js` `buildFlow` from `models[].apps|apiKeys|teams` with the smaller sources/targets folded into "N other …" nodes beyond 8, plus `topFlows` as a table under the chart; nodes on the same violet ramp as Usage by day) with a per-dimension table — token total + input/output split, req total, tokens/s, spend; amber banner with `LITELLM_METRICS_API_KEY` hint on 401/403; the Gateway page shows an empty state when no LiteLLM proxy is detected) fed by `/api/v1/serving/gateway`. The card also renders a **Usage by day** dashboard (`GatewayCostHistory`, recharts) fed by `/api/v1/serving/gateway/history` — a stacked per-day bar chart (UTC days, 00:00–23:59) following the active Split-by dimension with a spend/tokens toggle + optional daily-total line, plus a per-day table (day / spend / tokens / top consumer) and a 7/14/30-day window selector. Series are colored on a **single-hue violet ramp ranked by window usage** (darkest = biggest consumer). **Interactive**: hovering a series (bar segment or pill legend chip) highlights it across all days with a soft gradient area under its evolution curve, dims the others, shows a rich tooltip (value, % of day, % of window, day total) and a live stat strip (window total, share, avg/day, today-vs-average delta); clicking a chip pins the highlight. The legend is a row of pill chips (name + window share %).
 - `components/topology/` - Topology tab, one component per file: `TopologyView.jsx` (the tab: URL-backed filters, focus handling, zoom level and lens; data comes from `hooks/useTopologyData.js` (`/topology`; a 404 is an error naming the frontend/backend mismatch, there is no `/nodes` fallback; lens data fetched only when needed) and the what-ifs from `hooks/useDrainPlan.js`), `NodeList.jsx` (Node level: cards grouped by NodePool, owns expand/detail-filter state), `DrainPanel.jsx` (drain simulation result), `ClusterMap.jsx` (Cluster level: tiles by NodePool → zone, sized by allocatable CPU via `tileSize`, smaller as the cluster grows via `tileRange`), `PoolMap.jsx` (NodePool level: larger tiles with request bars), `GpuDetail.jsx` (GPU level: one tank + named slices, Serving/Logs links), `ZoomBreadcrumb.jsx`, `LensBar.jsx` (lens picker + always-on legend), `Minimap.jsx` (whole cluster in the corner below the Cluster level), `NodeCard.jsx` (one node: badges, bars, GPU tanks, drill-down), `TopologyFilters.jsx`, `NodePodBar.jsx`, `GPUTanks.jsx` (one vertical tank per physical GPU, pods stacked by memory, free on top, fragmentation line, fit rings), `FitCheck.jsx` (the **Will it fit?** box, `?fit=40GiB`), `FocusBanner.jsx`, `CopyablePodName.jsx`, `NodeActions.jsx` (one **Actions** menu per node: copy `kubectl describe node` / pods on node / `drain --dry-run=client` from `lib/nodeActions.js`, disruption status, logs for any pod via `logTargets`), `BlastRadius.jsx` (`BlastRadiusSummary` at the Cluster level, `BlastRadiusNote` on node cards; `lib/blastRadius.js` `workloadSpread` flags multi-replica workloads with every replica on one node or in one zone, skipping DaemonSets, Jobs and single replicas, judged over all nodes), and `podUtils.js` (pod keys, metric weights). **Drain simulator** (`lib/drainSim.js` `simulateDrain`, `?drain=a,b`, toggled from the node Actions menu): first-fit decreasing of every non-DaemonSet pod on the drained nodes onto the rest, same NodePool first, on CPU/memory and per-GPU memory (fractional = room on one card, whole GPU = empty cards, count-only nodes = free GPU count); lists unplaced pods with a reason, savings = drained `costPerHour` × 730 (null if any unpriced), and `NOT_MODELLED`. **Placement planner** (`lib/placementPlanner.js` `planPlacement`, `?fit=&replicas=`): candidate cards ranked by free memory, replicas placed new zone > new node > best fit, drained nodes excluded, message for partial/none/single node/single zone; multi-replica plans badge cards R1, R2… in `GPUTanks`. Both run over all nodes, not the filtered view. **Time travel** (`hooks/useTopologyHistory.js`, `TimeScrubber.jsx`, `ChangesPanel.jsx`, `lib/topologyHistory.js`): a **History** button opens the timeline (fetched only then, or when the URL carries `?time=`/`?compare=` — not `?at=`, which the zoom level owns — so the live view makes no extra request; refreshed every 2 min on the shared clock). `?time=` swaps the live nodes for `/topology/history` everywhere in the view (usage off); `?compare=` keeps live nodes and `diffTopology(baseline, live)` feeds `ChangesPanel` and `withChanges` (ClusterMap: `change: added` = green ring, `removed` = dashed ghost tile). Snapshot fetches are debounced 250 ms and stale answers dropped. `eventMarkers` buckets `/topology/events` along the slider (red = termination, green = launch, amber = move). **Usage** (when `/topology` reports a source): `NodePodBar` hatches the requested-but-unused part of each CPU/memory segment (`podUsedShare`, `HATCH`; red edge over request), `GPUTanks` draws a dashed DCGM in-use line with the idle reservation hatched, and the **Usage** lens (`nodeUsageRatio`) appears; without a source it is hidden and `?lens=usage` falls back to Requests. GPU layout lives in `lib/gpuFit.js`: `nodeGpus(node)` lays **all** of a node's GPU pods on its cards (HAMi placement by UUID; cards no pod references are listed; unplaced whole-GPU pods take whole free cards; unplaced fractional pods go on the emptiest such card and mark it `uncertain`), `fragmentation`, `gpuFits` (`yes`/`maybe`/`no`, memory only), `clusterFit`, `parseSize`. Tanks render whenever node GPU memory is known; otherwise the count bar. Filters fade hidden pods but never free their memory. **Semantic zoom** lives in `hooks/useTopologyZoom.js` (`?zoom=cluster|pool|node|gpu&at=&card=`, one `pushState` entry per level, follows `popstate`; zooming drops a Serving focus link). Default level is Cluster; a focus link shows Node until an explicit `?zoom=` wins (`onFocusDone` clears App's focus). **Lenses** are `lib/topologyLenses.js` (`LENSES`, `lensColor`, `lensLegend`, `lensContext`, `nodeFullness`, `servingByNode`, `disruptionsByNode`, `groupNodes`): requests, capacity type, age, cost (`costPerHour` from `/topology`), serving health (fetches `/serving` only when picked) and disruption (fetches `/disruptions` only when picked); grey always means no data. Plain DOM tiles (measured: 1,000-node recolour < 100 ms). Together: pods-on-nodes view grouped by NodePool (CPU/memory request bars, per-physical-GPU memory tanks). Accepts a `focus` (`{node, pod, gpu}`) prop for deep links: shows a focus banner (who shares the pod's GPU, or a note if Karpenter removed the node), clears filters, scrolls to and rings the node card, outlines the pod in primary and its GPU neighbours dashed amber; `onBackToServing` / `onClearFocus` callbacks
 - `components/DisruptionTracker.jsx` - Node disruption tracking (on-demand)

## Key Data Structures

### NodePoolCapacityRecommendation (Primary Format)
```go
type NodePoolCapacityRecommendation struct {
    NodePoolName             string   `json:"nodePoolName"`
    CurrentNodes             int      `json:"currentNodes"`
    CurrentInstanceTypes     []string `json:"currentInstanceTypes"` // Format: "m6g.2xlarge (27)"
    CurrentCPUUsed           float64  `json:"currentCPUUsed"`
    CurrentCPUCapacity       float64  `json:"currentCPUCapacity"`
    CurrentMemoryUsed        float64  `json:"currentMemoryUsed"`
    CurrentMemoryCapacity    float64  `json:"currentMemoryCapacity"`
    CurrentCost              float64  `json:"currentCost"`
    Currency                 string   `json:"currency"` // ISO currency code for cost fields (USD or CNY)
    RecommendedNodes         int      `json:"recommendedNodes"`
    RecommendedInstanceTypes []string `json:"recommendedInstanceTypes"`
    RecommendedTotalCPU      float64  `json:"recommendedTotalCPU"`
    RecommendedTotalMemory   float64  `json:"recommendedTotalMemory"`
    RecommendedCost          float64  `json:"recommendedCost"`
    CostSavings              float64  `json:"costSavings"`
    CostSavingsPercent       float64  `json:"costSavingsPercent"`
    Reasoning                string   `json:"reasoning"` // AI-generated explanation
    Architecture             string   `json:"architecture"` // arm64 or amd64
    CapacityType             string   `json:"capacityType"` // spot or on-demand
}
```

### NodeInfo (from Kubernetes client)
```go
type NodeInfo struct {
    Name          string
    InstanceType  string
    Architecture  string
    CapacityType  string // "spot" or "on-demand"
    NodePool      string
    CPUUsage      *ResourceUsage
    MemoryUsage   *ResourceUsage
    PodCount      int
    GPUCapacity   float64 // nvidia.com/gpu.count label (preferred) else Status.Capacity
    GPUAllocated  float64 // nvidia.com/gpu allocated to scheduled pods
    GPUModel      string  // from nvidia.com/gpu.product label (may be empty)
    GPUMemTotalMiB     float64 // total GPU memory (MiB, 0 when unknown)
    GPUMemAllocatedMiB float64 // GPU memory allocated to scheduled pods (MiB)
    GPUPods       int   // scheduled pods requesting >= 1 GPU
    HamiDetected  bool  // HAMi/KAI fractional sharing detected on this node
    // ...
}
```

### No-Karpenter / On-Prem Mode
- `kubernetes.Client.HasKarpenter()` probes the `karpenter.sh` API group (cached via `sync.Once`).
- `Server.karpenterDetected` is set at startup; `/api/v1/config` exposes `karpenter.detected`.
- NodePool-CRD endpoints (`/recommendations`, `/nodepools`, `/nodepools/recommendations`, `/nodepools/{name}`, `/recommendations/cluster-summary` + SSE, `/agent/cost-optimization`) return **503** `{"code":"karpenter_not_found"}` when Karpenter is absent (the SSE variant emits an `error` event).
- Cluster cost is reported as `costUnknown: true` (frontend shows "n/a") when no node has an `instance-type` label.

### AWS Regional Pricing and Currency
- `internal/awspricing/client.go` is the source of truth for `PricingCurrencyForRegion`, AWS Pricing API region/location mappings, regional endpoints, and retry classification.
- Commercial AWS regions return USD pricing. `cn-north-1` and `cn-northwest-1` use the China Pricing API endpoint (`cn-northwest-1`) and their respective product locations (Beijing and Ningxia), and return CNY.
- `/api/v1/config` exposes `aws.region` and `aws.currency`. Cost and recommendation payloads should carry currency metadata where they expose monetary values; do not assume response amounts are always USD.
- The frontend currency helpers live in `frontend/src/lib/currency.js`. `App.jsx` provides the configured region context; use `useCurrencyFormatter()` (or `formatCurrency(value, region)`) for cost values to render `CN¥` in China and `$` elsewhere.
- Commercial Pricing API calls prefer `us-east-1` for Americas, `eu-central-1` for Europe/Middle East/Africa, and `ap-south-1` for Asia-Pacific. Retry through the other commercial endpoints only for transient network, timeout, throttling, or server failures; do not fail over authorization/invalid-request errors. Preserve the configured workload-region product-location filter regardless of endpoint. China requests must not fail over to the commercial partition.
- Pricing-index hosts are partition-aware, and discovered products must match the configured AWS region's Pricing API location; do not use cross-region index entries as instance candidates.
- On-demand live AWS Pricing API results are preferred. Spot cost is an estimate using `awspricing.SpotDiscountFactor` (25% of on-demand), not a live Spot quote.
- Hardcoded on-demand snapshots and family estimates are restricted to `us-east-1`; never treat a USD estimate as a price for another commercial region or China. The dated China CNY snapshot is only for supported types when live pricing is unavailable due to transient/API access failures. Do not use it when the API explicitly reports `awspricing.ErrNoPricingFound` for the target region.
- If an instance in a mixed-type cost calculation cannot be priced, return an unknown result rather than a partial total that would understate cost. Keep the pricing source (`aws-pricing-api`, `hardcoded`, `regional-fallback`, `family-estimate`, or `unknown`) accurate.
- China fallback instance candidates must be regionally available and respect the requested architecture, including AMD types where available. Filter out known unavailable families; do not expose generic global fallback types as China offerings.

### GPU (allocation-based, core v1 only)
- Count: `nvidia.com/gpu.count` **node label wins** (MIG/time-slicing inflates `Status.Capacity`); fallback to `Status.Capacity["nvidia.com/gpu"]`. Model from `nvidia.com/gpu.product` label.
- Memory (MiB): node total = `nvidia.com/gpu.memory` (per-GPU MiB) x count, else `Status.Capacity["nvidia.com/gpumem"]` (HAMi node total); 0 = unknown (memory UI hidden).
- Pod memory claim precedence: `hami.io/vgpu-devices-allocated` annotation (actual placement, e.g. `;GPU-<uuid>,NVIDIA,45000,0:;`) > `nvidia.com/gpumem` request (HAMi vGPU) > `nvidia.com/gpu` x per-GPU mem (whole-GPU) > 0 (unknown).
- **HAMi detection**: `NodeInfo.HamiDetected` is true when any scheduled pod on the node has a `nvidia.com/gpumem` request/limit or the hami annotation, or the node itself exposes `nvidia.com/gpumem` in Capacity/Allocatable. When detected, the UI switches from count-based to **memory-percent** GPU reporting (memory % in use + GPU pod count), since fractional-GPU pods make whole-GPU counts misleading.
- `NodeInfo.{GPUCapacity,GPUAllocated,GPUModel,GPUMemTotalMiB,GPUMemAllocatedMiB,GPUPods,HamiDetected}`, `PodInfo.{GPURequested,GPUMemRequestMiB,GPUDevices}`, `TopologyPodResources.{GPU,GPUMemMiB}`, `TopologyPod.gpuDevices` (HAMi placement: per-device index/uuid/memory for the topology view's per-GPU tanks — tanks and badges are keyed by **uuid** because HAMi's allocated **index** can be wrong; short-UUID labels, full UUID in tooltips), `TopologyNode` GPU fields, and the `gpu` block in `/api/v1/cluster/summary` (`{total, allocated, free, memoryTotalMiB, memoryAllocatedMiB, hamiDetected, podsWithGPU, byModel[{model,total,allocated,memoryTotalMiB,memoryAllocatedMiB,pods}]}`).
- `parseHamiVGPUDevices()` / `PodInfo.GPUDeviceMemoryMiB()` parse the HAMi annotation.

## API Endpoints

### Primary Recommendation Endpoints
- `GET /api/v1/recommendations` - NodePool-based recommendations (uses `GenerateRecommendationsFromNodePools`)
- `GET /api/v1/nodepools/recommendations` - Same as above, returns recommendations array
- `GET /api/v1/recommendations/cluster-summary` - **Enhanced with Ollama explanations** (uses nodepools endpoint + Ollama)
- `GET /api/v1/recommendations/cluster-summary/stream` - SSE version with progress updates

### Data Endpoints
- `GET /api/v1/nodepools` - List all NodePools with actual node data
- `GET /api/v1/nodes` - Get all nodes with usage data
- `GET /api/v1/config` - Runtime configuration including `aws.region` and `aws.currency`; frontend uses these to format cost values regionally
- `GET /api/v1/cluster/summary` - Cluster-wide statistics
- `GET /api/v1/topology/history?at=<unix|RFC3339>` - The `/topology` node shape rebuilt from the latest placement sample at or before `at` (the URL second counts whole), with `at` (sample time), `history` (`{samples, from, to, intervalSeconds, retentionHours}`), cost at today's prices, `usage`/`gpuUsage` `null`. 400 bad `at`, 404 before the first sample, 503 when history is off
- `GET /api/v1/topology/events?since=6h` - `{history, events[]}` from `placementhistory.Events`: `{at, type: node-added|node-removed|pod-moved, node, nodePool, instanceType, capacityType, reason, pods, pod, from, to}`
- `GET /api/v1/topology` - Nodes with their pods (requests, HAMi GPU placement), GPU fields, and `costPerHour` / `costSource` / `pricedAs` per node (`internal/api/topology_cost.go` `attachTopologyCost`, the same memoised `instancePricer` as serving cost; unknown capacity type priced as on-demand; `null` when unpriceable), plus a top-level `currency`. With a usage source it adds `usage` per pod (`{cpuCores, memoryGiB}`), top-level `usage` (`{source: "prometheus"|"metrics-server", window, fetchedAt}`, `null` without a source) and `gpuUsage` (UUID → MiB in use, DCGM, `null` without it)
- `GET /api/v1/serving` - Inference health for detected LLM serving pods (vLLM/sglang); per pod: model, KV cache %, running/waiting, TTFT (mean+p95), E2E latency (`e2eSeconds`/`e2eP95Seconds`, mean+p95), `preemptions` (vLLM's lifetime counter) and `preemptionsRecent` (its increase over the last `llmhealth.PreemptionWindow` = 5 min, null until the second probe; **status and alerts must use this one** — a lifetime count says nothing about now), `tokensPerSec`, `requestsPerSec` (rates derived from counter diffs, nil on first sample or when the upstream metric is absent), placement (`node` = node name, `nodeHostname` = `kubernetes.io/hostname` label falling back to the node name, `nodeInstanceType`, `gpuModel`, `gpuCapacity` — filled server-side via `kubernetes.Client.GetNodePlacement` from node labels), and `gpuDevices` (specific physical GPU cards, `{uuid,model,memoryMiB,index}` from the HAMi/KAI `hami.io/vgpu-devices-allocated` annotation — only present on HAMi/KAI clusters), plus `gpuNeighbours` (`[{uuid, index, pods: [{namespace, name, memoryMiB}]}]`: the GPUs this pod shares and the other pods on each; `[]` = alone, `null` = not computed) and `gpuNeighboursPrecise` (matched by HAMi UUID vs inferred on a single-GPU node). Also `promptTokensPerSec` / `generationTokensPerSec` (input/output split of `tokensPerSec`), `gpuRequested`, `nodeCapacityType`, `nodeGpuMemMiB`, an estimated `cost` per replica (`internal/api/serving_cost.go`: node price from the recommender's pricing cache, spot-aware, unknown capacity type priced as on-demand, times `replicaGPUShare` — HAMi placement memory over node GPU memory (`shareBasis: "gpu-memory"`), else GPUs over the node's GPU count (`"gpu-count"`); `null` when unpriceable) and `hostedPrice` (OpenRouter list price, USD per 1M input/output tokens; `null` when not in the catalog). Neighbours, cost and hosted prices are computed only by the endpoint (`internal/api/serving_neighbours.go`, `attachGPUNeighbours` → `gpuNeighboursFor`, one pod list over the nodes hosting serving pods), not by the history sampler, and mirror the frontend `findGpuNeighbours` rules. The serving card displays `nodeHostname` (click-to-copy copies `node`).
- `GET /api/v1/serving/history?window=1h|6h|24h|7d` - Per-pod serving metric trends. A background sampler (same 60s interval as the cluster trends, `Server.startServingHistorySampler` → `Server.sampleServing`) probes serving pods on each tick and appends a sample to the in-memory `servinghistory.Store` (retention = `HISTORY_WINDOW_HOURS`). Returns per pod `{namespace, name, window, points[], lastIssue}`; `lastIssue` is the Unix time of the most recent sample in the window where the pod was offline / `waiting>0` / new preemptions since the previous online sample / KV cache ≥ 85% (0 = none; `servinghistory.LastIssueIn`, shared by the in-memory and durable paths). In-memory by default (resets on restart); **durable** via the `servingdurable` Postgres store when `SERVING_HISTORY_DSN` (or the gateway `GATEWAY_HISTORY_DB_*` parts) resolves — then `7d` is accepted and the response merges durable rows with live samples (in-memory wins on overlap). Window parsing accepts `Nd` day suffixes (`internal/api/serving_durable.go`, `parseServingHistoryWindow`)
- `GET /api/v1/serving/gateway` - LiteLLM AI-gateway health (new). Returns `{gateway: GatewayHealth|null}` — `null` when no LiteLLM proxy pod is detected (frontend hides the card). `GatewayHealth`: `pods` (replicas found), `online`, `authError` (401/403 hint → set `LITELLM_METRICS_API_KEY`), `inFlightRequests`, `admissionQueued`, `admissionRejected` (503s), `totalRequests`, `failedRequests`, `errorRatePct`, `requestsPerSec` (counter diffs, nil until 2nd sample, 0 on counter reset), `e2eP95Seconds`, `ttftP95Seconds`, `queueTimeP95Seconds`, `overheadP95Seconds` (gateway-side processing, isolates gateway cost from model latency), `spend` (USD), and `models[]` (`model`, `requestsTotal`, `failedRequests`, `errorRatePct`, `requestsPerSec`, `tokensPerSec`, `e2eP95Seconds`, `ttftP95Seconds`, `spend`, plus a nested `apps[]` / `apiKeys[]` / `teams[]` per model — `name`, `tokensTotal`, `tokensInput`, `tokensOutput`, `spend`, derived from the `model`+split-label co-labeled token/spend series). Top-level `apps[]`, `apiKeys[]` and `teams[]` (each: `name`, `requestsTotal`, `tokensTotal`, `tokensInput`, `tokensOutput`, `tokensPerSec`, `spend`) group usage by `metadata_trace_name`, `api_key_alias` and `team_alias` respectively; values without a real label are grouped as `(unattributed)`. Counters/gauges summed across replicas; quantiles = worst case across replicas. 15s cache
- `GET /api/v1/serving/gateway/history?split=total|app|apikey|team&window=14d` - Per-day LiteLLM gateway cost & token usage (new). Days are **UTC (00:00–23:59)**; incremental per-day rollups (no midnight job) — a 60s sampler diffs the cumulative spend/token counters and upserts each interval into its day, so closed days are final and read only from the store (the gateway is never re-queried for them) while today updates live. Counter resets clamp the interval diff to 0. Returns `{window, split, store: "postgres"|"memory", days[]}` where each `days[]` row is `{day, dayTs, value, spend, tokens}` (oldest first, `value` empty for `split=total`). In-memory store by default (resets on restart); durable Postgres/CNPG when `GATEWAY_HISTORY_DSN` (or `GATEWAY_HISTORY_DB_*`) is set — the chart provisions a small CNPG `PostgresCluster` on `database.enabled: true`
- `GET /api/v1/disruptions?hours=N` - Live node disruptions (FailedDraining events + nodes marked for deletion). Each item includes `capacityType`, `eventCount` (real FailedDraining event count), `costPerHour`/`costSource` (spot-aware, from cached pricing), plus a top-level `summary` (`blockedCount`, `activeCount`, `totalCostPerHour`, `totalCostPerDay`, `byNodePool`). Backend fetches pods (one paginated list) and PDBs (one list) per request, not per node/pod.
- `GET /api/v1/disruptions/recent?hours=N` - Recently deleted (completed) disruption nodes

### Karpenter Log Analysis Endpoints
- `POST /api/v1/karpenter/logs/analyze` - Analyze Karpenter error logs and provide explanations

### Log Explorer Endpoints (generic, any pod)
- `GET /api/v1/pods?namespace=` - Compact pod summaries for the Log Explorer picker (`name`, `namespace`, `nodeName`, `status`, `ready`, `age`, `containers[]`, `restartCount`, `karpenter`). Paginated internally; no label gate (unlike Karpenter pod discovery). Backed by `kubernetes.Client.ListPods`
- `GET /api/v1/pods/logs?namespace=&pod=&container=&tailLines=&sinceSeconds=&previous=` - Container logs for **any** pod (generic counterpart of the gated `GET /api/v1/karpenter/logs`). `container` is validated against the pod spec (400 if unknown); a missing pod is a 404. Backed by `kubernetes.Client.GetPodLogs` — **no** Karpenter label gate, so it is a deliberate cluster-wide log surface gated only by the standard `/api/v1` auth
- `POST /api/v1/logs/analyze` - Body `{log}`. Tries the Karpenter-JSON analyzer first (when the body parses as a Karpenter structured log line), otherwise the **generic** analyzer: LLM explanation when an LLM client is configured, else a built-in heuristic classifier (OOM, image pull, crash loop, permission/admission, network, disk pressure, panic, generic error) with per-pattern recommendations. Returns a `LogAnalysisResponse` (`summary`, `explanation`, `errorCauses[]`, `recommendations[]`; `parsedError` is only set on the Karpenter-JSON path)

### Alerting Endpoints
- `GET /api/v1/alerts/status` - `{enabled, firing: [{id, title, severity, since}]}` from `alerts.Manager.Status` → `Evaluator.Firing` (firing and held-clear conditions, oldest first); always 200, `enabled: false` without a manager, when disabled or with no channel
- `GET /api/v1/alerts/config` - Alerting config with channel URLs **masked** (host kept, path redacted to `/*`). 503 `alerts not configured` when no channels/state are set up
- `PUT /api/v1/alerts/config` - Replace the config (conditions + `for` durations + thresholds, `remindWhileFiring`, channels). A masked or blank URL at index `i` restores the previously stored URL by index so toggling never wipes secrets. Persists to `alerts.stateFile`
- `POST /api/v1/alerts/test` - Send a test payload to the given channel (body `{type, url, priority?, tags?}`); SSRF-validated before sending
- `GET /metrics` - Prometheus text-0.0.4 exporter, **only registered when `METRICS_ENABLED=true`** (404 otherwise). Data comes from the atomic sampler snapshot — a scrape makes no extra Kubernetes or AWS Pricing API calls

## Important Patterns and Conventions

### 1. Recommendation Generation Flow
```
1. Fetch NodePools with actual nodes (ListNodePools)
2. For each NodePool:
   a. Calculate current capacity (CPU/Memory allocatable from nodes)
   b. Calculate current cost (based on actual instance types and capacity types)
   c. Find optimal instance types (findOptimalInstanceTypesWithCapacityType)
   d. Try both spot and on-demand to find best cost
   e. Only recommend if cost savings > 0
3. Enhance with Ollama explanations (if Ollama available)
```

### 2. Capacity Type Handling
- **Always analyze actual node capacity types** (spot vs on-demand)
- **Try both spot and on-demand** when finding optimal instance types
- **Prefer spot** if nodes are already spot, or if converting on-demand to spot saves money
- **Default to on-demand** if capacity type is unknown

### 3. Cost Calculation
- **Current Cost**: Sum of individual node costs based on:
  - Instance type
  - Actual capacity type (spot = 25% of on-demand, on-demand = full price)
- **Recommended Cost**: Based on recommended instance types and capacity type
- **Currency is region-dependent**: commercial regions use USD; China regions `cn-north-1` and `cn-northwest-1` use CNY. Propagate currency metadata and format UI costs accordingly.
- **Price source order**: live AWS Pricing API (cached by the pricing client), applicable dated regional snapshot/fallback, then an allowed family estimate. `us-east-1` USD snapshots/family estimates are never reused in other regions; China must not fall back to USD estimates. A known regional no-product response is not an API outage and must not be masked by a fallback snapshot.
- If any instance in a mixed configuration has no valid price, return an unknown cost instead of summing only the priced subset.

### 4. Instance Type Selection
- **Query AWS Pricing API** for available instance types (future-proof)
- **Filter available types by configured region and architecture** (arm64 vs amd64); China offline candidates must be China-available and may include AMD types
- **Filter by CPU/Memory ratio** (memory-optimized, CPU-optimized, general-purpose)
- **Try combinations** of 1-3 instance types
- **Sort by cost efficiency** (cost per unit of capacity)

### 5. Node Usage Calculation
- **Use resource requests only** (not limits)
- **Exclude init containers** from usage calculation
- **Only count scheduled pods** (with `spec.nodeName` set)
- **Exclude terminating/terminal pods** (Succeeded, Failed phases)

### 6. Pricing and Currency Tests
- Cover China endpoint/location/currency mappings, commercial endpoint preferences, and transient-only failover behavior.
- Verify currency extraction reads CNY for China and USD for commercial regions, and check UI formatting for each.
- Test regional index filtering, negative-cached no-product responses, and the distinction between unavailable pricing and transient API failures.
- Verify China fallback candidate availability for both architectures and ensure `us-east-1` fallback prices are not reused in other regions.

### 7. Frontend Format Support
- **Support both formats**: Old (`NodePoolRecommendation`) and new (`NodePoolCapacityRecommendation`)
- **Detect format** using `recommendation.nodePoolName !== undefined`
- **Map fields appropriately** for backward compatibility

## Key Files and Their Purposes

### Backend Core Files
- `internal/recommender/node_pool_recommender.go` - **PRIMARY recommendation engine**
  - `GenerateRecommendationsFromNodePools()` - Main recommendation function
  - `findOptimalInstanceTypesWithCapacityType()` - Finds best instance types and capacity type
  - `getCandidateInstanceTypes()` - Gets candidate instance types (AWS API or fallback)
  - `EnhanceRecommendationsWithOllama()` - Adds AI explanations

- `internal/recommender/recommender.go` - Legacy recommendation logic
  - `GenerateRecommendationsFromClusterSummary()` - Cluster-wide recommendations (deprecated)
  - `estimateCost()` - Cost calculation with AWS Pricing API integration
  - `estimateInstanceCapacity()` - Estimates CPU/Memory for instance types

- `internal/kubernetes/client.go` - Kubernetes integration
  - `ListNodePools()` - Lists NodePools with actual node data
  - `GetAllNodesWithUsage()` - Gets all nodes with CPU/Memory usage
  - `GetPodsOnNodes()` - Pods (requests, limits, QoS, GPU placement) on a set of nodes from **one** paginated pod list grouped by node; never list per node (field selectors take a single `spec.nodeName`, so per-node calls each list the whole cluster)
  - `GetNodeDisruptions()` - Tracks node disruptions (FailedDraining events + deletion-marked nodes); fetches pods/PDBs in batch (no per-node fan-out) and attaches `capacityType`

- `internal/awspricing/client.go` - AWS Pricing API
  - `GetProductPrice()` - Gets regional instance pricing (on-demand or estimated spot), with currency-aware parsing, caching, and transient-only endpoint failover
  - `GetAvailableEC2InstanceTypes()` - Lists instance types whose Pricing API product location matches the configured AWS region
  - `PricingCurrencyForRegion()` - Selects USD for commercial regions and CNY for China
- `frontend/src/lib/currency.js` - Region-context currency formatting helpers used for cost values across the UI

- `internal/api/server.go` - API endpoints
  - `getRecommendations()` - Main recommendation endpoint
  - `getRecommendationsFromClusterSummary()` - Enhanced with Ollama
  - `getNodePoolRecommendations()` - NodePool-specific recommendations
  - `analyzeKarpenterLog()` - Karpenter error log analysis endpoint
  - `listPods()` / `getPodLogs()` / `analyzeLog()` (`internal/api/pod_logs.go`) - Generic Log Explorer endpoints: `GET /pods`, `GET /pods/logs` (any pod), `POST /logs/analyze` (Karpenter-JSON first, generic LLM+heuristic fallback)

- `internal/api/karpenter_log.go` - Karpenter log analysis + generic log analysis
  - `analyzeKarpenterLogInternal()` - Parses and analyzes Karpenter error logs
  - `analyzeGenericLog()` - LLM explanation (when configured) else heuristic classifier (`classifyGenericLogs`, `genericLogPatterns`) over non-Karpenter log text; `isKarpenterJSONLog()` routes `/logs/analyze` between the two paths
  - `parseKarpenterLog()` - Parses JSON error logs
  - `categorizeErrorCause()` - Categorizes error causes (Label Error, Taint Tolerance, etc.)
  - `generateAIExplanation()` - Uses Ollama to generate intelligent explanations
  - `generateLogRecommendations()` - Generates actionable recommendations

### Frontend Core Files
- `frontend/src/App.jsx` - Main app, manages recommendations state; the Log Analyzer tab is the generic `LogExplorer` (replaces `KarpenterLogAnalyzer`)
- `frontend/src/components/LogExplorer.jsx` - **Log Analyzer tab** (replaces the old Karpenter-only analyzer). Pod picker (namespace dropdown + typeahead over pod names/namespace, Karpenter pods flagged and sorted to the top, restart count shown) feeding a log viewer (container select, tail 100/500/1000/5000, since 5m/15m/1h/1d, "previous terminated container" toggle, client-side error-only filter, line numbers, error-line tinting, search with match highlight + prev/next). "Analyze selection" (text selected in the pane), "Analyze errors" and "Analyze last 50" all POST to `/api/v1/logs/analyze`; the results panel renders `summary`/`explanation`/`errorCauses`/`recommendations` and shows the Karpenter `parsedError` block only when present. Accepts a `seedPod` prop ("namespace/name" or "namespace") so other tabs deep-link into it
- `frontend/src/components/NodePoolCard.jsx` - Displays recommendation cards (supports both formats)
- `frontend/src/components/GlobalClusterSummary.jsx` - Cluster overview and recommendation trigger

## Important Notes

### Dependencies
- **NO Prometheus dependency** for recommendations (removed)
- **AWS Pricing API** - Primary source for instance pricing
- **Ollama** - Optional, used for AI explanations only
- **Kubernetes API** - Required for node and NodePool data

### Cost Calculation Rules
1. **Spot instances**: 25% of on-demand price (75% discount)
2. **On-demand instances**: Full AWS Pricing API price
3. **Unknown capacity type**: Default to on-demand
4. **Cost validation**: Skip recommendations that increase cost by >10%

### Instance Type Rules
1. **Query the AWS Pricing API first** for available types (future-proof); when regional discovery is unavailable, use hardcoded candidates filtered for the configured region and architecture
2. **Filter GPU instances** unless workloads require GPU
3. **Respect architecture** (arm64 vs amd64)
4. **Limit combinations** to 1-3 instance types
5. **Sort by cost efficiency** before selecting

### Node Usage Rules
1. **Use requests only** (not limits)
2. **Exclude init containers**
3. **Only scheduled pods** (with nodeName)
4. **Exclude terminating pods**

### Frontend Display Rules
1. **Support both formats** (old and new)
2. **Show NodePool name** prominently
3. **Show current vs recommended** nodes, costs, CPU/Memory
4. **Display AI explanation** when available
5. **Show cost savings** prominently

## Common Tasks

### Adding a New Instance Type Family
1. Add to `estimateInstanceCapacity()` in `recommender.go`
2. Add pricing to `onDemandPrices` map (if hardcoded)
3. Add to `estimateCostFromFamily()` if needed
4. AWS API will automatically discover new types

### Modifying Recommendation Logic
1. **Primary location**: `internal/recommender/node_pool_recommender.go`
2. **Cost calculation**: `internal/recommender/recommender.go` → `estimateCost()`
3. **Instance selection**: `findOptimalInstanceTypesWithCapacityType()`

### Adding a New API Endpoint
1. Add route in `internal/api/server.go` → `setupRoutes()`
2. Add handler function
3. Use `GenerateRecommendationsFromNodePools()` for recommendations
4. Pass `progressCallback` for SSE endpoints

### Updating Frontend Display
1. Check `NodePoolCard.jsx` for format detection
2. Support both old and new formats
3. Test with both recommendation endpoints

## Testing Considerations

- **Test with 0 nodes**: NodePools with no nodes should be skipped
- **Test capacity types**: Both spot and on-demand scenarios
- **Test cost validation**: Recommendations that increase cost should be skipped
- **Test AWS API fallback**: When AWS API fails, should use hardcoded list
- **Test regional pricing**: China CNY and endpoint/location mapping; commercial endpoint preference and transient-only failover; regional product discovery filtering
- **Test regional fallback safety**: Do not reuse `us-east-1` estimates across regions, mask explicit no-price results, or return partial mixed-instance totals
- **Test currency formatting**: China cost values display `CN¥`; commercial values display `$`
- **Test China candidates**: Offline candidates are region-available and respect both arm64 and amd64 architecture, including AMD types where offered
- **Test Ollama integration**: Should gracefully handle Ollama unavailability

## Environment Variables

- `OLLAMA_URL` - Ollama server URL (optional, for AI explanations)
- `OLLAMA_MODEL` - Ollama model name (default: "granite4:latest")
- `KUBECONFIG` - Kubernetes config path
- `KUBE_CONTEXT` - Kubernetes context
- `PORT` - API server port (default: 8080)
- `HISTORY_INTERVAL_SECS` - Cluster trend sampler interval (default: 60)
- `HISTORY_WINDOW_HOURS` - Cluster trend history retention (default: 6, max 24)
- `LITELLM_METRICS_API_KEY` - Bearer token for the LiteLLM proxy `/metrics` endpoint (required by LiteLLM ≥ v1.85.0); optional — when unset the gateway is scraped unauthenticated and a 401/403 surfaces as an actionable banner in the UI
- `GATEWAY_HISTORY_DSN` - Postgres DSN for durable LiteLLM gateway cost history (e.g. CNPG). Optional — empty = in-memory store that resets on restart. Can also be composed from `GATEWAY_HISTORY_DB_HOST` / `PORT` / `USER` / `NAME` + `GATEWAY_HISTORY_DB_PASSWORD` (the chart uses the latter so the password comes from the CNPG credentials secret)
- `GATEWAY_HISTORY_RETENTION_HOURS` - Gateway cost-history retention (default: 720 = 30 days)
- `SERVING_HISTORY_DSN` - Postgres DSN for durable serving-history samples (`internal/servingdurable`, table `serving_history`). Optional — empty = in-memory only (no `7d` window). Wins over the gateway DSN; otherwise the gateway's `GATEWAY_HISTORY_DB_*` parts are reused so both histories can share one CNPG instance
- `SERVING_HISTORY_RETENTION_HOURS` - Durable serving-history retention (default: 168 = 7 days)
- `PLACEMENT_HISTORY_HOURS` - Topology time-travel retention (default 24, max 72, 0 disables the placement sampler and the history endpoints answer 503); also the retention of the durable copy
- `PLACEMENT_HISTORY_DSN` - Postgres for durable placement history (`internal/placementdurable`). Optional; falls back to the serving-history DSN, then the gateway's. Chart values `placementHistory.hours` / `placementHistory.intervalSeconds` set the two below
- `PLACEMENT_HISTORY_INTERVAL_SECS` - Placement sample interval (default 120, min 30); each sample is one node list, one pod list and one Node-event list
- `PROMETHEUS_URL` - Optional in-cluster Prometheus to read actual usage from (Topology, display only): p95 over 24h per pod and DCGM GPU memory. Without it metrics-server is used when installed. Chart value `usage.prometheusUrl`
- `METRICS_ENABLED` - Enable the Prometheus `/metrics` exporter (`true`/`1`; default off → `/metrics` 404s). Chart value `metrics.enabled`
- `API_AUTH_TOKEN` - Shared bearer token. When set, every `/api/v1` route except `/health` (k8s probes) **and** `/metrics` (when enabled) require `Authorization: Bearer <token>` (constant-time compare); empty = API open with a startup warning. Chart: `config.apiAuthTokenSecret` (existing Secret, key `api-auth-token`) or `config.apiAuthToken` (dev-only plain). The frontend container receives the same value as `REACT_APP_API_TOKEN` (runtime `config.js`) and sends it via an axios default header, so enabling auth does not break the UI
- `CORS_ALLOWED_ORIGIN` - Optional single origin echoed back in `Access-Control-Allow-Origin` (split deployments). Default same-origin (nginx serves SPA + API); the old wildcard+credentials header combo is gone
- Alerting is configured via the API (`GET/PUT /api/v1/alerts/config`, persisted to `alerts.stateFile`) or chart values `alerts.enabled` / `alerts.urls` (comma-separated `type=url` channel entries — secrets, keep them out of git in prod)

## Code Style

- **Go**: Follow standard Go conventions, use `gofmt`
- **React**: Use functional components with hooks
- **Error handling**: Always handle errors, log appropriately
- **Context**: Use `context.Context` for all API calls with timeouts
- **Progress callbacks**: Use for long-running operations (SSE)

## Quality Assurance Requirements

**Every change MUST pass these checks before completion:**

### 1. Linting (MANDATORY)
- **Frontend**: Run `npm run lint` - must pass with 0 warnings
- **Backend**: Run `golangci-lint run` - must pass with 0 errors
- Fix ALL linting issues before marking task complete
- Use `read_lints` tool to verify changed files

### 2. Build (MANDATORY)
- **Frontend**: `npm run build` must succeed (exit code 0)
- **Backend**: `make backend` or `go build ./cmd/api` must succeed
- If build fails, fix issues before proceeding
- Never commit code that doesn't build

### 3. Testing (MANDATORY)
- **Frontend**: `npm run test` must pass (or document pre-existing failures)
- **Frontend tests** run on Vitest (`npm test`, config in `frontend/vite.config.mjs`, jsdom). Component tests use Testing Library with the shared fixtures in `frontend/src/test/fixtures.js` (a two-node GPU cluster with a noisy neighbour); import `describe`/`test`/`expect`/`vi` from `vitest` explicitly. Mock axios as `vi.mock('axios', () => ({ default: { get: vi.fn() } }))`. Test-only and build-only packages belong in `devDependencies`, so `npm audit --omit=dev` covers exactly what ships; lazily loaded pages need `findBy…` queries in App-level tests
- **Coverage gate**: `test.coverage.thresholds` in `frontend/vite.config.mjs` (`perFile: true`) requires 90% statements/lines/functions and 75% branches on each of `lib/{api,blastRadius,commandPalette,gatewayFlow,drainSim,gpuFit,nodeActions,placementPlanner,pollingClock,routes,servingCost,servingHeadroom,servingLatency,servingModels,servingPlacement,servingStatus,servingTriage,topologyHistory,topologyLenses}.js` and `hooks/{useDrainPlan,usePolling,useTopologyData,useTopologyHistory,useTopologyZoom,useUrlParam}.js`; CI runs `npm test -- --coverage`, so dropping below fails the build
- **Backend**: `make test` or `go test ./...` must pass (or document pre-existing failures)
- Do NOT skip or delete tests to make them pass
- Add tests for new features when appropriate

### 4. Documentation (MANDATORY)
- Update `README.md` for user-facing changes
- Update `CHANGELOG.md` for significant changes
- Update `AGENTS.md` for architectural changes
- Update API documentation for new/modified endpoints
- Add/update code comments for complex logic
- Document new configuration options

**Failure to meet any requirement = task NOT complete**

### Pre-Commit Checklist
Before marking any task complete, verify:
- [ ] All linting passes (0 errors, 0 warnings)
- [ ] Build succeeds (frontend and/or backend)
- [ ] Tests pass (or pre-existing failures documented)
- [ ] Documentation updated (README, CHANGELOG, API docs, comments)
- [ ] Code follows project conventions
- [ ] Error handling is appropriate

## Important Warnings

⚠️ **DO NOT**:
- Use Prometheus for recommendations (removed)
- Use hardcoded instance types/prices as the *primary* source (the AWS Pricing API is primary; hardcoded maps/lists are a documented offline fallback)
- Assume capacity type (always check actual nodes)
- Skip cost validation (prevent cost increases)
- Recommend for NodePools with 0 nodes
- **Commit code that doesn't build or pass tests**
- **Skip linting, testing, or documentation updates**
- **Leave code in broken state**
- **Mark tasks complete without verification**

✅ **DO**:
- Use actual node data for recommendations
- Try both spot and on-demand for cost optimization
- Query AWS API for instance types
- Provide clear explanations with Ollama
- Support both old and new data formats
- **Verify linting, build, and tests pass before completion**
- **Update documentation for every change**
- **Fix all issues before marking task complete**

## Recent Changes

- **Operational reliability**: `cmd/api/main.go` now runs the API under `signal.NotifyContext(SIGINT, SIGTERM)` with `http.Server.Shutdown` (10s drain) instead of the blocking `gin` run; the four background samplers take a root cancellable context (`Server.Close()` stops them and closes both durable Postgres pools — `gatewayhistory` + `servingdurable`) so shutdown is clean and tests no longer leak samplers. All request handlers thread `c.Request.Context()` into their work context (a closed browser now cancels the SSE recommendation stream and every other handler instead of running its timeout to completion). Chart secrets: `LLM_API_KEY` (`config.llm.apiKeySecret`, key `api-key`) and `alerts.urls` (`alerts.urlsSecret`, key `urls`) move out of the pod spec into `secretKeyRef`; plain `apiKey`/`urls` values remain as documented dev-only fallbacks
- **Blast-radius hardening**: opt-in `API_AUTH_TOKEN` shared bearer-token middleware (`internal/api/middleware.go`, constant-time compare) gating every `/api/v1` route except `/health` (probes) and, when enabled, `/metrics`; unset = legacy open API with a startup warning. Chart `config.apiAuthTokenSecret` (existing Secret, key `api-auth-token`) / `config.apiAuthToken` (dev-only); the frontend container receives the same value as `REACT_APP_API_TOKEN` (runtime `config.js`, never baked into the bundle) and sends it via an axios default header. CORS: wildcard+`Access-Control-Allow-Credentials` combo removed — same-origin by default, optional single `CORS_ALLOWED_ORIGIN` for split deployments. `GET /api/v1/karpenter/logs` is gated to pods carrying `app.kubernetes.io/name=karpenter` (`ErrNotKarpenterPod` → 403), closing the cluster-wide log-dump hole that the broad `pods/log` RBAC grant leaves. Cost-optimization **learning agent is a process singleton** (`Server.learningAgent()`, `sync.Once`) — no more per-request history-file I/O, leaked init goroutines, or uncoordinated writes; `Close()` on shutdown
- **Defused landmines**: `LearningAgent.RecordOutcome` no longer self-deadlocks on `historyMu` (persistence + learning moved outside the write lock; regression tests with timeouts in `internal/agent/learning_test.go`). Release workflow no longer seds every `tag:` in values.yaml (it clobbered `database.cluster.postgresImage.tag` on the next release); app image tags are bumped by repository-anchored replacement with a `postgresImage.tag` guard. Pricing failures no longer silently count as $0: `/nodepools`, `/cluster/summary`, `/recommendations` (JSON + SSE), `/recommendations/cluster-summary`, and the history sampler now surface `costUnknown` when any node in a summed set is unpriceable, and the cost-spike alert baseline treats unknown-cost samples as no-data
- **Alerting engine**: `internal/alerts` (state machine + ntfy/Discord/Slack/webhook senders + SSRF validation) on the 60s sampler tick; `GET/PUT /api/v1/alerts/config` + `POST /api/v1/alerts/test`; UI settings dialog (`AlertsSettings.jsx`); chart values `alerts.*`; channel URLs are credentials (masked in GET, restored by index on PUT)
- **Prometheus `/metrics` exporter**: opt-in via `METRICS_ENABLED` / `metrics.enabled`; atomic sampler snapshot (zero extra K8s/AWS Pricing calls per scrape); optional chart ServiceMonitor
- **Durable serving history**: `internal/servingdurable` Postgres store (table `serving_history`, reuses the gateway CNPG instance) + `7d` window on `/serving/history`; `SERVING_HISTORY_DSN` / `SERVING_HISTORY_RETENTION_HOURS`; `Nd` day-window parsing fix for both history endpoints
- **sparkDash-grade visual polish**: dark/light theme toggle (system-preference default, no first-paint flash, semantic-token audit), `NavItem` icon tab bar with disruption count badge + page transitions, and consistent `EmptyState`/`Skeleton`/retry patterns across all tabs
- **LiteLLM Gateway cost & token history**: `GET /api/v1/serving/gateway/history` + a **Usage by day** dashboard in the Serving-tab Gateway card (stacked per-day bars, UTC 00:00–23:59, by app/API key/team + per-day table with top consumer, 7/14/30-day window). 60s sampler diffs cumulative counters into per-day totals (resets clamp to 0; closed days are final, read only from the store); in-memory by default, durable CNPG Postgres via `database.enabled: true` / `GATEWAY_HISTORY_DSN` (retention `GATEWAY_HISTORY_RETENTION_HOURS`)
- **Region-aware AWS pricing**: China partition pricing for Beijing/Ningxia is returned in CNY; commercial Pricing API calls use geography-aware endpoint preference with transient-error failover, region-matched product discovery, and currency-aware UI formatting. `us-east-1` and China fallback snapshots are kept region-specific, and unavailable regional products are not disguised as priced.
- **China recommendation candidates**: China fallback candidates filter unavailable families and include available AMD types while respecting the requested architecture.
- **LiteLLM AI-Gateway Health**: `GET /api/v1/serving/gateway` + Serving-tab Gateway card (fleet stats, usage split by **App / API key / Team** (`metadata_trace_name` / `api_key_alias` / `team_alias`) — top-level table + expandable per-model detail, overhead-vs-model latency split, 401 hint via `LITELLM_METRICS_API_KEY`)
- **Karpenter Log Analyzer**: Analyze error logs with AI-powered explanations
- **Generic Log Explorer** (Log Analyzer tab): cluster-wide pod picker + log viewer (container/tail/since/previous, search with match highlight, error filter) with Karpenter-JSON-first and generic (LLM + heuristic) analysis via `GET /api/v1/pods`, `GET /api/v1/pods/logs`, `POST /api/v1/logs/analyze`. The old `KarpenterLogAnalyzer` is removed; `GET /karpenter/logs` keeps its Karpenter-pod gate
- **NodePool-based recommendations**: Primary recommendation engine
- **AWS Pricing API integration**: Dynamic instance type discovery
- **Capacity type optimization**: Analyzes spot vs on-demand
- **Ollama explanations**: AI-enhanced recommendation explanations
- **Usage-based calculations**: Uses resource requests only

