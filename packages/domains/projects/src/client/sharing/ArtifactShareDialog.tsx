import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle } from '@slayzone/ui'
import { useTRPC } from '../trpc'
import { PeoplePicker, RoleSelect } from './PeoplePicker'
import { toastError, useDirectory, useProjectPeople, type AccessRole } from './useSharing'

const ROLES: readonly AccessRole[] = ['view', 'edit']

/**
 * Share one file with people in its project (T-100): view or edit. Someone not invited
 * to its private task gets this file only — never the task; they find it under Shared
 * in the sidebar. Nobody outside the project can be added (the hub refuses them). A
 * file held by a computer moves to the hub first (it must be connected), so the people
 * it is shared with reach it whether or not that computer is on.
 */
export function ArtifactShareDialog({
  artifactId,
  projectId,
  title,
  open,
  onOpenChange,
  onMoved
}: {
  artifactId: string
  /** The project of the file's task: whose people it can be shared with. */
  projectId: string
  title: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The file moved to the hub under a new id (it was on a computer). */
  onMoved?: (newId: string) => void
}): React.JSX.Element {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { nameOf } = useDirectory(open)
  const { people, loading } = useProjectPeople(projectId, open)
  const grantsQuery = useQuery({
    ...trpc.sharing.artifactGrants.queryOptions({ artifactId }),
    enabled: open
  })
  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.sharing.pathKey() })
  const setGrant = useMutation(
    trpc.sharing.setArtifactGrant.mutationOptions({
      onSuccess: (r) => {
        if (r.artifactId !== artifactId) onMoved?.(r.artifactId)
        void refresh()
      },
      onError: toastError
    })
  )
  const removeGrant = useMutation(
    trpc.sharing.removeArtifactGrant.mutationOptions({ onSuccess: refresh, onError: toastError })
  )
  const grants = grantsQuery.data ?? []
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="artifact-share-dialog">
        <DialogHeader>
          <DialogTitle>Share “{title}”</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          Only people in the project can be added. Someone who can’t see the task gets this file
          only.
        </p>
        <ul className="space-y-1">
          {grants.map((g) => (
            <li key={g.userId} className="flex items-center justify-between gap-1">
              <span className="min-w-0 truncate text-sm">{nameOf(g.userId)}</span>
              <div className="flex items-center gap-1">
                <RoleSelect
                  value={g.role}
                  roles={ROLES}
                  onChange={(role) =>
                    setGrant.mutate({ artifactId, userId: g.userId, role: role as 'view' | 'edit' })
                  }
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${nameOf(g.userId)}`}
                  onClick={() => removeGrant.mutate({ artifactId, userId: g.userId })}
                >
                  <X className="size-4" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
        {loading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : (
          <PeoplePicker
            people={people}
            exclude={new Set(grants.map((g) => g.userId))}
            roles={ROLES}
            testId="artifact-grant-picker"
            emptyText="Everyone in the project is already in. Add more people to the project in Project Settings → Members."
            onAdd={(userId, role) =>
              setGrant
                .mutateAsync({ artifactId, userId, role: role as 'view' | 'edit' })
                .catch(() => undefined)
            }
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
