import { useState, useEffect, type CSSProperties, type MutableRefObject } from 'react'
import { Markdown } from '@slayzone/markdown/client'
import { getThemeEditorColors, useAppearance, useTheme } from '@slayzone/ui'
import { resolveReadOnlyLinkClickTarget, type LinkOpenTarget } from '@slayzone/editor'
import type { EditorView } from '@codemirror/view'
import { CodeEditor } from './CodeEditor'

interface MarkdownSplitViewProps {
  filePath: string
  content: string
  onChange: (content: string) => void
  onSave: () => void
  /** Clicked preview links (read-only: bare click opens too). */
  onOpenLink: (href: string, target: LinkOpenTarget) => void
  version?: number
  goToPosition?: { line: number; col: number } | null
  onGoToPositionApplied?: () => void
  minimap?: boolean
  viewHandleRef?: MutableRefObject<EditorView | null>
}

export function MarkdownSplitView({
  filePath,
  content,
  onChange,
  onSave,
  onOpenLink,
  version,
  goToPosition,
  onGoToPositionApplied,
  minimap,
  viewHandleRef
}: MarkdownSplitViewProps) {
  const { editorThemeId, contentVariant } = useTheme()
  const colors = getThemeEditorColors(editorThemeId, contentVariant)
  const { notesReadability, notesWidth } = useAppearance()

  // Debounce preview updates so ReactMarkdown (and MermaidBlock) only re-render
  // when typing pauses — eliminates diagram flicker from positional remounts
  const [previewContent, setPreviewContent] = useState(content)
  useEffect(() => {
    const timer = setTimeout(() => setPreviewContent(content), 300)
    return () => clearTimeout(timer)
  }, [content])

  const [previewClickPos, setPreviewClickPos] = useState<{ line: number; col: number } | null>(null)
  const effectiveGoTo = previewClickPos ?? goToPosition
  const handleGoToApplied = () => {
    if (previewClickPos) setPreviewClickPos(null)
    else onGoToPositionApplied?.()
  }

  const themeStyle = {
    '--mk-bg': colors.background,
    '--mk-fg': colors.foreground,
    '--mk-heading': colors.heading,
    '--mk-link': colors.link,
    '--mk-code-fg': colors.keyword,
    '--mk-code-bg': colors.selection,
    '--mk-quote-border': colors.comment,
    '--mk-hr-color': colors.comment
  } as CSSProperties

  return (
    <div className="flex-1 flex flex-row overflow-hidden h-full">
      <div className="flex-1 min-w-0 min-h-0">
        <CodeEditor
          filePath={filePath}
          content={content}
          onChange={onChange}
          onSave={onSave}
          version={version}
          goToPosition={effectiveGoTo}
          onGoToPositionApplied={handleGoToApplied}
          minimap={minimap}
          viewHandleRef={viewHandleRef}
        />
      </div>
      <div
        className="flex-1 border-l border-border min-w-0 min-h-0"
        onClick={(e) => {
          // Never let a preview anchor navigate the app window itself.
          const anchor = (e.target as HTMLElement).closest('a[href]')
          if (anchor) {
            e.preventDefault()
            const href = anchor.getAttribute('href') ?? ''
            const target = resolveReadOnlyLinkClickTarget(href, e)
            if (target) onOpenLink(href, target)
            return
          }
          const el = (e.target as HTMLElement).closest('[data-source-line]')
          const line = el ? parseInt(el.getAttribute('data-source-line') || '1', 10) : 1
          setPreviewClickPos({ line: Number.isFinite(line) ? line : 1, col: 0 })
        }}
      >
        <div
          className="mk-doc"
          data-readability={notesReadability}
          data-width={notesWidth}
          style={themeStyle}
        >
          <div className="mk-doc-scroll">
            <div className="mk-doc-body">
              <Markdown attachSourceLines>{previewContent}</Markdown>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
