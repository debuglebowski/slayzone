import type { ContextTreeEntry } from '../shared'

export const getRelativePath = (entry: ContextTreeEntry) => entry.relativePath

/**
 * Derive the set of ancestor folder paths for every entry in the tree, e.g.
 * `.claude/commands/foo.md` → `.claude`, `.claude/commands`. Used to auto-expand
 * all folders on first tree load.
 */
export function collectExpandedFolders(tree: ContextTreeEntry[]): Set<string> {
  const folders = new Set<string>()
  for (const e of tree) {
    const parts = e.relativePath.split('/')
    let path = ''
    for (let i = 0; i < parts.length - 1; i++) {
      path = path ? `${path}/${parts[i]}` : parts[i]
      folders.add(path)
    }
  }
  return folders
}
