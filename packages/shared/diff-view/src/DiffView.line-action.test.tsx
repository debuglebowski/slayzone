// @vitest-environment jsdom
/**
 * A per-line action slot (chat E, plan 4.4: comment on a diff line). Off by
 * default: a DiffView without `renderLineAction` renders exactly as before.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

// No syntax worker in jsdom: plain lines.
vi.mock('./highlight', () => ({ tokenizeContent: () => Promise.resolve([]) }))

import { DiffView } from './DiffView'
import type { DiffLine, FileDiff } from './parse-diff'

const diff: FileDiff = {
  path: 'src/a.ts',
  oldPath: null,
  hunks: [
    {
      header: '@@ -1,2 +1,2 @@',
      oldStart: 1,
      oldLen: 2,
      newStart: 1,
      newLen: 2,
      label: '',
      lines: [
        { type: 'context', content: 'keep', oldLineNo: 1, newLineNo: 1 },
        { type: 'delete', content: 'old', oldLineNo: 2, newLineNo: null },
        { type: 'add', content: 'new', oldLineNo: null, newLineNo: 2 }
      ]
    }
  ],
  isBinary: false,
  isNew: false,
  isDeleted: false,
  additions: 1,
  deletions: 1
}

const action = (line: DiffLine) => (
  <button type="button" data-testid="line-action">
    {line.type}:{line.content}
  </button>
)

afterEach(cleanup)

describe('DiffView line action', () => {
  it('none by default', () => {
    render(<DiffView diff={diff} />)
    expect(screen.queryAllByTestId('line-action')).toHaveLength(0)
  })

  it('one per line, given the line (unified)', () => {
    render(<DiffView diff={diff} renderLineAction={action} />)
    expect(screen.getAllByTestId('line-action').map((b) => b.textContent)).toEqual([
      'context:keep',
      'delete:old',
      'add:new'
    ])
  })

  it('side by side: each half gets its own side of the line', () => {
    render(<DiffView diff={diff} sideBySide renderLineAction={action} />)
    expect(screen.getAllByTestId('line-action').map((b) => b.textContent)).toEqual([
      'context:keep',
      'delete:old',
      'context:keep',
      'add:new'
    ])
  })
})
