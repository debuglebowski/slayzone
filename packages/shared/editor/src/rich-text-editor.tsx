import { useEffect, useRef, useState, useCallback, type CSSProperties, type MutableRefObject, type ReactNode, type ButtonHTMLAttributes } from 'react'
import { Editor, rootCtx, defaultValueCtx, editorViewCtx, commandsCtx } from '@milkdown/core'
import { commonmark, toggleStrongCommand, toggleEmphasisCommand, wrapInBulletListCommand, wrapInOrderedListCommand } from '@milkdown/preset-commonmark'
import { gfm } from '@milkdown/preset-gfm'
import { history } from '@milkdown/plugin-history'
import { indent } from '@milkdown/plugin-indent'
import { listener, listenerCtx } from '@milkdown/plugin-listener'
import { callCommand, replaceAll, $prose, $command } from '@milkdown/utils'
import { Plugin, PluginKey } from '@milkdown/prose/state'
import { cn } from '@slayzone/ui'
import type { EditorThemeColors } from './editor-themes'
import { createPlaceholderPlugin } from './milkdown-placeholder'
import { listItemMovePlugin } from './milkdown-list-move'
import { escapeBlurPlugin } from './milkdown-escape-blur'

export type { Editor }

interface FormatState {
  bold: boolean
  italic: boolean
  bulletList: boolean
  orderedList: boolean
  taskList: boolean
}

const emptyFormatState: FormatState = { bold: false, italic: false, bulletList: false, orderedList: false, taskList: false }

function readFormatState(state: import('@milkdown/prose/state').EditorState): FormatState {
  const { $from, from, to, empty } = state.selection
  const strong = state.schema.marks.strong
  const emphasis = state.schema.marks.emphasis
  const boldActive = strong ? (empty ? !!strong.isInSet(state.storedMarks || $from.marks()) : state.doc.rangeHasMark(from, to, strong)) : false
  const italicActive = emphasis ? (empty ? !!emphasis.isInSet(state.storedMarks || $from.marks()) : state.doc.rangeHasMark(from, to, emphasis)) : false

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

// Toggle task list: if in list item, toggle checked attr; otherwise wrap in bullet list
const toggleTaskListCommand = $command('ToggleTaskList', (ctx) => {
  return () => (state, dispatch) => {
    const { $from } = state.selection
    for (let d = $from.depth; d > 0; d--) {
      const node = $from.node(d)
      if (node.type.name === 'list_item') {
        if (dispatch) {
          const pos = $from.before(d)
          const checked = node.attrs.checked != null ? null : false
          dispatch(state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked }))
        }
        return true
      }
    }
    // Not in a list — wrap in bullet list as fallback
    const commands = ctx.get(commandsCtx)
    const wrapped = commands.call(wrapInBulletListCommand.key)
    if (wrapped) {
      // Now set checked on the newly created list item
      const view = ctx.get(editorViewCtx)
      const newState = view.state
      const { $from: $newFrom } = newState.selection
      for (let d = $newFrom.depth; d > 0; d--) {
        if ($newFrom.node(d).type.name === 'list_item') {
          const pos = $newFrom.before(d)
          view.dispatch(newState.tr.setNodeMarkup(pos, undefined, { ...$newFrom.node(d).attrs, checked: false }))
          break
        }
      }
    }
    return wrapped
  }
})

interface RichTextEditorProps {
  value: string
  onChange: (markdown: string) => void
  onBlur?: () => void
  placeholder?: string
  className?: string
  minHeight?: string
  maxHeight?: string
  testId?: string
  autoFocus?: boolean
  editorRef?: MutableRefObject<Editor | null>
  onReady?: (editor: Editor) => void
  fontFamily?: 'sans' | 'mono'
  lineSpacing?: 'compact' | 'normal'
  checkedHighlight?: boolean
  showToolbar?: boolean
  spellcheck?: boolean
  themeColors?: EditorThemeColors
}

export function RichTextEditor({
  value,
  onChange,
  onBlur,
  placeholder = '',
  className,
  minHeight,
  maxHeight,
  testId,
  autoFocus,
  editorRef: externalEditorRef,
  onReady,
  fontFamily,
  lineSpacing,
  checkedHighlight,
  showToolbar,
  spellcheck,
  themeColors
}: RichTextEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorInstanceRef = useRef<Editor | null>(null)
  const onChangeRef = useRef(onChange)
  const onBlurRef = useRef(onBlur)
  const onReadyRef = useRef(onReady)
  const contentRef = useRef(value)
  const suppressOnChange = useRef(false)
  const [formatState, setFormatState] = useState<FormatState>(emptyFormatState)
  const [editorReady, setEditorReady] = useState(false)

  onChangeRef.current = onChange
  onBlurRef.current = onBlur
  onReadyRef.current = onReady

  // Create editor
  useEffect(() => {
    if (!containerRef.current) return

    let prevFormats = emptyFormatState
    const formatStatePlugin = $prose(() => new Plugin({
      key: new PluginKey('formatState'),
      view: () => ({
        update: (view) => {
          const next = readFormatState(view.state)
          if (next.bold !== prevFormats.bold || next.italic !== prevFormats.italic ||
              next.bulletList !== prevFormats.bulletList || next.orderedList !== prevFormats.orderedList ||
              next.taskList !== prevFormats.taskList) {
            prevFormats = next
            setFormatState(next)
          }
        }
      })
    }))

    const blurHandlerPlugin = $prose(() => new Plugin({
      key: new PluginKey('blurHandler'),
      props: {
        handleDOMEvents: {
          blur: () => { onBlurRef.current?.(); return false }
        }
      }
    }))

    const placeholderPlugin = createPlaceholderPlugin(placeholder)

    const editor = Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, containerRef.current!)
        ctx.set(defaultValueCtx, contentRef.current)
      })
      .config((ctx) => {
        ctx.get(listenerCtx)
          .markdownUpdated((_ctx, markdown, prevMarkdown) => {
            if (suppressOnChange.current) return
            if (markdown === prevMarkdown) return
            contentRef.current = markdown
            onChangeRef.current(markdown)
          })
      })
      .use(commonmark)
      .use(gfm)
      .use(history)
      .use(indent)
      .use(listener)
      .use(placeholderPlugin)
      .use(listItemMovePlugin)
      .use(escapeBlurPlugin)
      .use(toggleTaskListCommand)
      .use(formatStatePlugin)
      .use(blurHandlerPlugin)

    editor.create().then((e) => {
      editorInstanceRef.current = e
      if (externalEditorRef) externalEditorRef.current = e

      setEditorReady(true)

      if (autoFocus) {
        const view = e.ctx.get(editorViewCtx)
        view.focus()
      }

      onReadyRef.current?.(e)
    }).catch((err) => {
      console.error('[RichTextEditor] Failed to create editor:', err)
    })

    return () => {
      editor.destroy().catch(() => {})
      editorInstanceRef.current = null
      if (externalEditorRef) externalEditorRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Sync external value changes
  useEffect(() => {
    const editor = editorInstanceRef.current
    if (!editor || contentRef.current === value) return
    contentRef.current = value
    suppressOnChange.current = true
    try {
      editor.action(replaceAll(value, true))
    } catch {
      // Editor may not be ready yet
    }
    suppressOnChange.current = false
  }, [value])

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleCommand = useCallback((cmdKey: any) => {
    editorInstanceRef.current?.action(callCommand(cmdKey))
  }, [])

  const themeStyle = themeColors ? {
    '--mk-bg': themeColors.background,
    '--mk-fg': themeColors.foreground,
    '--mk-heading': themeColors.heading,
    '--mk-link': themeColors.link,
    '--mk-code': themeColors.keyword,
    '--mk-code-bg': themeColors.selection,
    '--mk-comment': themeColors.comment,
    '--prose-body': themeColors.foreground,
    '--prose-headings': themeColors.heading,
    '--prose-links': themeColors.link,
    '--prose-code': themeColors.keyword,
    '--prose-selection': themeColors.selection,
    '--prose-muted': themeColors.comment,
    backgroundColor: themeColors.background,
    color: themeColors.foreground,
    minHeight,
    maxHeight,
  } as CSSProperties : { minHeight, maxHeight }

  return (
    <div
      data-testid={testId}
      className={cn(
        'w-full h-full flex flex-col',
        fontFamily === 'mono' && 'font-mono',
        lineSpacing === 'compact' && 'prose-tight',
        checkedHighlight && 'checked-highlight',
        themeColors && 'editor-themed rounded',
        className
      )}
      style={themeStyle}
      spellCheck={spellcheck !== false}
    >
      {showToolbar && editorReady && (
        <EditorToolbar
          formatState={formatState}
          onCommand={handleCommand}
        />
      )}
      <div
        ref={containerRef}
        className={cn(
          'milkdown-editor prose prose-sm max-w-none flex-1 overflow-y-auto focus-within:outline-none',
          themeColors ? 'milkdown-themed' : 'dark:prose-invert',
        )}
      />
    </div>
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function EditorToolbar({ formatState, onCommand }: { formatState: FormatState; onCommand: (cmd: any) => void }) {
  return (
    <div className="flex items-center gap-0.5 border-b border-border/50 px-1 py-1 shrink-0">
      <ToolbarButton
        active={formatState.bold}
        onClick={() => onCommand(toggleStrongCommand.key)}
        aria-label="Bold"
        title="Bold"
      >
        B
      </ToolbarButton>
      <ToolbarButton
        active={formatState.italic}
        onClick={() => onCommand(toggleEmphasisCommand.key)}
        aria-label="Italic"
        title="Italic"
      >
        <span className="italic">I</span>
      </ToolbarButton>
      <div className="mx-1 h-4 w-px bg-border/50" />
      <ToolbarButton
        active={formatState.bulletList}
        onClick={() => onCommand(wrapInBulletListCommand.key)}
        aria-label="Bullet list"
        title="Bullet list"
      >
        <svg className="size-3.5" viewBox="0 0 16 16" fill="currentColor"><circle cx="3" cy="4" r="1.5" /><circle cx="3" cy="8" r="1.5" /><circle cx="3" cy="12" r="1.5" /><rect x="6" y="3" width="9" height="2" rx="0.5" /><rect x="6" y="7" width="9" height="2" rx="0.5" /><rect x="6" y="11" width="9" height="2" rx="0.5" /></svg>
      </ToolbarButton>
      <ToolbarButton
        active={formatState.orderedList}
        onClick={() => onCommand(wrapInOrderedListCommand.key)}
        aria-label="Ordered list"
        title="Ordered list"
      >
        <svg className="size-3.5" viewBox="0 0 16 16" fill="currentColor"><text x="1" y="5.5" fontSize="5" fontFamily="sans-serif">1</text><text x="1" y="9.5" fontSize="5" fontFamily="sans-serif">2</text><text x="1" y="13.5" fontSize="5" fontFamily="sans-serif">3</text><rect x="6" y="3" width="9" height="2" rx="0.5" /><rect x="6" y="7" width="9" height="2" rx="0.5" /><rect x="6" y="11" width="9" height="2" rx="0.5" /></svg>
      </ToolbarButton>
      <ToolbarButton
        active={formatState.taskList}
        onClick={() => onCommand(toggleTaskListCommand.key)}
        aria-label="Checkbox list"
        title="Checkbox list"
      >
        <svg className="size-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="1" y="2" width="4" height="4" rx="0.75" /><rect x="1" y="6" width="4" height="4" rx="0.75" /><rect x="1" y="10" width="4" height="4" rx="0.75" /><path d="M2 8.5 3 9.5 4.5 7.5" strokeLinecap="round" strokeLinejoin="round" /><line x1="7" y1="4" x2="15" y2="4" /><line x1="7" y1="8" x2="15" y2="8" /><line x1="7" y1="12" x2="15" y2="12" /></svg>
      </ToolbarButton>
    </div>
  )
}

function ToolbarButton({
  active,
  onClick,
  children,
  ...props
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex items-center justify-center size-7 rounded text-xs font-semibold transition-colors',
        active
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
      )}
      {...props}
    >
      {children}
    </button>
  )
}
