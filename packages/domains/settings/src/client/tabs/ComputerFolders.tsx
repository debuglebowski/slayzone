import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@slayzone/ui'
import { placementOn, type Project } from '@slayzone/projects-contracts'
import { ProjectFolderRow, RelocateProjectDialog, useProjectFolderEditor } from '@slayzone/projects'
import { useTRPC, useTRPCClient } from '../trpc'
import { ComputerAllowedFolders } from './ComputerRootsDialog'

/**
 * One computer's folders: what it may touch at all (its allowed folders), and where
 * it keeps each project of its hub. Must render inside the hub's scope.
 */
export function ComputerFolders({
  computer
}: {
  computer: { id: string; name: string; disabledAt?: number | null }
}) {
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const queryClient = useQueryClient()
  const projectsQuery = useQuery(trpc.projects.list.queryOptions())
  const setDefault = useMutation(trpc.computers.setProjectDefaultComputer.mutationOptions())
  const folders = useProjectFolderEditor()
  const [relocating, setRelocating] = useState<Project | null>(null)

  // Projects with a folder here first; the list's own order within each group.
  const projects = [...(projectsQuery.data ?? [])].sort(
    (a, b) => Number(!!placementOn(b, computer.id)) - Number(!!placementOn(a, computer.id))
  )
  const refreshProjects = () => queryClient.invalidateQueries(trpc.projects.list.queryFilter())

  return (
    <div className="space-y-8" data-testid="computer-folders">
      <section className="space-y-3">
        <div className="space-y-1">
          <h3 className="text-base font-semibold">Allowed folders</h3>
          <p className="text-sm text-muted-foreground">
            Directories {computer.name} may read, write, and run commands in. A project folder
            outside every entry cannot be browsed or opened here.
          </p>
        </div>
        <ComputerAllowedFolders
          target={{
            id: computer.id,
            name: computer.name,
            load: () => trpcClient.workspace.listRoots.query({ computerId: computer.id }),
            save: (roots) =>
              trpcClient.workspace.setAllowedRoots.mutate({ computerId: computer.id, roots })
          }}
        />
      </section>

      <section className="space-y-3">
        <div className="space-y-1">
          <h3 className="text-base font-semibold">Project folders</h3>
          <p className="text-sm text-muted-foreground">
            Where {computer.name} keeps each project. A project's agents start in its folder on the
            computer that runs them.
          </p>
        </div>
        {projectsQuery.isPending ? null : projects.length === 0 ? (
          <p className="text-sm text-muted-foreground">No projects on this hub.</p>
        ) : (
          <div className="divide-y rounded-lg border">
            {projects.map((project) => {
              const isDefault = project.resolved_computer_id === computer.id
              return (
                <ProjectFolderRow
                  key={project.id}
                  testId={`computer-project-${project.id}`}
                  name={
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden="true"
                        className="size-2.5 shrink-0 rounded-sm"
                        style={{ backgroundColor: project.color }}
                      />
                      {project.name}
                    </span>
                  }
                  badges={
                    isDefault ? (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        Default
                      </span>
                    ) : null
                  }
                  placement={placementOn(project, computer.id)}
                  browse={{ computerId: computer.id, projectId: project.id }}
                  onSetFolder={(path) => folders.setFolder(project, computer.id, path)}
                  onForget={() => folders.forgetFolder(project, computer.id)}
                  onRelocate={() => setRelocating(project)}
                  actions={
                    // A DISABLED computer takes no new work: nothing new is bound to it.
                    !isDefault && computer.disabledAt == null ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={setDefault.isPending}
                        title={`Run ${project.name}'s tasks on ${computer.name} by default`}
                        onClick={() =>
                          void setDefault
                            .mutateAsync({ projectId: project.id, computerId: computer.id })
                            .then(refreshProjects)
                        }
                        data-testid={`computer-project-${project.id}-make-default`}
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
      </section>

      {relocating && (
        <RelocateProjectDialog
          project={relocating}
          computerId={computer.id}
          onClose={() => setRelocating(null)}
          onUpdated={() => void refreshProjects()}
        />
      )}
    </div>
  )
}
