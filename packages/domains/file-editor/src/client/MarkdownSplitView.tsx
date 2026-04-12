import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useTheme } from '@slayzone/settings/client'
import { getThemeEditorColors } from '@slayzone/ui'
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
      <div className="flex-1 border-l border-border overflow-y-auto min-w-0" style={{ background: colors.background, color: colors.foreground }}>
        <div className="prose prose-sm dark:prose-invert max-w-none p-4">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
      </div>
    </div>
  )
}
