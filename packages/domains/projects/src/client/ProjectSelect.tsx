import { useEffect, useState } from 'react'
import type { Project } from '@slayzone/projects/shared'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@slayzone/ui'

interface ProjectSelectProps {
  value: string | undefined
  onChange: (value: string) => void
  disabled?: boolean
  projects?: Project[]
}

export function ProjectSelect({
  value,
  onChange,
  disabled,
  projects
}: ProjectSelectProps): React.JSX.Element {
  const [loadedProjects, setLoadedProjects] = useState<Project[]>([])

  useEffect(() => {
    if (projects) return
    window.api.db.getProjects().then(setLoadedProjects)
  }, [projects])

  const options = projects ?? loadedProjects

  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className="w-full">
        <SelectValue placeholder="Select project" />
      </SelectTrigger>
      <SelectContent>
        {[...options]
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
