import { useEffect, type MutableRefObject } from 'react'
import { Editor, editorViewCtx } from '@milkdown/core'
import { setSearch as setMilkdownSearch } from './milkdown-search-highlight'

/** Push the host's search state into the editor's search-highlight plugin. */
export function useEditorSearch(
  editorInstanceRef: MutableRefObject<Editor | null>,
  editorReady: boolean,
  searchQuery: string,
  searchActiveIndex: number,
  searchMatchCase: boolean,
  searchRegex: boolean
): void {
  useEffect(() => {
    const editor = editorInstanceRef.current
    if (!editor || !editorReady) return
    try {
      const view = editor.ctx.get(editorViewCtx)
      setMilkdownSearch(view, searchQuery, searchActiveIndex, searchMatchCase, searchRegex)
    } catch {
      /* editor not ready */
    }
  }, [searchQuery, searchActiveIndex, searchMatchCase, searchRegex, editorReady]) // eslint-disable-line react-hooks/exhaustive-deps
}
