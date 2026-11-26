import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, Plus } from 'lucide-react'
import { Button, Input } from '@slayzone/ui'
import { computerName } from '@slayzone/computers/labels'
import { defaultProjectRoot } from '@slayzone/projects-contracts'
import { openCreateProject } from '@slayzone/projects'
import { useTRPC } from '../trpc'
import { useSettingsViewStore } from '../settings-view-store'

/** Above this many projects a filter is worth its space. */
const FILTER_FROM = 8

/**
 * Every project on one hub, each opening its settings, and the way to make a new
 * one there. Rendered inside the hub's scope, so the list is that hub's; `hubId` is
 * where the Create Project dialog opens.
 */
export function HubProjectsTab({ hubId }: { hubId: string | null }) {
  const trpc = useTRPC()
  const navigate = useSettingsViewStore((s) => s.navigate)
  const projectsQuery = useQuery(trpc.projects.list.queryOptions())
  const computersQuery = useQuery(trpc.computers.list.queryOptions())
  const [filter, setFilter] = useState('')

  const all = projectsQuery.data ?? []
  const computers = computersQuery.data ?? []
  // Which computer runs a project only says something when there is more than one.
  const showComputer = computers.length > 1
  const needle = filter.trim().toLowerCase()
  const projects = needle ? all.filter((p) => p.name.toLowerCase().includes(needle)) : all

  return (
    <div className="space-y-4" data-testid="hub-projects-tab">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-base font-semibold">Projects</h3>
          <p className="text-sm text-muted-foreground">
            {projectsQuery.isPending
              ? 'Every project on this hub.'
              : `${all.length} ${all.length === 1 ? 'project' : 'projects'} on this hub.`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {all.length >= FILTER_FROM && (
            <Input
              className="h-8 w-48"
              placeholder="Filter projects"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              data-testid="hub-projects-filter"
            />
          )}
          <Button size="sm" onClick={() => openCreateProject(hubId)} data-testid="hub-projects-new">
            <Plus className="size-3.5" />
            New project
          </Button>
        </div>
      </div>

      {projectsQuery.isPending ? null : all.length === 0 ? (
        <div
          className="space-y-3 rounded-lg border border-dashed p-8 text-center"
          data-testid="hub-projects-empty"
        >
          <p className="text-sm text-muted-foreground">No projects on this hub yet.</p>
          <Button size="sm" variant="outline" onClick={() => openCreateProject(hubId)}>
            <Plus className="size-3.5" />
            Create the first one
          </Button>
        </div>
      ) : projects.length === 0 ? (
        <p className="text-sm text-muted-foreground">No project matches “{filter.trim()}”.</p>
      ) : (
        <div className="divide-y rounded-lg border">
          {projects.map((project) => {
            const folder = defaultProjectRoot(project)
            return (
              <button
                key={project.id}
                type="button"
                className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50"
                onClick={() => navigate({ kind: 'project', projectId: project.id, tab: 'general' })}
                data-testid="hub-projects-row"
                data-project-id={project.id}
              >
                <span
                  aria-hidden
                  className="grid size-7 shrink-0 place-items-center rounded-md text-[10px] font-bold text-background"
                  style={{ backgroundColor: project.color }}
                >
                  {(project.icon_letters || project.name).slice(0, 2).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1 space-y-0.5">
                  <span className="block truncate text-sm font-medium">{project.name}</span>
                  <span
                    className="block truncate font-mono text-xs text-muted-foreground"
                    title={folder ?? undefined}
                  >
                    {folder ?? 'No folder'}
                  </span>
                </span>
                {showComputer && (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {computerName(computers, project.resolved_computer_id)}
                  </span>
                )}
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </button>
            )
          })}
        </div>
      )}

      {all.length > 0 && (
        <button
          type="button"
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => navigate({ kind: 'projects' })}
          data-testid="hub-projects-compare"
        >
          Compare agent settings across all projects
          <ChevronRight className="size-3.5" />
        </button>
      )}
    </div>
  )
}
