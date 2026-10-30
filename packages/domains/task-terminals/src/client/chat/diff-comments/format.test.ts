/**
 * A comment on a diff line becomes text in the composer (chat E, plan 4.4): a
 * quoted reference (`path:line` + the line) and the comment, so the next
 * message carries it and the user can still edit or delete it.
 */
import { describe, expect, test } from 'vitest'
import { appendToDraft, formatDiffComment } from './format'

describe('formatDiffComment', () => {
  test('an added line: path relative to the cwd, the line, the comment', () => {
    expect(
      formatDiffComment(
        {
          path: '/repo/src/app.ts',
          line: { type: 'add', content: '    const x = 1', oldLineNo: null, newLineNo: 42 },
          comment: 'Rename this to y.'
        },
        '/repo'
      )
    ).toBe('> src/app.ts:42\n> const x = 1\n\nRename this to y.')
  })

  test('a removed line names its old line number; a path outside the cwd stays absolute', () => {
    expect(
      formatDiffComment(
        {
          path: '/elsewhere/b.ts',
          line: { type: 'delete', content: 'gone()', oldLineNo: 7, newLineNo: null },
          comment: 'Why remove it?'
        },
        '/repo'
      )
    ).toBe('> /elsewhere/b.ts:7 (removed line)\n> gone()\n\nWhy remove it?')
  })

  test('a long line is cut; an empty line is shown as such; the comment is trimmed', () => {
    const long = 'x'.repeat(300)
    const out = formatDiffComment(
      {
        path: '/repo/a.ts',
        line: { type: 'context', content: long, oldLineNo: 1, newLineNo: 1 },
        comment: '  why?  \n'
      },
      '/repo'
    )
    expect(out).toBe(`> a.ts:1\n> ${'x'.repeat(160)}…\n\nwhy?`)
    expect(
      formatDiffComment(
        {
          path: '/repo/a.ts',
          line: { type: 'add', content: '   ', oldLineNo: null, newLineNo: 3 },
          comment: 'blank?'
        },
        '/repo'
      )
    ).toBe('> a.ts:3\n> (empty line)\n\nblank?')
  })
})

describe('appendToDraft', () => {
  test('into an empty draft, then after what is there, one blank line apart', () => {
    const first = appendToDraft('', 'A')
    expect(first).toBe('A\n\n')
    expect(appendToDraft(first, 'B')).toBe('A\n\nB\n\n')
    expect(appendToDraft('my question\n', 'B')).toBe('my question\n\nB\n\n')
  })
})
