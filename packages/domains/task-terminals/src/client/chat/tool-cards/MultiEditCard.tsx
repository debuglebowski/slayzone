import { Pencil } from 'lucide-react'
import { ChatDiffView } from '../diff-comments/ChatDiffView'
import { useChatView } from '../ChatViewContext'
import { claudeEditResultToFileDiff } from '../claude-patch-to-filediff'
import { ToolShell, shortenPath, type ToolProps } from './card-shell'
import { FileLink } from './links'

/** MultiEdit (older Claude Code): the combined diff, or each edit before the result. */
export function MultiEditCard({ invocation, timestamp }: ToolProps) {
  const input = invocation.input as {
    file_path?: string
    edits?: Array<{ old_string?: string; new_string?: string }>
  } | null
  const { fileEditsOpenByDefault } = useChatView()
  const edits = input?.edits ?? []
  const fileDiff = invocation.result
    ? claudeEditResultToFileDiff(invocation.result.structured)
    : null
  const path = input?.file_path ?? fileDiff?.path ?? ''
  return (
    <ToolShell
      icon={<Pencil className="size-3" />}
      title="MultiEdit"
      invocation={invocation}
      timestamp={timestamp}
      summary={`${shortenPath(path)} · ${edits.length} edit${edits.length === 1 ? '' : 's'}`}
      defaultOpen={fileEditsOpenByDefault}
    >
      {Boolean(path || fileDiff || edits.length > 0) && (
        <div data-testid="tool-multiedit">
          {path && (
            <div className="px-3 pt-2 pb-1 min-w-0">
              <FileLink path={path} />
            </div>
          )}
          {fileDiff ? (
            <div className="p-1">
              <ChatDiffView diff={fileDiff} />
            </div>
          ) : edits.length > 0 ? (
            <div className="p-3 text-xs font-mono grid gap-2">
              {edits.map((e, i) => (
                <div key={i} className="grid gap-1">
                  <div className="text-diff-removed-foreground whitespace-pre-wrap">
                    - {e.old_string}
                  </div>
                  <div className="text-diff-added-foreground whitespace-pre-wrap">
                    + {e.new_string}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </ToolShell>
  )
}
