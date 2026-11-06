import React from 'react';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '../ui/accordion';
import { HelpCircle } from 'lucide-react';

// MetricExplainer is a default-collapsed accordion that explains, in plain
// English, what the serving metrics mean and what to do when they look bad.
// Targeted at end users who may not know what TTFT or E2E latency are.
const METRIC_EXPLAINERS = [
  {
    term: 'Status badge (OK / Busy / Slow / Under pressure)',
    what: 'A one-glance verdict computed from all the metrics on the card. Hover the badge for the specific reasons and what to do about them.',
    why: [
      'Under pressure (red) — the GPU memory for active requests is nearly full; work is being interrupted and re-run. Fix: add GPU capacity, give vLLM more KV cache (raise --gpu-memory-utilization or lower --max-num-seqs / --max-model-len), or take load off this server.',
      'Busy (amber) — more requests are arriving than this server can handle, so they queue and users wait. Fix: add replicas of the model, raise concurrency (--max-num-seqs) if memory allows, or find the bursty/long-context traffic.',
      'Slow (orange) — this server is far slower than the others running the same model. Fix: check placement (slow or contended node, GPU sharing), compare request mix, or reschedule the pod.',
      'OK (green) — nothing detected: no queue, no preemptions, memory headroom, latency in line with peers.',
    ].join(' '),
  },
  {
    term: 'TTFT (Time To First Token)',
    what: 'How long until the first word of the response appears.',
    why: 'What a user feels the moment they ask a question. A high TTFT feels slow even if the rest of the answer streams quickly. p95 shows the worst-case 5% of requests.',
  },
  {
    term: 'E2E latency (End-to-End)',
    what: 'The total time until the entire response is finished.',
    why: 'What a non-streaming caller actually waits for. High E2E with a low TTFT usually means long answers or a busy server; high with a high TTFT points at queuing.',
  },
  {
    term: 'KV cache %',
    what: 'How full the GPU working memory is for in-flight requests.',
    why: 'Near 100% the server can\'t accept much more work: new requests wait and long ones may be preempted. A consistently full cache means the model is at capacity.',
  },
  {
    term: 'Running / Waiting',
    what: 'Requests currently being processed vs. queued for a slot.',
    why: 'Waiting > 0 for a sustained period means the server is overloaded — consider adding replicas or raising the max-num-seqs limit.',
  },
  {
    term: 'Preemptions',
    what: 'Requests kicked out of memory and re-run because the KV cache ran out.',
    why: 'A counter that should stay near 0. A rising number means the model is under memory pressure and is silently re-doing work, which adds latency.',
  },
  {
    term: 'Throughput & Load',
    what: 'Tokens per second generated (Throughput) and requests per second served (Load).',
    why: 'These are the "most used" signals that drive the ranking chart. Load is the cleaner measure of demand; Throughput also reflects how long the answers are.',
  },
  {
    term: 'Trends (sparklines + last issue seen)',
    what: 'Each card shows a small history of TTFT p95, E2E p95, KV cache %, throughput and requests/s over a selectable window (1h/6h/24h), plus when the last issue was detected.',
    why: 'Current metrics are a single snapshot. Trends reveal how a model behaved at a specific time (e.g. was it slow or under pressure an hour ago?) and let you correlate an incident with a change. "Last issue seen" marks the last moment the pod was offline, had queued requests, preemptions, or KV cache near capacity. Data is sampled every 60s and kept in memory only — it resets when the app restarts, and starts filling from the first sample after launch.',
  },
];

export function MetricExplainer() {
  return (
    <Accordion type="single" collapsible className="mb-4 rounded-md border bg-card/40 px-3">
      <AccordionItem value="explain">
        <AccordionTrigger className="text-sm">
          <span className="flex items-center gap-1.5">
            <HelpCircle className="h-3.5 w-3.5" />
            What do these metrics mean?
          </span>
        </AccordionTrigger>
        <AccordionContent>
          <div className="space-y-3 text-xs">
            {METRIC_EXPLAINERS.map((m) => (
              <div key={m.term}>
                <p className="font-semibold">{m.term}</p>
                <p className="text-muted-foreground">{m.what}</p>
                <p className="text-muted-foreground italic">{m.why}</p>
              </div>
            ))}
          </div>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
