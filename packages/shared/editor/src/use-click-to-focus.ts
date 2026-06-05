import { useEffect, useRef, type MutableRefObject } from 'react'
import { Editor, editorViewCtx } from '@milkdown/core'
import { TextSelection } from '@milkdown/prose/state'

/**
 * Click anywhere within `.mk-doc` → focus editor + place caret near click coords.
 * Skips clicks on text descendants of `.ProseMirror` (PM handles natively) and on buttons.
 * Capture phase + native listener bypasses any React delegation timing or PM stopPropagation.
 */
export function useClickToFocus(
  editorInstanceRef: MutableRefObject<Editor | null>,
  editorReady: boolean
): MutableRefObject<HTMLDivElement | null> {
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const node = rootRef.current
    if (!node || !editorReady) return
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      const pm = target.closest('.ProseMirror')
      if (pm && pm !== target) return
      if (target.closest('button, [role="button"]')) return
      if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return
      const editor = editorInstanceRef.current
      if (!editor) return
      e.preventDefault()
      try {
        const view = editor.ctx.get(editorViewCtx)
        const result = view.posAtCoords({ left: e.clientX, top: e.clientY })
        const selection = result
          ? TextSelection.near(view.state.doc.resolve(result.pos))
          : TextSelection.atEnd(view.state.doc)
        view.dispatch(view.state.tr.setSelection(selection))
        view.focus()
      } catch {
        /* editor not ready */
      }
    }
    node.addEventListener('mousedown', handler, true)
    return () => node.removeEventListener('mousedown', handler, true)
  }, [editorReady]) // eslint-disable-line react-hooks/exhaustive-deps

  return rootRef
}
