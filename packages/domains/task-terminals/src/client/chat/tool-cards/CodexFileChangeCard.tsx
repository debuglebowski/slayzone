import { useMemo } from 'react'
import { FilePlus, FileMinus, Pencil } from 'lucide-react'
import {
  codexChangeCounts,
  codexFileChanges,
  type CodexFileChange
} from '@slayzone/terminal/client'
import { useChatView } from '../ChatViewContext'
import { ChatDiffView } from '../diff-comments/ChatDiffView'
import { ToolShell, shortenPath, type ToolProps } from './card-shell'
import { FileLink } from './links'
import { relativeToCwd } from '../files-changed/relative-path'
import { codexChangeFileDiff } from './file-diffs'

const KIND_LABEL: Record<CodexFileChange['kind'], string> = {
  add: 'Created',
  update: 'Edited',
  delete: 'Deleted'
}

/**
 * A Codex file change (`fileChange`): one item can change several files — one
 * diff per file (lines can be commented on where the provider takes it). Shown
 * from the started item too, so a change waiting for approval shows its diff.
 */
export function CodexFileChangeCard({ invocation, timestamp }: ToolProps) {
  const { fileEditsOpenByDefault, cwd } = useChatView()
  const files = useMemo(
    () =>
      codexFileChanges(invocation).map((change) => ({
        change,
        diff: codexChangeFileDiff(change),
        counts: codexChangeCounts(change)
      })),
    [invocation]
  )
  const additions = files.reduce((n, f) => n + f.counts.additions, 0)
  const deletions = files.reduce((n, f) => n + f.counts.deletions, 0)
  const only = files.length === 1 ? files[0].change : null
  const title = only
    ? only.kind === 'add'
      ? 'Create'
      : only.kind === 'delete'
        ? 'Delete'
        : 'Edit'
    : 'Edit'
  const icon =
    only?.kind === 'add' ? (
      <FilePlus className="size-3" />
    ) : only?.kind === 'delete' ? (
      <FileMinus className="size-3" />
    ) : (
      <Pencil className="size-3" />
    )
  const summary = `${only ? shortenPath(relativeToCwd(only.path, cwd)) : `${files.length} files`} · +${additions} −${deletions}`
  return (
    <div data-testid="tool-codex-file-change">
      <ToolShell
        icon={icon}
        title={title}
        invocation={invocation}
        timestamp={timestamp}
        summary={summary}
        defaultOpen={fileEditsOpenByDefault}
      >
        {files.length > 0 && (
          <div className="grid gap-1 p-1">
            {files.map(({ change, diff, counts }, i) => (
              <div key={`${change.path}:${i}`} data-testid="codex-file-change-file">
                {!only && (
                  <div className="flex items-center gap-2 px-2 py-1 text-[11px] text-muted-foreground font-mono">
                    <span className="shrink-0">{KIND_LABEL[change.kind]}</span>
                    <FileLink path={change.path} label={relativeToCwd(change.path, cwd)} />
                    <span className="shrink-0 tabular-nums">
                      +{counts.additions} −{counts.deletions}
                    </span>
                  </div>
                )}
                {change.movedFrom && (
                  <div className="px-2 py-0.5 text-[11px] text-muted-foreground font-mono">
                    moved from {relativeToCwd(change.movedFrom, cwd)}
                  </div>
                )}
                {diff ? (
                  <ChatDiffView diff={diff} />
                ) : (
                  <div className="px-2 py-1 text-[11px] italic text-muted-foreground">
                    No changes
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </ToolShell>
    </div>
  )
}
