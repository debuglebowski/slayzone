import path from 'node:path'

// Pure folder-tree helpers over raw `artifact_folders` rows. Used by the artifact
// download/export flows (./artifact-downloads.ts).

/** Build a folderId → relative-path resolver from a task's full folder list. */
export function buildFolderPathResolver(
  folders: Record<string, unknown>[]
): (id: string) => string {
  const byId = new Map(folders.map((f) => [f.id as string, f]))
  function folderPath(id: string): string {
    const f = byId.get(id)
    if (!f) return ''
    const parent = f.parent_id as string | null
    return parent ? path.join(folderPath(parent), f.name as string) : (f.name as string)
  }
  return folderPath
}

/** Collect a folder id plus all its (transitive) descendant folder ids. */
export function collectFolderAndDescendants(
  folders: Record<string, unknown>[],
  rootId: string
): Set<string> {
  const targetIds = new Set<string>([rootId])
  let changed = true
  while (changed) {
    changed = false
    for (const f of folders) {
      const id = f.id as string
      const parentId = f.parent_id as string | null
      if (parentId && targetIds.has(parentId) && !targetIds.has(id)) {
        targetIds.add(id)
        changed = true
      }
    }
  }
  return targetIds
}
