import { useEffect, useState } from 'react'
import { getTrpcVanillaClient } from '@slayzone/transport/client'
import type { Project } from '@slayzone/projects/shared'
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
  const [projects, setProjects] = useState<Project[]>([])

  useEffect(() => {
    getTrpcVanillaClient().projects.list.query().then(setProjects)
  }, [])

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
