// @vitest-environment jsdom
// The CodeMirror view across a tab switch. Task tabs live in <Activity>, which
// tears effects down on hide and re-runs them on show, so the view is destroyed
// and rebuilt. Caret, selection and undo history must carry over.
import { Activity, useState, type MutableRefObject } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { undo } from '@codemirror/commands'
import { EditorSelection } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

const theme = { editorThemeId: 'default', contentVariant: 'dark' }
vi.mock('@slayzone/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@slayzone/ui')>()),
  useTheme: () => theme
}))

const { SearchableCodeView, WRAP_MAX_LINE_CHARS } = await import('./SearchableCodeView')

afterEach(cleanup)

function Tab({
  mode,
  viewRef,
  onChange
}: {
  mode: 'visible' | 'hidden'
  viewRef: MutableRefObject<EditorView | null>
  onChange: (v: string) => void
}) {
  // The parent owns the text, as ArtifactContentEditor does.
  const [value, setValue] = useState('line1\nline2\n')
  return (
    <Activity mode={mode}>
      <SearchableCodeView
        value={value}
        onChange={(v) => {
          setValue(v)
          onChange(v)
        }}
        viewHandleRef={viewRef}
      />
    </Activity>
  )
}

describe('SearchableCodeView across a tab switch', () => {
  it('keeps the caret, the edit and undo history', () => {
    const viewRef: MutableRefObject<EditorView | null> = { current: null }
    const onChange = vi.fn()
    const view = render(<Tab mode="visible" viewRef={viewRef} onChange={onChange} />)
    const before = viewRef.current!
    act(() => {
      before.dispatch({ changes: { from: 11, insert: 'X' } })
      before.dispatch({ selection: EditorSelection.cursor(3) })
    })

    view.rerender(<Tab mode="hidden" viewRef={viewRef} onChange={onChange} />)
    view.rerender(<Tab mode="visible" viewRef={viewRef} onChange={onChange} />)

    const after = viewRef.current!
    expect(after.state.doc.toString()).toBe('line1\nline2X\n')
    expect(after.state.selection.main.head).toBe(3)
    act(() => {
      undo(after)
    })
    expect(after.state.doc.toString()).toBe('line1\nline2\n')
  })

  it("starts from the parent's text when it changed while hidden", () => {
    const viewRef: MutableRefObject<EditorView | null> = { current: null }
    function Parent({ mode, value }: { mode: 'visible' | 'hidden'; value: string }) {
      return (
        <Activity mode={mode}>
          <SearchableCodeView value={value} onChange={() => undefined} viewHandleRef={viewRef} />
        </Activity>
      )
    }
    const view = render(<Parent mode="visible" value="a" />)
    view.rerender(<Parent mode="hidden" value="a" />)
    view.rerender(<Parent mode="hidden" value="b" />)
    view.rerender(<Parent mode="visible" value="b" />)
    expect(viewRef.current!.state.doc.toString()).toBe('b')
  })
})

describe('SearchableCodeView line wrapping', () => {
  // Wrapping a very long line: a 5 MB one-line JSON file blocked the window 1.1 s
  // (Chromium laying out the wrapped line on CodeMirror's first selection read).
  const long = `[${'x'.repeat(WRAP_MAX_LINE_CHARS + 1)}]`
  function View({ value, version }: { value: string; version?: number }) {
    return (
      <SearchableCodeView
        value={value}
        version={version}
        onChange={() => undefined}
        viewHandleRef={viewRef}
      />
    )
  }
  const viewRef: MutableRefObject<EditorView | null> = { current: null }
  // The configured class, not `view.lineWrapping`: that one follows a measure,
  // which jsdom never runs.
  const wraps = () => viewRef.current!.contentDOM.classList.contains('cm-lineWrapping')

  it('wraps ordinary text', () => {
    render(<View value={'short\nlines\n'} />)
    expect(wraps()).toBe(true)
  })

  it('does not wrap a document with a line over the limit', () => {
    render(<View value={`a\n${long}\nb`} />)
    expect(wraps()).toBe(false)
  })

  it('follows a reload from disk, both ways', () => {
    const view = render(<View value="short" version={1} />)
    view.rerender(<View value={long} version={2} />)
    expect(wraps()).toBe(false)
    view.rerender(<View value="short again" version={3} />)
    expect(wraps()).toBe(true)
  })

  it('typing a long line does not flip wrapping mid-edit', () => {
    render(<View value="short" />)
    act(() => {
      viewRef.current!.dispatch({ changes: { from: 0, insert: long } })
    })
    expect(wraps()).toBe(true)
  })
})
