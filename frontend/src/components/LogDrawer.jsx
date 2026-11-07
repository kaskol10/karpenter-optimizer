import React from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { FileText, X } from 'lucide-react';
import LogExplorer from './LogExplorer';

// LogDrawer shows the Log Explorer in a side drawer over any page, so
// opening a pod's logs from Topology or Serving never loses your place.
// It is open while the URL has ?logs= (empty = the pod picker,
// "namespace/name" = that pod); closing drops the param.
export function LogDrawer({ pod, onClose }) {
  const open = typeof pod === 'string';
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-5xl flex-col border-l bg-background shadow-xl focus:outline-none"
          aria-describedby={undefined}
        >
          <div className="flex items-center gap-2 border-b px-5 py-3">
            <FileText className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <Dialog.Title className="text-base font-semibold">Logs</Dialog.Title>
            {pod && <span className="truncate font-mono text-xs text-muted-foreground">{pod}</span>}
            <Dialog.Close
              className="ml-auto rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="Close logs"
            >
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>
          <div className="flex-1 overflow-y-auto p-5">{open && <LogExplorer seedPod={pod || undefined} />}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
