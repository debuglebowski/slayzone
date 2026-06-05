import type { DirEntry, GitFileStatus } from '../shared'

export const INDENT_PX = 20
export const BASE_PAD = 12

export const STATUS_PRIORITY: Record<GitFileStatus, number> = {
  conflicted: 6,
  modified: 5,
  deleted: 4,
  staged: 3,
  added: 2,
  renamed: 1,
  untracked: 0
}

export const GIT_STATUS_INFO: Record<GitFileStatus, { letter: string; colorClass: string }> = {
  modified: { letter: 'M', colorClass: 'text-amber-400' },
  deleted: { letter: 'D', colorClass: 'text-amber-400' },
  staged: { letter: 'S', colorClass: 'text-green-400' },
  added: { letter: 'A', colorClass: 'text-green-400' },
  renamed: { letter: 'R', colorClass: 'text-green-400' },
  untracked: { letter: 'U', colorClass: 'text-muted-foreground' },
  conflicted: { letter: 'C', colorClass: 'text-red-400' }
}

export function gitStatusColor(status: GitFileStatus | undefined): string | undefined {
  return status ? GIT_STATUS_INFO[status]?.colorClass : undefined
}

export interface CompactedEntry {
  entry: DirEntry
  displayName: string
  /** All dir paths in a compacted chain (including the leaf). Empty for files / non-compacted dirs. */
  chainPaths: string[]
}

export function compactChildren(
  parentPath: string,
  dirContents: Map<string, DirEntry[]>
): CompactedEntry[] {
  const children = dirContents.get(parentPath) ?? []
  return children.map((child) => {
    if (child.type !== 'directory') {
      return { entry: child, displayName: child.name, chainPaths: [] }
    }
    // Walk single-child directory chains
    const segments = [child.name]
    const chain = [child.path]
    let current = child
    while (true) {
      const sub = dirContents.get(current.path)
      if (!sub || sub.length !== 1 || sub[0].type !== 'directory') break
      current = sub[0]
      segments.push(current.name)
      chain.push(current.path)
    }
    return {
      entry: current, // leaf directory
      displayName: segments.join('/'),
      chainPaths: chain
    }
  })
}
