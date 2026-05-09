import { useQuery } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@slayzone/ui'

interface ProjectSelectProps {
  value: string | undefined
  onChange: (value: string) => void
  disabled?: boolean
}

export function ProjectSelect({
  value,
  onChange,
  disabled
}: ProjectSelectProps): React.JSX.Element {
  const trpc = useTRPC()
  const projectsQuery = useQuery(trpc.projects.list.queryOptions())
  const projects = projectsQuery.data ?? []

  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className="w-full">
        <SelectValue placeholder="Select project" />
      </SelectTrigger>
      <SelectContent>
        {[...projects].sort((a, b) => a.name.localeCompare(b.name)).map((project) => (
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
