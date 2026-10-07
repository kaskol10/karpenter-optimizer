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

// shortGpuUuid shortens a GPU UUID for compact display (drops the "GPU-"
// prefix and hyphens, keeps the first 8 chars). HAMi's allocated-index is
// unreliable (two cards can both report index 0), so the UUID is the only
// stable identifier of a physical GPU.
export function shortGpuUuid(uuid) {
  if (!uuid) return '';
  return String(uuid).replace(/^GPU-/, '').replace(/-/g, '').slice(0, 8);
}

