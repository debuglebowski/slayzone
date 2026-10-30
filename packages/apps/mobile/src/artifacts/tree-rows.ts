/**
 * A task's artifact tree as the rows of a list: desktop's tree order
 * (`groupArtifactTree`: each level's folders first, then its artifacts, by name), walked
 * depth-first, a collapsed folder's contents left out.
 */
import { groupArtifactTree } from '@slayzone/task-artifacts/shared'
import type { ArtifactFolder, TaskArtifact } from '@slayzone/task-contracts/types'

export type ArtifactTreeRow =
  | { kind: 'folder'; key: string; depth: number; folder: ArtifactFolder; expanded: boolean }
  | { kind: 'artifact'; key: string; depth: number; artifact: TaskArtifact }

export function artifactTreeRows(
  folders: readonly ArtifactFolder[],
  artifacts: readonly TaskArtifact[],
  collapsed: ReadonlySet<string>
): ArtifactTreeRow[] {
  const { childFolders, artifactsByFolder } = groupArtifactTree(folders, artifacts)
  const rows: ArtifactTreeRow[] = []
  const walk = (parent: string | null, depth: number): void => {
    for (const folder of childFolders.get(parent) ?? []) {
      const expanded = !collapsed.has(folder.id)
      rows.push({ kind: 'folder', key: `folder:${folder.id}`, depth, folder, expanded })
      if (expanded) walk(folder.id, depth + 1)
    }
    for (const artifact of artifactsByFolder.get(parent) ?? []) {
      rows.push({ kind: 'artifact', key: `artifact:${artifact.id}`, depth, artifact })
    }
  }
  walk(null, 0)
  return rows
}
