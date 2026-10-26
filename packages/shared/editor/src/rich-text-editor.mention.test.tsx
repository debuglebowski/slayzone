// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { editorViewCtx, type Editor } from '@milkdown/core'
import type { ArtifactPickerItem } from './ArtifactPicker'
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

const alpha: ArtifactPickerItem = { id: 'a', title: 'alpha notes', type: 'md' }
const beta: ArtifactPickerItem = { id: 'b', title: 'beta plan', type: 'md' }

function ui(artifacts: ArtifactPickerItem[] | undefined, editorRef: { current: Editor | null }) {
  return (
    <RichTextEditor
      value=""
      onChange={vi.fn()}
      artifacts={artifacts}
      editorRef={editorRef}
      testId="rte"
    />
  )
}

/** Types `@` the way ProseMirror's input handling does, then lets the trigger's rAF fire. */
async function typeAt(editor: Editor): Promise<void> {
  const view = editor.ctx.get(editorViewCtx)
  await act(async () => {
    const { from, to } = view.state.selection
    const handled = view.someProp('handleTextInput', (f) =>
      f(view, from, to, '@', () => view.state.tr)
    )
    if (!handled) view.dispatch(view.state.tr.insertText('@', from, to))
    await new Promise((r) => requestAnimationFrame(() => r(null)))
  })
}

describe('RichTextEditor artifact mention picker', () => {
  it('shows artifacts that arrive while the picker is open, without another re-render', async () => {
    const editorRef: { current: Editor | null } = { current: null }
    const { rerender } = render(ui([alpha], editorRef))
    await waitFor(() => expect(editorRef.current).not.toBeNull())

    await typeAt(editorRef.current!)
    await waitFor(() => expect(screen.queryByText('alpha notes')).not.toBeNull())

    // A new artifact lands (e.g. an upload) while the picker stays open.
    rerender(ui([alpha, beta], editorRef))
    expect(screen.queryByText('beta plan')).not.toBeNull()
  })

  it('opens the picker as soon as artifacts load after the @ was typed', async () => {
    const editorRef: { current: Editor | null } = { current: null }
    const { rerender } = render(ui([], editorRef))
    await waitFor(() => expect(editorRef.current).not.toBeNull())

    await typeAt(editorRef.current!)
    expect(screen.queryByText('alpha notes')).toBeNull()

    rerender(ui([alpha], editorRef))
    expect(screen.queryByText('alpha notes')).not.toBeNull()
  })
})
