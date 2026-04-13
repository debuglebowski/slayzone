import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { CSSProperties } from 'react'
import { useTheme } from '@slayzone/settings/client'
import { getThemeEditorColors, useAppearance } from '@slayzone/ui'
import { noteVariant } from '@slayzone/editor'
import { CodeEditor } from './CodeEditor'

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
  const { notesLineSpacing } = useAppearance()
  const variant = noteVariant(notesLineSpacing)

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
        <div className="mk-doc" data-variant={variant} style={themeStyle}>
          <div className="mk-doc-scroll">
            <div className="mk-doc-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
