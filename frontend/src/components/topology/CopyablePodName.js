import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Check } from 'lucide-react';
import { cn } from '../../lib/utils';
import { getPodKey } from './podUtils';

// useCopyPodName copies a pod's namespace/name to the clipboard and tracks
// which pod key was just copied (for brief "Copied" feedback).
export function useCopyPodName() {
  const [copiedKey, setCopiedKey] = useState(null);
  const timeoutRef = useRef(null);

  useEffect(() => () => clearTimeout(timeoutRef.current), []);

  const copy = useCallback((pod) => {
    const key = getPodKey(pod);
    const done = () => {
      setCopiedKey(key);
      clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopiedKey(null), 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(key).then(done).catch(done);
    } else {
      const ta = document.createElement('textarea');
      ta.value = key;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      done();
    }
  }, []);

  return { copy, copiedKey };
}

// CopyablePodName renders a pod's namespace/name; clicking copies the full
// name (for pasting into the CLI).
export function CopyablePodName({ pod, onCopy, copiedKey, className }) {
  const isCopied = copiedKey === getPodKey(pod);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onCopy(pod);
      }}
      title={`${getPodKey(pod)} — click to copy`}
      className={cn(
        'inline-flex items-center gap-1 font-mono max-w-full cursor-pointer truncate text-left',
        isCopied && 'text-emerald-600',
        className,
      )}
    >
      {isCopied ? (
        <>
          <Check className="w-3 h-3 shrink-0" aria-hidden="true" />
          <span className="truncate">Copied</span>
        </>
      ) : (
        <span className="truncate">
          {pod.namespace}/{pod.name}
        </span>
      )}
    </button>
  );
}
