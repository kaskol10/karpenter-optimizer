import React, { useState } from 'react';
import { Check, FileText, MoreHorizontal, ShieldAlert, Terminal } from 'lucide-react';
import { copyText } from '../serving/shared';
import { logTargets, nodeKubectlCommands } from '../../lib/nodeActions';

// NodeActions is the one menu per node: copy-ready kubectl commands
// (read-only or dry-run), the node's disruption status, and logs for any pod
// on it. A native <details> keeps it keyboard-accessible without a portal.
export function NodeActions({ node, onOpenLogs, onOpenDisruptions }) {
  const [copied, setCopied] = useState(null);
  const copy = (command) =>
    copyText(command, () => {
      setCopied(command);
      setTimeout(() => setCopied(null), 1200);
    });
  const pods = logTargets(node.pods);
  const item = 'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-muted';

  return (
    <details className="relative">
      <summary
        className="list-none cursor-pointer rounded-md border px-2 py-1 text-xs hover:bg-muted [&::-webkit-details-marker]:hidden"
        aria-label={`Actions for ${node.name}`}
      >
        <MoreHorizontal className="inline h-4 w-4" aria-hidden="true" /> Actions
      </summary>
      <div className="absolute left-0 z-20 mt-1 w-max max-w-[min(34rem,85vw)] rounded-md border bg-popover p-1 shadow-md">
        <p className="px-2 pb-0.5 pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Copy</p>
        {nodeKubectlCommands(node.name).map(({ label, command }) => (
          <button key={command} type="button" onClick={() => copy(command)} className={item} title="Click to copy">
            {copied === command ? <Check className="h-3.5 w-3.5 text-green-600" aria-hidden="true" /> : <Terminal className="h-3.5 w-3.5" aria-hidden="true" />}
            <span className="w-28 shrink-0 text-muted-foreground">{copied === command ? 'Copied' : label}</span>
            <code className="truncate font-mono text-[11px]">{command}</code>
          </button>
        ))}
        {onOpenDisruptions && (
          <button type="button" onClick={() => onOpenDisruptions(node)} className={item}>
            <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" /> Disruption status
          </button>
        )}
        {onOpenLogs && pods.length > 0 && (
          <>
            <p className="px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Open logs</p>
            <div className="max-h-48 overflow-y-auto">
              {pods.map((p) => (
                <button
                  key={`${p.namespace}/${p.name}`}
                  type="button"
                  onClick={() => onOpenLogs(p)}
                  className={item}
                  aria-label={`Open logs for ${p.namespace}/${p.name}`}
                >
                  <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                  <span className="truncate font-mono text-[11px]">
                    {p.namespace}/{p.name}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </details>
  );
}
