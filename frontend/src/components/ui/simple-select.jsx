import * as React from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';

// Radix Select refuses an item whose value is '' (it reserves the empty string
// for "no selection" and throws), which is how "All" / "Off" options are
// usually modelled. SimpleSelect maps '' to a private sentinel and back, so
// callers keep plain '' in their state and URLs.
const EMPTY = '__empty__';
const toItem = (v) => (v === '' || v === null || v === undefined ? EMPTY : String(v));
const fromItem = (v) => (v === EMPTY ? '' : v);

// SimpleSelect is the app's one dropdown for a flat list of options:
// options = [{ value, label }]. It replaces native <select> elements so every
// dropdown looks and behaves the same (keyboard, dark mode, focus ring).
export function SimpleSelect({ value, onValueChange, options, className, ariaLabel, title, placeholder }) {
  return (
    <Select value={toItem(value)} onValueChange={(v) => onValueChange(fromItem(v))}>
      <SelectTrigger className={className} aria-label={ariaLabel} title={title}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={toItem(o.value)} value={toItem(o.value)}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
