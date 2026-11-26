import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { FileText, Share2 } from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn
} from '@slayzone/ui'
import { useTRPC } from '../trpc'
import { useDirectory, useSharingStatus } from './useSharing'

type SharedArtifact = {
  id: string
  title: string
  projectId: string
  sharedByUserId: string | null
  isNew: boolean
}

/**
 * The sidebar toolbar's "Shared" button (T-100): files people in the caller's projects
 * shared with them ON THEIR OWN — the caller cannot see the (private) task a file
 * belongs to, so it is not found anywhere else. A count badge; a popover listing the
 * files by project, each new until opened; a file opens view only, without its task.
 * Renders nothing without login, or while nothing is shared.
 */
export function SharedArtifactsButton({
  layout,
  tooltipSide,
  onOpenArtifact
}: {
  layout: 'vertical' | 'horizontal'
  tooltipSide: 'top' | 'right'
  onOpenArtifact: (artifactId: string) => void
}): React.JSX.Element | null {
  const trpc = useTRPC()
  const { enabled } = useSharingStatus()
  const q = useQuery({ ...trpc.sharing.artifactsSharedWithMe.queryOptions(), enabled })
  const files = q.data ?? []
  const [open, setOpen] = useState(false)
  if (!enabled || files.length === 0) return null
  const anyNew = files.some((f) => f.isNew)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Shared with you"
              data-testid="shared-artifacts-button"
              className={cn(
                'relative inline-flex items-center justify-center rounded-lg transition-colors',
                layout === 'horizontal' ? 'size-10' : 'h-11 w-11',
                'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
              )}
            >
              <Share2 className="size-5" />
              <span
                data-testid="shared-artifacts-count"
                className={cn(
                  'absolute -top-1 -right-1 min-w-4 rounded-full px-1 text-[10px] font-semibold leading-4',
                  anyNew ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
                )}
              >
                {files.length}
              </span>
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side={tooltipSide}>Shared with you</TooltipContent>
      </Tooltip>
      <PopoverContent
        side={tooltipSide}
        align="end"
        sideOffset={12}
        className="w-[300px] p-1.5"
        data-testid="shared-artifacts-popover"
      >
        <SharedArtifactsList
          files={files}
          onOpen={(id) => {
            setOpen(false)
            onOpenArtifact(id)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

function SharedArtifactsList({
  files,
  onOpen
}: {
  files: readonly SharedArtifact[]
  onOpen: (artifactId: string) => void
}): React.JSX.Element {
  const trpc = useTRPC()
  const { nameOf } = useDirectory(true)
  const projects = useQuery(trpc.projects.list.queryOptions())
  const projectOf = new Map((projects.data ?? []).map((p) => [p.id, p]))
  const markOpened = useMutation(trpc.sharing.markArtifactOpened.mutationOptions())
  // Grouped by project, in the order the newest file of each was shared.
  const groups = new Map<string, SharedArtifact[]>()
  for (const f of files) groups.set(f.projectId, [...(groups.get(f.projectId) ?? []), f])
  return (
    <div>
      <p className="px-2 pt-1 pb-1.5 text-sm font-semibold">Shared with you</p>
      {[...groups].map(([projectId, items]) => {
        const project = projectOf.get(projectId)
        return (
          <div key={projectId} data-testid={`shared-artifacts-project-${projectId}`}>
            {groups.size > 1 && (
              <div className="flex items-center gap-1.5 px-2 pt-2 pb-0.5 text-xs text-muted-foreground">
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={project?.color ? { backgroundColor: project.color } : undefined}
                />
                <span className="truncate">{project?.name ?? 'Project'}</span>
              </div>
            )}
            {items.map((f) => (
              <button
                key={f.id}
                type="button"
                data-testid={`shared-artifact-${f.id}`}
                title={`${f.title} · shared by ${nameOf(f.sharedByUserId)} · view only`}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                onClick={() => {
                  if (f.isNew) markOpened.mutate({ artifactId: f.id })
                  onOpen(f.id)
                }}
              >
                <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">
                  {f.title}{' '}
                  <span className="text-muted-foreground">· {nameOf(f.sharedByUserId)}</span>
                </span>
                {f.isNew && (
                  <span
                    className="size-1.5 shrink-0 rounded-full bg-primary"
                    aria-label="New"
                    data-testid="shared-artifact-new"
                  />
                )}
              </button>
            ))}
          </div>
        )
      })}
      <p className="px-2 pt-1.5 pb-1 text-[11px] text-muted-foreground">
        View only. You can’t see the tasks they belong to.
      </p>
    </div>
  )
}
