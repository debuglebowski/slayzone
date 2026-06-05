import { useCallback, useEffect, useState } from 'react'
import type { Project } from '@slayzone/projects/shared'

export interface ProjectPathGuardApi {
  projectPathMissing: boolean
  validateProjectPath: (project: Project | undefined) => Promise<void>
  handleFixProjectPath: () => Promise<void>
}

// Validates that the selected project's path still exists on disk — on selection
// change and on window focus (the dir may have moved). Exposes a fixer that
// re-points the project at a new directory.
export function useProjectPathGuard(
  selectedProjectId: string,
  projects: Project[],
  updateProject: (project: Project) => void
): ProjectPathGuardApi {
  const [projectPathMissing, setProjectPathMissing] = useState(false)
  const validateProjectPath = useCallback(async (project: Project | undefined) => {
    if (!project?.path) {
      setProjectPathMissing(false)
      return
    }
    const fn = window.api.files?.pathExists
    if (typeof fn !== 'function') return
    setProjectPathMissing(!(await fn(project.path)))
  }, [])

  useEffect(() => {
    validateProjectPath(projects.find((p) => p.id === selectedProjectId))
  }, [selectedProjectId, projects, validateProjectPath])

  useEffect(() => {
    const project = projects.find((p) => p.id === selectedProjectId)
    if (!project?.path) return
    const handleFocus = (): void => {
      validateProjectPath(project)
    }
    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [selectedProjectId, projects, validateProjectPath])

  const handleFixProjectPath = useCallback(async (): Promise<void> => {
    const project = projects.find((p) => p.id === selectedProjectId)
    if (!project) return
    const result = await window.api.dialog.showOpenDialog({
      title: 'Select Project Directory',
      defaultPath: project.path || undefined,
      properties: ['openDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return
    const updated = await window.api.db.updateProject({ id: project.id, path: result.filePaths[0] })
    updateProject(updated)
    validateProjectPath(updated)
  }, [selectedProjectId, projects, updateProject, validateProjectPath])

  return { projectPathMissing, validateProjectPath, handleFixProjectPath }
}
