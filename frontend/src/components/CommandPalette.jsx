import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import axios from 'axios';
import { Boxes, Brain, Command, CornerDownLeft, Gpu, LayoutGrid, Loader2, Search, Server, Zap } from 'lucide-react';
import { API_URL } from '../lib/api';
import { buildItems, paletteResults } from '../lib/commandPalette';
import { cn } from '../lib/utils';

const KIND_ICON = { page: LayoutGrid, action: Zap, node: Server, pod: Boxes, gpu: Gpu, model: Brain, hint: Search };
const KIND_LABEL = { page: 'Page', action: 'Action', node: 'Node', pod: 'Pod', gpu: 'GPU', model: 'Model', hint: '' };
// The lists are refetched when the palette opens if older than this.
const STALE_MS = 60000;

// isPaletteShortcut is ⌘K on macOS, Ctrl+K elsewhere.
export const isPaletteShortcut = (e) => Boolean((e.metaKey || e.ctrlKey) && !e.altKey && e.key?.toLowerCase() === 'k');

// CommandPalette jumps to any page, node, pod, GPU or model, or runs an
// action ("drain <node>", "logs <pod>", "fit 40GiB 2"). Node, pod and GPU
// names come from /topology and models from /serving, fetched when the
// palette opens (pages and actions work before they arrive or without them).
export function CommandPalette({ open, onOpenChange, onRun }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [lists, setLists] = useState({ nodes: [], servingPods: [], at: 0, loading: false });
  const listRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    if (Date.now() - lists.at < STALE_MS) return;
    let cancelled = false;
    setLists((l) => ({ ...l, loading: true }));
    Promise.allSettled([axios.get(`${API_URL}/api/v1/topology`), axios.get(`${API_URL}/api/v1/serving`)]).then(([topo, serving]) => {
      if (cancelled) return;
      setLists({
        nodes: topo.status === 'fulfilled' ? topo.value.data?.nodes || [] : [],
        servingPods: serving.status === 'fulfilled' ? serving.value.data?.pods || [] : [],
        at: Date.now(),
        loading: false,
      });
    });
    return () => {
      cancelled = true;
    };
    // lists.at is read, not tracked: a new fetch only on (re)open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const items = useMemo(() => buildItems(lists), [lists]);
  const results = useMemo(() => paletteResults(items, query), [items, query]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  const run = (item) => {
    if (!item?.run) return;
    onOpenChange(false);
    onRun(item.run);
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(results[active]);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content
          className="fixed left-1/2 top-[12vh] z-50 w-[min(640px,92vw)] -translate-x-1/2 overflow-hidden rounded-xl border bg-background shadow-2xl focus:outline-none"
          aria-describedby={undefined}
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <div className="flex items-center gap-2 border-b px-4">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder='Go to a page, node, pod, GPU or model… or try "drain", "logs", "fit 40GiB"'
              className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              role="combobox"
              aria-expanded="true"
              aria-controls="palette-results"
              aria-activedescendant={results[active] ? `palette-${active}` : undefined}
              aria-label="Search"
            />
            {lists.loading && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-label="Loading names" />}
          </div>
          <ul id="palette-results" ref={listRef} role="listbox" aria-label="Results" className="max-h-[50vh] overflow-y-auto p-1.5">
            {results.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted-foreground">Nothing matches “{query}”.</li>}
            {results.map((item, i) => {
              const Icon = KIND_ICON[item.kind] || Search;
              return (
                <li
                  key={item.id}
                  id={`palette-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={i === active}
                  aria-disabled={!item.run || undefined}
                  onMouseMove={() => setActive(i)}
                  onClick={() => run(item)}
                  className={cn(
                    'flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm',
                    i === active && item.run ? 'bg-muted' : '',
                    !item.run && 'cursor-default text-muted-foreground',
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className={cn('truncate', item.kind === 'pod' || item.kind === 'node' ? 'font-mono text-xs' : '')}>{item.label}</span>
                  {item.hint && <span className="truncate text-xs text-muted-foreground">{item.hint}</span>}
                  <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">{KIND_LABEL[item.kind]}</span>
                </li>
              );
            })}
          </ul>
          <div className="flex items-center gap-3 border-t px-4 py-2 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <CornerDownLeft className="h-3 w-3" /> open
            </span>
            <span>↑↓ move</span>
            <span>esc close</span>
            <span className="ml-auto flex items-center gap-1">
              <Command className="h-3 w-3" />K anywhere
            </span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
