import { useEffect, useRef } from 'react'
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from '@milkdown/core'
import { commonmark } from '@milkdown/preset-commonmark'
import { gfm } from '@milkdown/preset-gfm'
import { history } from '@milkdown/plugin-history'
import { indent } from '@milkdown/plugin-indent'
import { listener, listenerCtx } from '@milkdown/plugin-listener'
import { replaceAll } from '@milkdown/utils'
import { remarkFrontmatterPlugin, frontmatterSchema, frontmatterView } from './milkdown-frontmatter'

// --- Component ---

interface MarkdownFileEditorProps {
  filePath: string
  content: string
  onChange: (content: string) => void
  onSave: () => void
  /** Bump to replace editor content from external source (e.g. disk reload) */
  version?: number
}

export function MarkdownFileEditor({ filePath, content, onChange, onSave, version }: MarkdownFileEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<Editor | null>(null)
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)
  const contentRef = useRef(content)
  const suppressOnChange = useRef(false)

  onChangeRef.current = onChange
  onSaveRef.current = onSave
  contentRef.current = content

  // Create editor
  useEffect(() => {
    if (!containerRef.current) return

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
      .use(remarkFrontmatterPlugin)
      .use(frontmatterSchema)
      .use(frontmatterView)

    editor.create().then((e) => {
      editorRef.current = e

      // Cmd+S via DOM keydown on the editor view
      const view = e.ctx.get(editorViewCtx)
      view.dom.addEventListener('keydown', (event: KeyboardEvent) => {
        if ((event.metaKey || event.ctrlKey) && event.key === 's') {
          event.preventDefault()
          onSaveRef.current()
        }
      })
    }).catch((err) => {
      console.error('[MarkdownFileEditor] Failed to create editor:', err)
    })

    return () => {
      editor.destroy().catch(() => {})
      editorRef.current = null
    }
  }, [filePath]) // eslint-disable-line react-hooks/exhaustive-deps

  // External content reload (disk change)
  useEffect(() => {
    if (version === undefined || !editorRef.current) return
    suppressOnChange.current = true
    editorRef.current.action(replaceAll(contentRef.current, true))
    suppressOnChange.current = false
  }, [version])

  return (
    <div className="h-full w-full overflow-auto">
      <div
        ref={containerRef}
        className="milkdown-editor prose prose-sm dark:prose-invert max-w-none px-6 py-4 focus-within:outline-none"
        style={{ fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}
      />
    </div>
  )
}
