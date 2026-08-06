import { useQuery } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@slayzone/ui'
import type { Project } from '@slayzone/projects/shared'

interface ProjectSelectProps {
  value: string | undefined
  onChange: (value: string) => void
  disabled?: boolean
  /**
   * Projects to offer. Callers inside a federated shell pass the cross-hub union
   * (the ambient `projects.list` only sees ONE hub, so another hub's projects
   * would be missing from the list). Omitted → query the ambient hub as before.
   */
  projects?: Project[]
}

export function ProjectSelect({
  value,
  onChange,
  disabled,
  projects: projectsProp
}: ProjectSelectProps): React.JSX.Element {
  const trpc = useTRPC()
  const query = useQuery(trpc.projects.list.queryOptions(undefined, { enabled: !projectsProp }))
  const projects = projectsProp ?? query.data ?? []

  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className="w-full">
        <SelectValue placeholder="Select project" />
      </SelectTrigger>
      <SelectContent>
        {[...projects]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((project) => (
            <SelectItem key={project.id} value={project.id}>
              <span className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: project.color }} />
                {project.name}
              </span>
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  )
}
