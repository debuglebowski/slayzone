// Chromium-fork Home — full experience via the shared @slayzone/home shell.
//
// Wraps HomeContainer (which owns all the data/filter/panel/repo wiring) with a
// thin interim project picker. The picker is temporary: it's replaced by the
// AppSidebar's project tree in a later slice. Project selection feeds
// HomeContainer's selectedProjectId.
import { useEffect, useState } from 'react'
import { useQuery, useTRPC } from '@slayzone/transport/client'
import { HomeContainer } from '@slayzone/home/client'

function Centered({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center bg-background px-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}

export function HomeView(): React.JSX.Element {
  const trpc = useTRPC()
  // Deduped board query (same key as HomeContainer's useTasksData) — populates
  // the interim picker AND drives the connection state without a second fetch.
  const boardQ = useQuery(trpc.task.loadBoardData.queryOptions(undefined, { staleTime: 30_000 }))
  const projects = (boardQ.data?.projects ?? []) as Array<{ id: string; name: string }>

  const [picked, setPicked] = useState('')
  const projectId = picked || projects[0]?.id || ''

  // A dead tRPC WebSocket leaves the query PENDING forever (wsLink retries, it
  // never errors). Escalate a long pending state to a connection warning.
  const [stalled, setStalled] = useState(false)
  useEffect(() => {
    if (boardQ.status !== 'pending') {
      setStalled(false)
      return
    }
    const t = setTimeout(() => setStalled(true), 5000)
    return () => clearTimeout(t)
  }, [boardQ.status])

  if (boardQ.status === 'error') {
    return <Centered>Couldn’t load the board: {boardQ.error?.message ?? 'unknown error'}. Retrying…</Centered>
  }
  if (boardQ.status === 'pending') {
    return <Centered>{stalled ? 'Can’t reach the sidecar — is the server running?' : 'Connecting…'}</Centered>
  }
  if (projects.length === 0) {
    return <Centered>No projects in this workspace yet.</Centered>
  }

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
        <span className="text-xs text-muted-foreground">Project</span>
        <select
          value={projectId}
          onChange={(e) => setPicked(e.target.value)}
          className="rounded-md border border-border bg-surface-2 px-2 py-1 text-sm text-foreground"
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <div className="min-h-0 flex-1">
        <HomeContainer selectedProjectId={projectId} isActive />
      </div>
    </div>
  )
}
