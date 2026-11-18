import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle } from '@slayzone/ui'
import { useTRPC } from '../trpc'
import { PeoplePicker, RoleSelect } from './PeoplePicker'
import { toastError, useDirectory, type AccessRole } from './useSharing'

const ROLES: readonly AccessRole[] = ['view', 'edit']

/**
 * Share one file with people (T-100): view or edit, nothing else of its task. A file
 * held by a computer moves to the hub first (it must be connected), so the people it
 * is shared with reach it whether or not that computer is on.
 */
export function ArtifactShareDialog({
  artifactId,
  title,
  open,
  onOpenChange,
  onMoved
}: {
  artifactId: string
  title: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The file moved to the hub under a new id (it was on a computer). */
  onMoved?: (newId: string) => void
}): React.JSX.Element {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const { users, nameOf } = useDirectory(open)
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
          People you add see this file only — not the rest of its task.
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
        <PeoplePicker
          people={users}
          exclude={new Set(grants.map((g) => g.userId))}
          roles={ROLES}
          testId="artifact-grant-picker"
          onAdd={(userId, role) =>
            setGrant
              .mutateAsync({ artifactId, userId, role: role as 'view' | 'edit' })
              .catch(() => undefined)
          }
        />
      </DialogContent>
    </Dialog>
  )
}
