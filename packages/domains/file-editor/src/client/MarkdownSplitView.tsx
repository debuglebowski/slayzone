import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { isValidElement, useState, useEffect, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { MermaidBlock } from './MermaidBlock'
import { useTheme } from '@slayzone/settings/client'
import { getThemeEditorColors, useAppearance } from '@slayzone/ui'
import { CodeEditor } from './CodeEditor'

const markdownComponents = {
  pre({ children }: { children?: ReactNode }) {
    if (isValidElement(children)) {
      const child = children as ReactElement<{ className?: string; children?: ReactNode }>
      if (child.props?.className === 'language-mermaid') {
        return <MermaidBlock code={String(child.props.children ?? '').replace(/\n$/, '')} />
      }
    }
    return <pre>{children}</pre>
  },
}

interface MarkdownSplitViewProps {
  filePath: string
  content: string
  onChange: (content: string) => void
  onSave: () => void
  version?: number
  goToPosition?: { line: number; col: number } | null
  onGoToPositionApplied?: () => void
}

export function MarkdownSplitView({ filePath, content, onChange, onSave, version, goToPosition, onGoToPositionApplied }: MarkdownSplitViewProps) {
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

  const themeStyle = {
    '--mk-bg': colors.background,
    '--mk-fg': colors.foreground,
    '--mk-heading': colors.heading,
    '--mk-link': colors.link,
    '--mk-code-fg': colors.keyword,
    '--mk-code-bg': colors.selection,
    '--mk-quote-border': colors.comment,
    '--mk-hr-color': colors.comment,
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
          goToPosition={goToPosition}
          onGoToPositionApplied={onGoToPositionApplied}
        />
      </div>
      <div className="flex-1 border-l border-border min-w-0 min-h-0">
        <div className="mk-doc" data-readability={notesReadability} data-width={notesWidth} style={themeStyle}>
          <div className="mk-doc-scroll">
            <div className="mk-doc-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                {previewContent}
              </ReactMarkdown>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
