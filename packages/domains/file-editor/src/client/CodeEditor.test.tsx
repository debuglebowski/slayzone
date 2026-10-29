// @vitest-environment jsdom
// When the CodeMirror view is (re)created. Only a new file or font size builds a
// new view; content, theme, minimap and editor settings must reach the live view
// without destroying it (undo history + scroll would be lost).
import type { MutableRefObject } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { EditorView } from 'codemirror'

const baseAppearance = {
  editorFontSize: 13,
  editorWordWrap: 'off',
  editorTabSize: 2,
  editorIndentTabs: false,
  editorRenderWhitespace: 'none'
}
let appearance = baseAppearance
let theme = { editorThemeId: 'default', contentVariant: 'dark' }
vi.mock('@slayzone/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@slayzone/ui')>()),
  useAppearance: () => appearance,
  useTheme: () => theme
}))

const { CodeEditor } = await import('./CodeEditor')

afterEach(() => {
  cleanup()
  appearance = baseAppearance
  theme = { editorThemeId: 'default', contentVariant: 'dark' }
})

const noop = (): void => undefined

function setup(filePath = 'a.ts', content = 'one') {
  const viewRef: MutableRefObject<EditorView | null> = { current: null }
  const props = { onChange: noop, onSave: noop, viewHandleRef: viewRef }
  const r = render(<CodeEditor filePath={filePath} content={content} {...props} />)
  const rerender = (p: { filePath?: string; content?: string; minimap?: boolean }): void =>
    r.rerender(
      <CodeEditor
        filePath={p.filePath ?? filePath}
        content={p.content ?? content}
        minimap={p.minimap}
        {...props}
      />
    )
  return { viewRef, rerender }
}

describe('CodeEditor view lifetime', () => {
  it('keeps the view across content, theme, minimap and settings changes', () => {
    const { viewRef, rerender } = setup()
    const first = viewRef.current!
    rerender({ content: 'two' })
    theme = { editorThemeId: 'default', contentVariant: 'light' }
    rerender({ content: 'two', minimap: true })
    appearance = { ...baseAppearance, editorTabSize: 4, editorWordWrap: 'on' }
    rerender({ content: 'two', minimap: true })
    expect(viewRef.current).toBe(first)
    // content is the initial doc only (external reloads go through `version`)
    expect(first.state.doc.toString()).toBe('one')
  })

  it('builds a new view from the current content on a file change', () => {
    const { viewRef, rerender } = setup()
    const first = viewRef.current!
    rerender({ filePath: 'b.ts', content: 'other' })
    expect(viewRef.current).not.toBe(first)
    expect(viewRef.current!.state.doc.toString()).toBe('other')
  })

  it('builds a new view on a font size change', () => {
    const { viewRef, rerender } = setup()
    const first = viewRef.current!
    appearance = { ...baseAppearance, editorFontSize: 16 }
    rerender({})
    expect(viewRef.current).not.toBe(first)
  })
})
