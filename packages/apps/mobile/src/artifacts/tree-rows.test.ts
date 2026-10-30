import type { ArtifactFolder, TaskArtifact } from '@slayzone/task-contracts'
import { artifactTreeRows } from './tree-rows'

const folder = (id: string, name: string, parent_id: string | null = null) =>
  ({ id, name, parent_id }) as ArtifactFolder
const artifact = (id: string, title: string, folder_id: string | null = null) =>
  ({ id, title, folder_id }) as TaskArtifact

const folders = [folder('f1', 'Docs'), folder('f2', 'Assets', 'f1')]
const artifacts = [
  artifact('a1', 'zeta.md'),
  artifact('a2', 'b.md', 'f1'),
  artifact('a3', 'logo.svg', 'f2'),
  artifact('a4', 'alpha.md')
]

describe('artifactTreeRows', () => {
  it('lists each level folders first, then artifacts, sorted, depth-first', () => {
    const rows = artifactTreeRows(folders, artifacts, new Set())
    expect(
      rows.map((r) => [r.kind, r.kind === 'folder' ? r.folder.name : r.artifact.title, r.depth])
    ).toEqual([
      ['folder', 'Docs', 0],
      ['folder', 'Assets', 1],
      ['artifact', 'logo.svg', 2],
      ['artifact', 'b.md', 1],
      ['artifact', 'alpha.md', 0],
      ['artifact', 'zeta.md', 0]
    ])
    expect(rows.every((r) => r.kind !== 'folder' || r.expanded)).toBe(true)
  })

  it('hides what is inside a collapsed folder, the folder itself stays', () => {
    const rows = artifactTreeRows(folders, artifacts, new Set(['f1']))
    expect(rows.map((r) => r.key)).toEqual(['folder:f1', 'artifact:a4', 'artifact:a1'])
    expect(rows[0]).toMatchObject({ kind: 'folder', expanded: false })
  })
})
