import type { ArtifactFolder, TaskArtifact } from '@slayzone/task-contracts'

/** A task's artifacts as a tree: each level's folders and artifacts, keyed by parent. */
export interface ArtifactTreeGroups {
  /** Folders by `parent_id`; `null` = the top level. */
  childFolders: Map<string | null, ArtifactFolder[]>
  /** Artifacts by `folder_id`; `null` = the top level. */
  artifactsByFolder: Map<string | null, TaskArtifact[]>
}

/**
 * Groups a task's flat folder + artifact lists (`artifacts.foldersGetByTask` /
 * `artifacts.getByTask`) into its tree, every level sorted by name (folders) and title
 * (artifacts) with numeric, case-insensitive collation — the order the artifacts panel
 * shows (a level shows its folders first, then its artifacts). The stored `order` is not
 * used. DOM-free: the desktop panel (`useArtifactTree`) and the phone share it.
 */
export function groupArtifactTree(
  folders: readonly ArtifactFolder[],
  artifacts: readonly TaskArtifact[]
): ArtifactTreeGroups {
  const childFolders = new Map<string | null, ArtifactFolder[]>()
  for (const f of folders) {
    const arr = childFolders.get(f.parent_id) ?? []
    arr.push(f)
    childFolders.set(f.parent_id, arr)
  }
  const artifactsByFolder = new Map<string | null, TaskArtifact[]>()
  for (const a of artifacts) {
    const arr = artifactsByFolder.get(a.folder_id) ?? []
    arr.push(a)
    artifactsByFolder.set(a.folder_id, arr)
  }
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  for (const arr of childFolders.values()) arr.sort((a, b) => collator.compare(a.name, b.name))
  for (const arr of artifactsByFolder.values())
    arr.sort((a, b) => collator.compare(a.title, b.title))
  return { childFolders, artifactsByFolder }
}
