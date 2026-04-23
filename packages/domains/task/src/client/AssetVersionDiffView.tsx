import { cn } from '@slayzone/ui'
import type { DiffHunk, DiffResult } from '@slayzone/task-assets/shared'

type SideDiffCell = { kind: 'add' | 'del' | 'ctx' | 'empty'; text: string }
type SideDiffRow = { left: SideDiffCell; right: SideDiffCell }

function hunkToSideBySideRows(hunk: DiffHunk): SideDiffRow[] {
  const rows: SideDiffRow[] = []
  let dels: string[] = []
  let adds: string[] = []
  const flush = () => {
    const max = Math.max(dels.length, adds.length)
    for (let i = 0; i < max; i++) {
      rows.push({
        left: i < dels.length ? { kind: 'del', text: dels[i] } : { kind: 'empty', text: '' },
        right: i < adds.length ? { kind: 'add', text: adds[i] } : { kind: 'empty', text: '' },
      })
    }
    dels = []
    adds = []
  }
  for (const line of hunk.lines) {
    if (line.kind === 'del') dels.push(line.text)
    else if (line.kind === 'add') adds.push(line.text)
    else {
      flush()
      rows.push({
        left: { kind: 'ctx', text: line.text },
        right: { kind: 'ctx', text: line.text },
      })
    }
  }
  flush()
  return rows
}

export function AssetVersionDiffView({ diff }: { diff: DiffResult }) {
  if (diff.kind === 'binary') {
    return (
      <pre className="font-mono text-xs bg-muted p-3 rounded">
        (binary differs)
        {`\n  a: ${diff.a.hash.slice(0, 8)}  ${diff.a.size} bytes`}
        {`\n  b: ${diff.b.hash.slice(0, 8)}  ${diff.b.size} bytes`}
      </pre>
    )
  }
  if (diff.hunks.length === 0) {
    return (
      <pre className="font-mono text-xs bg-muted p-3 rounded text-muted-foreground">
        (no differences)
      </pre>
    )
  }
  return (
    <div className="font-mono text-xs bg-muted rounded max-h-[60vh] overflow-auto">
      {diff.hunks.map((hunk, hi) => (
        <div key={hi} className={hi > 0 ? 'border-t border-border' : ''}>
          {hunkToSideBySideRows(hunk).map((row, ri) => (
            <div key={ri} className="grid grid-cols-2 gap-px">
              <div
                className={cn(
                  'px-2 py-0.5 whitespace-pre-wrap break-words border-r border-border/30',
                  row.left.kind === 'del' && 'bg-red-500/10 text-red-700 dark:text-red-400',
                  row.left.kind === 'ctx' && 'opacity-70',
                  row.left.kind === 'empty' && 'bg-muted-foreground/5',
                )}
              >
                {row.left.kind !== 'empty' && row.left.text}
                {row.left.kind === 'empty' && ' '}
              </div>
              <div
                className={cn(
                  'px-2 py-0.5 whitespace-pre-wrap break-words',
                  row.right.kind === 'add' && 'bg-green-500/10 text-green-700 dark:text-green-400',
                  row.right.kind === 'ctx' && 'opacity-70',
                  row.right.kind === 'empty' && 'bg-muted-foreground/5',
                )}
              >
                {row.right.kind !== 'empty' && row.right.text}
                {row.right.kind === 'empty' && ' '}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
