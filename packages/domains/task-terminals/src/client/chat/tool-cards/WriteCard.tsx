import { useState } from 'react'
import { FilePlus } from 'lucide-react'
import { DiffView } from '@slayzone/diff-view'
import { useChatView } from '../ChatViewContext'
import { claudeEditResultToFileDiff } from '../claude-patch-to-filediff'
import { ToolShell, shortenPath, type ToolProps } from './card-shell'
import { CardBadge, FileLink } from './links'
import { codeViewDiff } from './file-diffs'

/** Lines a long file shows before "Show all". */
const PREVIEW_LINES = 300

interface WriteResult {
  type?: 'create' | 'update'
  filePath?: string
  content?: string
  structuredPatch?: unknown[]
}

/**
 * Write: a new file as a syntax-highlighted code view, an overwrite as the diff
 * against the old file. The path opens the file.
 */
export function WriteCard({ invocation, timestamp }: ToolProps) {
  const input = invocation.input as { file_path?: string; content?: string } | null
  const result = (invocation.result?.structured ?? null) as WriteResult | null
  const { fileEditsOpenByDefault } = useChatView()
  const [showAll, setShowAll] = useState(false)
  const path = result?.filePath ?? input?.file_path ?? ''
  const content = result?.content ?? input?.content ?? ''
  const lines = (content.endsWith('\n') ? content.slice(0, -1) : content).split('\n')
  const lineCount = content ? lines.length : 0
  const overwrite =
    result?.type === 'update' &&
    Array.isArray(result.structuredPatch) &&
    result.structuredPatch.length > 0
  const patchDiff = overwrite ? claudeEditResultToFileDiff(result) : null
  const truncated = !patchDiff && !showAll && lineCount > PREVIEW_LINES
  const codeDiff = patchDiff
    ? null
    : codeViewDiff(path, truncated ? lines.slice(0, PREVIEW_LINES).join('\n') : content)
  return (
    <ToolShell
      icon={<FilePlus className="size-3" />}
      title="Write"
      invocation={invocation}
      timestamp={timestamp}
      summary={`${shortenPath(path)}${lineCount ? ` · ${lineCount} line${lineCount === 1 ? '' : 's'}` : ''}`}
      defaultOpen={fileEditsOpenByDefault}
    >
      {Boolean(path || content) && (
        <div data-testid="tool-write" data-write-type={result?.type ?? 'pending'}>
          {path && (
            <div className="flex items-center gap-2 px-3 pt-2 pb-1 min-w-0">
              <FileLink path={path} />
              {result?.type === 'create' && <CardBadge>New file</CardBadge>}
              {result?.type === 'update' && <CardBadge>Overwrote</CardBadge>}
            </div>
          )}
          {patchDiff ? (
            <div className="p-1">
              <DiffView diff={patchDiff} />
            </div>
          ) : content ? (
            <div className="p-1">
              <DiffView diff={codeDiff!} contextLines="all" />
              {truncated && (
                <button
                  type="button"
                  onClick={() => setShowAll(true)}
                  className="mx-2 my-1 text-[11px] text-primary hover:underline"
                >
                  Show all {lineCount} lines
                </button>
              )}
            </div>
          ) : null}
        </div>
      )}
    </ToolShell>
  )
}
