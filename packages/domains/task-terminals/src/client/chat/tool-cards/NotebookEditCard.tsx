import { NotebookPen } from 'lucide-react'
import { ChatDiffView } from '../diff-comments/ChatDiffView'
import { useChatView } from '../ChatViewContext'
import { ToolShell, resultTextOf, shortenPath, type ToolProps } from './card-shell'
import { FileLink } from './links'
import { codeViewDiff, notebookEditDiff } from './file-diffs'

interface NotebookEditInput {
  notebook_path?: string
  cell_id?: string
  new_source?: string
  cell_type?: string
  edit_mode?: string
}

/** NotebookEdit: the edited cell as a diff (old → new source), or the error. */
export function NotebookEditCard({ invocation, timestamp }: ToolProps) {
  const input = invocation.input as NotebookEditInput | null
  const result = (invocation.result?.structured ?? null) as
    | (NotebookEditInput & { error?: string })
    | null
  const { fileEditsOpenByDefault } = useChatView()
  const path = result?.notebook_path ?? input?.notebook_path ?? ''
  const cellId = result?.cell_id ?? input?.cell_id
  const mode = result?.edit_mode ?? input?.edit_mode ?? 'replace'
  const error = result?.error || (invocation.result?.isError ? resultTextOf(invocation) : '')
  const diff = error ? null : notebookEditDiff(input, result)
  const newSource = result?.new_source ?? input?.new_source ?? ''
  return (
    <ToolShell
      icon={<NotebookPen className="size-3" />}
      title="NotebookEdit"
      invocation={invocation}
      timestamp={timestamp}
      summary={`${shortenPath(path)}${cellId ? ` · cell ${cellId}` : ''} · ${mode}`}
      defaultOpen={fileEditsOpenByDefault}
    >
      {Boolean(path || error || diff || newSource) && (
        <div data-testid="tool-notebookedit">
          {path && (
            <div className="px-3 pt-2 pb-1 min-w-0">
              <FileLink path={path} />
            </div>
          )}
          {error ? (
            <pre className="px-3 pb-2 text-xs font-mono whitespace-pre-wrap text-destructive">
              {error}
            </pre>
          ) : diff ? (
            <div className="p-1">
              <ChatDiffView diff={diff} />
            </div>
          ) : newSource ? (
            <div className="p-1">
              <ChatDiffView diff={codeViewDiff(`${path}#new.txt`, newSource)} contextLines="all" />
            </div>
          ) : null}
        </div>
      )}
    </ToolShell>
  )
}
