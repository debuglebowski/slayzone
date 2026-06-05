// --- Branch / column color logic ---
// Pure, React-free color helpers for the commit graph.

/** Index 0 = base branch (white), rest are for other branches */
export const COLUMN_COLORS = [
  '#e2e2e2', // white/light — base branch
  '#a78bfa', // violet
  '#f59e0b', // amber
  '#10b981', // emerald
  '#f472b6', // pink
  '#06b6d4', // cyan
  '#ef4444', // red
  '#8b5cf6', // purple
  '#14b8a6', // teal
  '#f97316', // orange
  '#22d3ee' // sky
]

/** Color index for the base/first branch — always white */
export const BASE_BRANCH_COLOR_INDEX = 0

export function getColor(index: number): string {
  const len = COLUMN_COLORS.length
  return COLUMN_COLORS[((index % len) + len) % len]
}

/** Mix a hex color toward gray by a factor (0 = original, 1 = fully gray) */
export function desaturate(hex: string, factor: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  const gray = Math.round(r * 0.299 + g * 0.587 + b * 0.114)
  const mix = (c: number) => Math.round(c + (gray - c) * factor)
  return `#${[mix(r), mix(g), mix(b)].map((c) => c.toString(16).padStart(2, '0')).join('')}`
}

/** Get color for a branch, with subtle desaturation for origin/ variants.
 *  colorIndex is used to detect base-branch commits (always white). */
export function getBranchColor(branch: string, colorIndex?: number): string {
  const isOrigin = branch.startsWith('origin/')
  const index =
    colorIndex ?? (isOrigin ? hashBranchColor(branch.slice(7)) : hashBranchColor(branch))
  const color = getColor(index)
  return isOrigin ? desaturate(color, 0.4) : color
}

/** Deterministic hash of a branch name to a color index (skips 0, reserved for base branch) */
export function hashBranchColor(name: string): number {
  let h = 0
  for (let i = 0; i < name.length; i++) {
    h = ((h << 5) - h + name.charCodeAt(i)) | 0
  }
  // Map to 1..N (skip index 0 which is reserved for base branch)
  return (Math.abs(h) % (COLUMN_COLORS.length - 1)) + 1
}
