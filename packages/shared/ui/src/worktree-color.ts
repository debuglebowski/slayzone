export const WORKTREE_COLORS = ['#6366f1', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16']

export function hashStr(path: string): number {
  let h = 0
  for (let i = 0; i < path.length; i++) h = ((h << 5) - h + path.charCodeAt(i)) | 0
  return Math.abs(h)
}

export function assignWorktreeColors(paths: string[]): Map<string, string> {
  const map = new Map<string, string>()
  const sorted = [...paths].sort()
  const used = new Set<number>()
  for (const p of sorted) {
    let idx = hashStr(p) % WORKTREE_COLORS.length
    while (used.has(idx) && used.size < WORKTREE_COLORS.length) idx = (idx + 1) % WORKTREE_COLORS.length
    used.add(idx)
    map.set(p, WORKTREE_COLORS[idx])
  }
  return map
}

export function assignNewWorktreeColors(
  newPaths: string[],
  existing: ReadonlyMap<string, string>
): Map<string, string> {
  const out = new Map(existing)
  const used = new Set<number>()
  for (const color of existing.values()) {
    const idx = WORKTREE_COLORS.indexOf(color)
    if (idx >= 0) used.add(idx)
  }
  const toAssign = [...newPaths].filter((p) => !out.has(p)).sort()
  for (const p of toAssign) {
    let idx = hashStr(p) % WORKTREE_COLORS.length
    while (used.has(idx) && used.size < WORKTREE_COLORS.length) idx = (idx + 1) % WORKTREE_COLORS.length
    used.add(idx)
    out.set(p, WORKTREE_COLORS[idx])
  }
  return out
}
