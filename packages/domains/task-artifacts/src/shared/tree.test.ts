import { describe, expect, it } from 'vitest'
import type { ArtifactFolder, TaskArtifact } from '@slayzone/task-contracts'
import { groupArtifactTree } from './tree'

const folder = (id: string, name: string, parent_id: string | null = null): ArtifactFolder => ({
  id,
  task_id: 't',
  parent_id,
  name,
  order: 0,
  created_at: '2026-10-30 10:00:00'
})

const artifact = (id: string, title: string, folder_id: string | null = null): TaskArtifact => ({
  id,
  task_id: 't',
  folder_id,
  title,
  render_mode: null,
  view_mode: null,
  readability_override: null,
  width_override: null,
  zoom_pct: null,
  html_theme_override: null,
  language: null,
  order: 0,
  created_at: '2026-10-30 10:00:00',
  updated_at: '2026-10-30 10:00:00',
  current_version_id: null
})

describe('groupArtifactTree', () => {
  it('groups folders by parent and artifacts by folder; null = top level', () => {
    const { childFolders, artifactsByFolder } = groupArtifactTree(
      [folder('f1', 'Docs'), folder('f2', 'Sub', 'f1')],
      [
        artifact('a1', 'top.md'),
        artifact('a2', 'in-docs.md', 'f1'),
        artifact('a3', 'deep.md', 'f2')
      ]
    )
    expect(childFolders.get(null)?.map((f) => f.id)).toEqual(['f1'])
    expect(childFolders.get('f1')?.map((f) => f.id)).toEqual(['f2'])
    expect(artifactsByFolder.get(null)?.map((a) => a.id)).toEqual(['a1'])
    expect(artifactsByFolder.get('f1')?.map((a) => a.id)).toEqual(['a2'])
    expect(artifactsByFolder.get('f2')?.map((a) => a.id)).toEqual(['a3'])
  })

  it('sorts by name/title with numeric, case-insensitive collation (not by order)', () => {
    const { childFolders, artifactsByFolder } = groupArtifactTree(
      [folder('f10', 'item 10'), folder('f2', 'item 2'), folder('fb', 'Beta')],
      [
        artifact('x', 'b.md'),
        artifact('y', 'A.md'),
        artifact('z', 'file10.md'),
        artifact('w', 'file9.md')
      ]
    )
    expect(childFolders.get(null)?.map((f) => f.name)).toEqual(['Beta', 'item 2', 'item 10'])
    expect(artifactsByFolder.get(null)?.map((a) => a.title)).toEqual([
      'A.md',
      'b.md',
      'file9.md',
      'file10.md'
    ])
  })

  it('leaves its inputs unsorted', () => {
    const artifacts = [artifact('x', 'b.md'), artifact('y', 'a.md')]
    groupArtifactTree([], artifacts)
    expect(artifacts.map((a) => a.id)).toEqual(['x', 'y'])
  })
})
