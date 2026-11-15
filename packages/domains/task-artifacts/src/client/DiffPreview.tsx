import { FileText } from 'lucide-react'
import { DiffView, parseUnifiedDiff } from '@slayzone/diff-view'

/**
 * A `.diff` / `.patch` artifact rendered as the git panel renders a diff: one
 * DiffView per file under its path. Git patches and plain `diff -u` output both
 * parse (`parseUnifiedDiff`).
 */
export function DiffPreview({ content }: { content: string }) {
  const files = parseUnifiedDiff(content)
  if (files.length === 0)
    return (
      <div
        data-testid="artifact-diff-empty"
        className="flex-1 flex items-center justify-center px-6 text-center text-xs text-muted-foreground"
      >
        No diff found: this file has no unified-diff hunks. Switch to Raw to see its text.
      </div>
    )
  return (
    <div className="flex-1 min-h-0 overflow-auto font-mono text-xs">
      {files.map((file, i) => (
        <div key={`${i}:${file.path}`} className="border-b border-border">
          <div className="px-4 py-1.5 bg-muted/30 text-[11px] flex items-center gap-2">
            <FileText className="h-3 w-3 shrink-0" />
            <span className="truncate">
              {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
            </span>
            <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">
              +{file.additions} −{file.deletions}
            </span>
          </div>
          {file.isBinary ? (
            <div className="px-4 py-2 text-muted-foreground">Binary file</div>
          ) : (
            <DiffView diff={file} />
          )}
        </div>
      ))}
    </div>
  )
}
