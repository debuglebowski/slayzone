import { describe, expect, it } from 'vitest'
import { planFolderDownload, planTaskDownload, safeFileName } from './download-plan'

const folders = [
  { id: 'f1', name: 'docs', parent_id: null },
  { id: 'f2', name: 'nested', parent_id: 'f1' },
  { id: 'f3', name: 'other', parent_id: null }
]
const artifacts = [
  { id: 'a', title: 'root.md', folder_id: null },
  { id: 'b', title: 'top.md', folder_id: 'f1' },
  { id: 'c', title: 'deep.txt', folder_id: 'f2' },
  { id: 'd', title: 'elsewhere.md', folder_id: 'f3' }
]

describe('planTaskDownload', () => {
  it('places every artifact under its folder path', () => {
    expect(planTaskDownload(folders, artifacts)).toEqual([
      { artifactId: 'a', path: 'root.md' },
      { artifactId: 'b', path: 'docs/top.md' },
      { artifactId: 'c', path: 'docs/nested/deep.txt' },
      { artifactId: 'd', path: 'other/elsewhere.md' }
    ])
  })

  it('never lets a name climb out', () => {
    const plan = planTaskDownload(
      [{ id: 'x', name: '../..', parent_id: null }],
      [
        { id: 'e', title: '../../.zshrc', folder_id: 'x' },
        { id: 'g', title: '/etc/passwd', folder_id: null },
        { id: 'h', title: '..', folder_id: null }
      ]
    )
    expect(plan).toEqual([
      { artifactId: 'e', path: '.zshrc' },
      { artifactId: 'g', path: 'etc_passwd' },
      { artifactId: 'h', path: 'h' }
    ])
  })

  it('survives a folder cycle', () => {
    const cyclic = [
      { id: 'p', name: 'p', parent_id: 'q' },
      { id: 'q', name: 'q', parent_id: 'p' }
    ]
    expect(planTaskDownload(cyclic, [{ id: 'z', title: 'z.md', folder_id: 'p' }])[0].path).toBe(
      'q/p/z.md'
    )
  })
})

describe('planFolderDownload', () => {
  it('takes the folder and its descendants, rooted at the folder name', () => {
    expect(planFolderDownload(folders, artifacts, 'f1')).toEqual({
      folderName: 'docs',
      dirs: ['docs', 'docs/nested'],
      entries: [
        { artifactId: 'b', path: 'docs/top.md' },
        { artifactId: 'c', path: 'docs/nested/deep.txt' }
      ]
    })
  })

  it('roots a nested folder at its own name', () => {
    expect(planFolderDownload(folders, artifacts, 'f2')?.entries).toEqual([
      { artifactId: 'c', path: 'nested/deep.txt' }
    ])
  })

  it('is null for an unknown folder', () => {
    expect(planFolderDownload(folders, artifacts, 'nope')).toBeNull()
  })
})

describe('safeFileName', () => {
  it('reduces a title to one name in place', () => {
    expect(safeFileName('notes.md', 'x')).toBe('notes.md')
    expect(safeFileName('../../x.md', 'x')).toBe('x.md')
    expect(safeFileName('/abs/dir/x.md', 'x')).toBe('abs_dir_x.md')
    expect(safeFileName('..', 'fallback')).toBe('fallback')
  })
})
