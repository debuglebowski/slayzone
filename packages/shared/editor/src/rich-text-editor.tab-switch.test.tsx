// @vitest-environment jsdom
// The rich-text editor across a tab switch. Task tabs live in <Activity>, which
// tears effects down on hide and re-runs them on show, so the Milkdown editor is
// destroyed and rebuilt. Caret and scroll must carry over (undo cannot: the new
// editor has its own schema).
import { Activity } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { editorViewCtx, type Editor } from '@milkdown/core'
import { TextSelection } from '@milkdown/prose/state'
import { RichTextEditor } from './rich-text-editor'

// jsdom has no layout: give ProseMirror's coordsAtPos zero-size rects to read.
beforeAll(() => {
  const rect = (): DOMRect => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    toJSON: () => ({})
  })
  Range.prototype.getBoundingClientRect = rect
  Range.prototype.getClientRects = () =>
    Object.assign([rect()], { item: () => rect() }) as unknown as DOMRectList
})

afterEach(cleanup)

function Tab({
  mode,
  value,
  editorRef
}: {
  mode: 'visible' | 'hidden'
  value: string
  editorRef: { current: Editor | null }
}) {
  return (
    <Activity mode={mode}>
      <RichTextEditor value={value} onChange={vi.fn()} editorRef={editorRef} />
    </Activity>
  )
}

const DOC = 'first paragraph\n\nsecond paragraph\n'
const OTHER = 'other text\n'
const view = (e: Editor) => e.ctx.get(editorViewCtx)

/** Renders, places the caret at `pos`, scrolls the editor to 120 px. */
async function setUp(editorRef: { current: Editor | null }) {
  const r = render(<Tab mode="visible" value={DOC} editorRef={editorRef} />)
  await waitFor(() => expect(editorRef.current).not.toBeNull())
  const first = editorRef.current!
  const scroller = r.container.querySelector<HTMLElement>('.mk-doc-scroll')!
  // jsdom has no scrolling: a plain field stands in for scrollTop.
  Object.defineProperty(scroller, 'scrollTop', { value: 0, writable: true })
  act(() => {
    const v = view(first)
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 22)))
    scroller.scrollTop = 120
    scroller.dispatchEvent(new Event('scroll'))
  })
  return { r, first, scroller }
}

describe('RichTextEditor across a tab switch', () => {
  it('keeps the caret and the scroll position', async () => {
    const editorRef: { current: Editor | null } = { current: null }
    const { r, first, scroller } = await setUp(editorRef)

    r.rerender(<Tab mode="hidden" value={DOC} editorRef={editorRef} />)
    scroller.scrollTop = 0 // what a display:none scroller reads
    r.rerender(<Tab mode="visible" value={DOC} editorRef={editorRef} />)
    await waitFor(() => expect(editorRef.current).not.toBe(first))
    await waitFor(() => expect(editorRef.current).not.toBeNull())

    expect(view(editorRef.current!).state.selection.head).toBe(22)
    expect(scroller.scrollTop).toBe(120)
  })

  it('starts at the top when the text changed while hidden', async () => {
    const editorRef: { current: Editor | null } = { current: null }
    const { r, first, scroller } = await setUp(editorRef)

    r.rerender(<Tab mode="hidden" value={DOC} editorRef={editorRef} />)
    scroller.scrollTop = 0
    r.rerender(<Tab mode="hidden" value={OTHER} editorRef={editorRef} />)
    r.rerender(<Tab mode="visible" value={OTHER} editorRef={editorRef} />)
    await waitFor(() => expect(editorRef.current).not.toBe(first))
    await waitFor(() => expect(editorRef.current).not.toBeNull())

    expect(view(editorRef.current!).state.doc.textContent).toBe('other text')
    expect(view(editorRef.current!).state.selection.head).not.toBe(22)
    expect(scroller.scrollTop).toBe(0)
  })
})
