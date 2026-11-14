import { describe, expect, it } from 'vitest'
import {
  NAME_MAX_BYTES,
  numberedName,
  planFolderDownload,
  planTaskDownload,
  safeFileName
} from './download-plan'

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

// Review 2, M2: titles are not unique (and safeFileName maps `a/b.md` and `a_b.md` to
// one name). Every output path is unique — case-insensitively, and never equal to a
// folder's path — so no two artifacts are ever merged into one file or zip entry.
describe('duplicate names', () => {
  it('numbers repeats like a file manager: name (2).ext, case-insensitively', () => {
    const plan = planTaskDownload(
      [{ id: 'f', name: 'docs', parent_id: null }],
      [
        { id: '1', title: 'a.md', folder_id: 'f' },
        { id: '2', title: 'a.md', folder_id: 'f' },
        { id: '3', title: 'A.md', folder_id: 'f' },
        { id: '4', title: 'a (2).md', folder_id: null },
        { id: '5', title: 'a/b.md', folder_id: null },
        { id: '6', title: 'a_b.md', folder_id: null },
        { id: '7', title: 'docs', folder_id: null },
        { id: '8', title: 'README', folder_id: null },
        { id: '9', title: 'readme', folder_id: null }
      ]
    )
    expect(plan.map((e) => e.path)).toEqual([
      'docs/a.md',
      'docs/a (2).md',
      'docs/A (3).md',
      'a (2).md',
      'a_b.md',
      'a_b (2).md',
      'docs (2)',
      'README',
      'readme (2)'
    ])
  })

  it('folder downloads are unique too', () => {
    const plan = planFolderDownload(
      [{ id: 'f', name: 'docs', parent_id: null }],
      [
        { id: '1', title: 'x.txt', folder_id: 'f' },
        { id: '2', title: 'x.txt', folder_id: 'f' }
      ],
      'f'
    )
    expect(plan?.entries.map((e) => e.path)).toEqual(['docs/x.txt', 'docs/x (2).txt'])
  })
})

// Review 4, D2: a numbered copy of a name at the 255-byte limit still fits.
describe('numberedName', () => {
  it('numbers like a file manager', () => {
    expect(numberedName('a.md', 2)).toBe('a (2).md')
    expect(numberedName('.env', 2)).toBe('.env (2)')
    expect(numberedName('README', 3)).toBe('README (3)')
  })
  it('shortens the stem (never mid-character) so the result fits', () => {
    const at = `${'é'.repeat(124)}x.md`
    expect(Buffer.byteLength(at)).toBe(252)
    const copy = numberedName(at, 12)
    expect(Buffer.byteLength(copy)).toBeLessThanOrEqual(NAME_MAX_BYTES)
    expect(copy.endsWith(' (12).md')).toBe(true)
    expect(copy).not.toContain('\uFFFD')
  })
  it('the planner uses it for duplicates at the limit', () => {
    const title = `${'n'.repeat(250)}.md`
    const [, second] = planTaskDownload(
      [],
      [
        { id: '1', title, folder_id: null },
        { id: '2', title, folder_id: null }
      ]
    ).map((e) => e.path)
    expect(Buffer.byteLength(second)).toBeLessThanOrEqual(NAME_MAX_BYTES)
    expect(second.endsWith(' (2).md')).toBe(true)
  })
})

// Review 5, #12: names are legal everywhere a download can land (Windows included):
// no drive prefix, stream (`:`) or reserved character, no reserved device name, no
// trailing dot or space, and at most 255 bytes with the extension kept.
describe('names safe on Windows too', () => {
  it('replaces characters Windows reserves, and control characters', () => {
    expect(safeFileName('C:evil.md', 'x')).toBe('C_evil.md')
    expect(safeFileName('a:b.md', 'x')).toBe('a_b.md')
    expect(safeFileName('q?*"<>|.txt', 'x')).toBe('q______.txt')
    expect(safeFileName('tab\there\u0001.md', 'x')).toBe('tab_here_.md')
  })
  it('never a reserved device name, nor a trailing dot or space', () => {
    expect(safeFileName('CON', 'x')).toBe('_CON')
    expect(safeFileName('nul.txt', 'x')).toBe('_nul.txt')
    expect(safeFileName('com1.md', 'x')).toBe('_com1.md')
    expect(safeFileName('report. ', 'x')).toBe('report')
    expect(safeFileName('console.md', 'x')).toBe('console.md')
  })
  it('cut to 255 bytes, the extension kept', () => {
    const n = safeFileName(`${'é'.repeat(200)}.md`, 'x')
    expect(Buffer.byteLength(n)).toBeLessThanOrEqual(NAME_MAX_BYTES)
    expect(n.endsWith('.md')).toBe(true)
  })
  it('folder names in a plan follow the same rules', () => {
    expect(
      planTaskDownload(
        [{ id: 'f', name: 'AUX', parent_id: null }],
        [{ id: '1', title: 'a?.md', folder_id: 'f' }]
      )[0].path
    ).toBe('_AUX/a_.md')
  })
})
