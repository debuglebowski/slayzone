import type { CSSProperties } from 'react'
import { Editor, editorViewCtx } from '@milkdown/core'
import type { EditorThemeColors } from './editor-themes'
import type { FormatState } from './rich-text-editor.types'

/** Get the editor's root DOM node (for scoped queries like in-doc anchor lookups). */
export function getEditorViewDOM(editor: Editor): HTMLElement | null {
  try {
    return editor.ctx.get(editorViewCtx).dom as HTMLElement
  } catch {
    return null
  }
}

export function readFormatState(state: import('@milkdown/prose/state').EditorState): FormatState {
  const { $from, from, to, empty } = state.selection
  const strong = state.schema.marks.strong
  const emphasis = state.schema.marks.emphasis
  const boldActive = strong
    ? empty
      ? !!strong.isInSet(state.storedMarks || $from.marks())
      : state.doc.rangeHasMark(from, to, strong)
    : false
  const italicActive = emphasis
    ? empty
      ? !!emphasis.isInSet(state.storedMarks || $from.marks())
      : state.doc.rangeHasMark(from, to, emphasis)
    : false

  let bulletList = false
  let orderedList = false
  let taskList = false
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d)
    if (node.type.name === 'bullet_list') bulletList = true
    if (node.type.name === 'ordered_list') orderedList = true
    if (node.type.name === 'list_item' && node.attrs.checked != null) taskList = true
  }
  return { bold: boldActive, italic: italicActive, bulletList, orderedList, taskList }
}

/** Build the CSS custom-property style object that themes the editor surface. */
export function buildEditorThemeStyle(
  themeColors: EditorThemeColors | undefined,
  minHeight: string | undefined,
  maxHeight: string | undefined
): CSSProperties {
  return themeColors
    ? ({
        '--mk-bg': themeColors.background,
        '--mk-fg': themeColors.foreground,
        '--mk-heading': themeColors.heading,
        '--mk-link': themeColors.link,
        '--mk-code-fg': themeColors.keyword,
        '--mk-code-bg': themeColors.selection,
        '--mk-quote-border': themeColors.comment,
        '--mk-hr-color': themeColors.comment,
        minHeight,
        maxHeight
      } as CSSProperties)
    : { minHeight, maxHeight }
}
