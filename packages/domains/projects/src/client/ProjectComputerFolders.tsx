import { useState } from 'react'
import { Button } from '@slayzone/ui'
import type { PlacementStatus, Project } from '@slayzone/projects-contracts'
import { WorkspaceDirPicker } from '@slayzone/file-editor/client/WorkspaceDirPicker'
import { useTRPCClient } from './trpc'

const STATUS_LABELS: Partial<Record<PlacementStatus, string>> = {
  missing: 'not found',
  pending: 'waiting for computer'
}

type Computer = { id: string; name: string; disabledAt?: number | null }

/**
 * The project's folder on each computer: choose it, clone the repository into a
 * new one (from a computer that holds the project), or forget it. Each change goes
 * to that computer; the project list refreshes when the hub records it.
 */
export function ProjectComputerFolders({
  project,
  computers
}: {
  project: Project
  computers: Computer[]
}): React.JSX.Element {
  const client = useTRPCClient()
  const placements = (project.placements ?? []).filter((p) => p.status !== 'forgotten')
  const heldElsewhere = (computerId: string) =>
    placements.some((p) => p.computer_id !== computerId && p.status === 'ready')
  const [picking, setPicking] = useState<{ computer: Computer; clone: boolean } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const run = (computerId: string, action: () => Promise<unknown>): void => {
    setBusy(computerId)
    setErrors((all) => {
      const rest = { ...all }
      delete rest[computerId]
      return rest
    })
    void action()
      .catch((err: unknown) =>
        setErrors((all) => ({
          ...all,
          [computerId]: err instanceof Error ? err.message : String(err)
        }))
      )
      .then(() => setBusy(null))
  }

  return (
    <div className="space-y-2">
      {computers.map((computer) => {
        const placement = placements.find((p) => p.computer_id === computer.id)
        const status = placement ? STATUS_LABELS[placement.status] : undefined
        const canClone = placement?.status !== 'ready' && heldElsewhere(computer.id)
        const working = busy === computer.id
        return (
          <div
            key={computer.id}
            data-testid={`computer-folder-${computer.id}`}
            className="rounded-md border border-border p-2 text-sm"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="font-medium">{computer.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {placement ? <span>{placement.path}</span> : 'No folder'}
                  {status && <span className="ml-1.5 text-destructive">{status}</span>}
                </p>
              </div>
              <div className="flex shrink-0 gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={working}
                  onClick={() => setPicking({ computer, clone: false })}
                >
                  Choose…
                </Button>
                {canClone && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={working}
                    onClick={() => setPicking({ computer, clone: true })}
                  >
                    {working ? 'Cloning…' : 'Clone…'}
                  </Button>
                )}
                {placement && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={working}
                    onClick={() =>
                      run(computer.id, () =>
                        client.workspace.forgetProjectPath.mutate({
                          computerId: computer.id,
                          projectId: project.id
                        })
                      )
                    }
                  >
                    Forget
                  </Button>
                )}
              </div>
            </div>
            {errors[computer.id] && (
              <p role="alert" className="mt-1 text-xs text-destructive">
                {errors[computer.id]}
              </p>
            )}
          </div>
        )
      })}
      {picking && (
        <WorkspaceDirPicker
          open
          onOpenChange={(open) => {
            if (!open) setPicking(null)
          }}
          onSelect={(path) => {
            const { computer, clone } = picking
            setPicking(null)
            run(computer.id, () =>
              clone
                ? client.projects.cloneFolder.mutate({
                    id: project.id,
                    computerId: computer.id,
                    path
                  })
                : client.workspace.setProjectPath.mutate({
                    computerId: computer.id,
                    projectId: project.id,
                    path
                  })
            )
          }}
          target={{ computerId: picking.computer.id, projectId: project.id }}
          title={
            picking.clone
              ? `Clone into a folder on ${picking.computer.name}`
              : `Folder on ${picking.computer.name}`
          }
          defaultPath={placements.find((p) => p.computer_id === picking.computer.id)?.path ?? null}
          allowCreate
        />
      )}
    </div>
  )
}
