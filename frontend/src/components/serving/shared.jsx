import React, { useState } from 'react';
import { HelpCircle, Server } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

// MetricTip is a metric label with a small help button that opens a
// plain-English definition (for people new to LLM serving metrics). It
// replaces both hover-only title tooltips and the old always-present
// "What do these metrics mean?" accordion: the definition sits next to the
// number it explains, opens on click or keyboard, and works on touch.
export function MetricTip({ label, tip, children }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span>{label}</span>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`What is ${label}?`}
            className="rounded-full text-muted-foreground/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <HelpCircle className="h-3 w-3" aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" className="w-72 p-3 text-xs leading-relaxed">
          <p className="font-semibold text-foreground">{label}</p>
          <p className="mt-1 text-muted-foreground">{tip}</p>
        </PopoverContent>
      </Popover>
      {children}
    </span>
  );
}

// --- Per-server health verdict ---
//
// Overload signals (waiting, KV cache %, preemptions) are objective and
// workload-independent, so they use absolute thresholds. "Slow" is
// workload-dependent (a 2s first token is fine for batch, bad for chat), so
// it's judged *relative to the other servers in the fleet*, with a loose
// TTFT fallback when no peer comparison is possible. The logic lives in
// lib/servingStatus.js (pure, unit-tested).

export const STATUS_TONE_CLASSES = {
  green: 'bg-green-100 text-green-800 border-green-300 dark:bg-green-500/20 dark:text-green-300 dark:border-green-500/40',
  amber: 'bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-500/20 dark:text-amber-300 dark:border-amber-500/40',
  orange: 'bg-orange-100 text-orange-800 border-orange-300 dark:bg-orange-500/20 dark:text-orange-300 dark:border-orange-500/40',
  red: 'bg-red-100 text-red-800 border-red-300 dark:bg-red-500/20 dark:text-red-300 dark:border-red-500/40',
};

// formatRelativeTime renders a Unix-seconds timestamp as "5m ago" / "3h ago".
export function formatRelativeTime(unix) {
  if (!unix) return '';
  const secs = Math.max(0, Math.floor(Date.now() / 1000 - unix));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// copyText writes value to the clipboard (with a textarea fallback for
// non-secure origins) and calls done afterwards, whether or not it worked.
export function copyText(value, done = () => {}) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(value).then(done).catch(done);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = value;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
  done();
}

// CopyableNode renders a node name; clicking copies it (for pasting into the
// CLI). `copyValue` optionally overrides what gets copied (e.g. display the
// hostname but copy the actual node name used by kubectl).
export function CopyableNode({ name, copyValue }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    copyText(copyValue || name, () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  return (
    <button
      type="button"
      onClick={copy}
      title={`${copyValue || name} — click to copy`}
      className="inline-flex items-center gap-1 font-mono text-[11px] max-w-full cursor-pointer truncate text-left hover:underline"
    >
      <Server className="h-3 w-3 shrink-0 text-muted-foreground" />
      <span className="truncate">{copied ? 'Copied' : name}</span>
    </button>
  );
}

// formatTokens renders a token count compactly (e.g. 12345 -> "12.3k") so the
// per-app table stays readable when callers consume millions of tokens.
export function formatTokens(n) {
  if (n == null) return '—';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}
