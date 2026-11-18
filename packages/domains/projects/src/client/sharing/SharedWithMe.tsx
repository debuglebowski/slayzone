import { useQuery } from '@tanstack/react-query'
import { FileText, SquareCheck } from 'lucide-react'
import { useTRPC } from '../trpc'
import { ROLE_LABEL, useSharingStatus } from './useSharing'

/**
 * Tasks and files other people invited the caller to on their own — outside every
 * project it is in (T-100). Renders nothing without login, or when there are none.
 */
export function SharedWithMe({
  onOpenTask,
  onOpenArtifact
}: {
  onOpenTask: (taskId: string) => void
  onOpenArtifact: (taskId: string, artifactId: string) => void
}): React.JSX.Element | null {
  const trpc = useTRPC()
  const { enabled } = useSharingStatus()
  const q = useQuery({ ...trpc.sharing.sharedWithMe.queryOptions(), enabled })
  const tasks = q.data?.tasks ?? []
  const artifacts = q.data?.artifacts ?? []
  if (!enabled || tasks.length + artifacts.length === 0) return null
  return (
    <section className="space-y-1" data-testid="shared-with-me">
      <h3 className="px-2 text-xs font-medium text-muted-foreground">Shared with me</h3>
      <ul>
        {tasks.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-accent"
              onClick={() => onOpenTask(t.id)}
            >
              <SquareCheck className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{t.title}</span>
              <span className="text-xs text-muted-foreground">{ROLE_LABEL[t.role]}</span>
            </button>
          </li>
        ))}
        {artifacts.map((a) => (
          <li key={a.id}>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-accent"
              onClick={() => onOpenArtifact(a.taskId, a.id)}
            >
              <FileText className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{a.title}</span>
              <span className="text-xs text-muted-foreground">{ROLE_LABEL[a.role]}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
