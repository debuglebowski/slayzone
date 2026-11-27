import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@slayzone/ui'
import { DISABLED_MARK, OFFLINE_MARK } from '@slayzone/computers/labels'
import { placementOn, type Project } from '@slayzone/projects-contracts'
import { useTRPC } from './trpc'
import { SettingsTabIntro } from './project-settings-shared'
import { ProjectFolderRow, useProjectFolderEditor } from './ProjectFolderRow'
import { RelocateProjectDialog } from './RelocateProjectDialog'

/**
 * Whether the project's hub has more than one computer — the only case where a
 * project's folder can differ by machine, so the only one the Computers tab is
 * offered in. A hub with one computer keeps its folder on the General tab alone.
 */
export function useHubHasManyComputers(): boolean {
  const trpc = useTRPC()
  const computers = useQuery(trpc.computers.list.queryOptions())
  return (computers.data?.length ?? 0) > 1
}

/**
 * A project's folder on every computer of its hub: set, change, relocate or forget
 * each one, and pick the computer its tasks run on by default.
 */
export function ComputersTab({
  project,
  onChanged
}: {
  project: Project
  onChanged: (project: Project) => void
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const computersQuery = useQuery(trpc.computers.list.queryOptions())
  const setDefault = useMutation(trpc.computers.setProjectDefaultComputer.mutationOptions())
  const folders = useProjectFolderEditor()
  const [relocateOn, setRelocateOn] = useState<string | null>(null)

  const resolved = project.resolved_computer_id
  // The computer its tasks run on first, then by name: the row that matters most leads.
  const computers = [...(computersQuery.data ?? [])].sort(
    (a, b) => Number(b.id === resolved) - Number(a.id === resolved) || a.name.localeCompare(b.name)
  )

  const makeDefault = async (computerId: string): Promise<void> => {
    await setDefault.mutateAsync({ projectId: project.id, computerId })
    void queryClient.invalidateQueries(trpc.projects.list.queryFilter())
    onChanged({ ...project, default_computer_id: computerId, resolved_computer_id: computerId })
  }

  return (
    <div className="space-y-6" data-testid="project-computers-tab">
      <SettingsTabIntro
        title="Computers"
        description="Where this project's folder is on each computer. Agents start in that folder on whichever computer runs them."
      />
      {computersQuery.isPending ? null : computers.length === 0 ? (
        <p className="text-sm text-muted-foreground">No computers on this hub.</p>
      ) : (
        <div className="divide-y rounded-lg border">
          {computers.map((computer) => {
            const disabled = computer.disabledAt != null
            const isDefault = computer.id === resolved
            return (
              <ProjectFolderRow
                key={computer.id}
                testId={`project-computer-${computer.id}`}
                name={computer.name}
                badges={
                  <>
                    {isDefault && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        Default
                      </span>
                    )}
                    {disabled ? (
                      <span className="text-xs text-muted-foreground">{DISABLED_MARK}</span>
                    ) : computer.usable === false ? (
                      <span className="text-xs text-muted-foreground">{OFFLINE_MARK}</span>
                    ) : null}
                  </>
                }
                placement={placementOn(project, computer.id)}
                browse={{ computerId: computer.id, projectId: project.id }}
                onSetFolder={async (path) =>
                  onChanged(await folders.setFolder(project, computer.id, path))
                }
                onForget={async () => onChanged(await folders.forgetFolder(project, computer.id))}
                onRelocate={() => setRelocateOn(computer.id)}
                actions={
                  // A DISABLED computer takes no new work, so nothing new may be bound
                  // to it (the hub refuses). Offline is fine: work waits for it.
                  !isDefault && !disabled ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={setDefault.isPending}
                      onClick={() => void makeDefault(computer.id)}
                      data-testid={`project-computer-${computer.id}-make-default`}
                    >
                      Make default
                    </Button>
                  ) : null
                }
              />
            )
          })}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        The default computer runs this project's tasks unless a task picks another.
      </p>
      {relocateOn && (
        <RelocateProjectDialog
          project={project}
          computerId={relocateOn}
          onClose={() => setRelocateOn(null)}
          onUpdated={onChanged}
        />
      )}
    </div>
  )
}
