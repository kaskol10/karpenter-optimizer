import { clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs) {
  return twMerge(clsx(inputs))
}

// formatGPUMem renders a GPU memory value in MiB as GiB (1 decimal).
// Returns null when the value is not a positive number so callers can hide it.
export function formatGPUMem(mib) {
  if (typeof mib !== 'number' || !isFinite(mib) || mib <= 0) return null
  return `${(mib / 1024).toFixed(1)} GiB`
}

