import { initials } from './LeaderboardPage.utils'

export interface TableRow {
  key: string
  name: string
  image: string | null
  value: string
  rank?: number
}

export function LeaderboardTable({
  icon,
  title,
  rows,
  viewerRow
}: {
  icon: React.JSX.Element
  title: string
  rows: TableRow[] | undefined
  viewerRow: TableRow | null | undefined
}): React.JSX.Element {
  return (
    <div className="rounded-xl border bg-surface-1 overflow-hidden min-w-0 h-full flex flex-col">
      <div className="px-4 py-3 border-b bg-muted/20">
        <div className="flex items-center gap-3 h-12">
          <span className="text-muted-foreground">{icon}</span>
          <h2 className="text-sm font-semibold leading-tight overflow-hidden">{title}</h2>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {rows === undefined ? (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
            Loading…
          </div>
        ) : rows.length === 0 ? (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
            No data yet
          </div>
        ) : (
          <>
            {rows.map((row, index) => (
              <LeaderboardRow key={row.key} row={row} rank={index + 1} />
            ))}
            {viewerRow && (
              <>
                <div className="flex items-center justify-center gap-2 py-1 text-xs text-muted-foreground/50">
                  <span>·····</span>
                </div>
                <LeaderboardRow row={viewerRow} rank={viewerRow.rank!} isViewer />
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function LeaderboardRow({
  row,
  rank,
  isViewer = false
}: {
  row: TableRow
  rank: number
  isViewer?: boolean
}): React.JSX.Element {
  return (
    <div
      className={`flex items-center gap-3 px-3 py-3 border-b last:border-b-0 hover:bg-muted/30 transition-colors ${isViewer ? 'bg-primary/5' : ''}`}
    >
      <span className="inline-flex w-8 text-xs font-medium tabular-nums text-muted-foreground/70">
        #{rank}
      </span>
      {row.image ? (
        <img src={row.image} alt={row.name} className="h-8 w-8 rounded-full object-cover" />
      ) : (
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-muted text-[11px] font-medium">
          {initials(row.name)}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{row.name}</p>
      </div>
      <div className="text-right">
        <p className="text-sm font-semibold tabular-nums">{row.value}</p>
      </div>
    </div>
  )
}
