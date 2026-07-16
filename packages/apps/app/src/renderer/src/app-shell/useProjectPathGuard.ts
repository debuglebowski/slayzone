import { useCallback, useEffect, useState } from 'react'
import { useTRPCClient } from '@slayzone/transport/client'
import type { Project } from '@slayzone/projects/shared'

export interface ProjectPathGuardApi {
  projectPathMissing: boolean
  validateProjectPath: (project: Project | undefined) => Promise<void>
  handleFixProjectPath: () => Promise<void>
}

// Validates that the selected project's path still exists on disk — on selection
// change and on window focus (the dir may have moved). Exposes a fixer that
// re-points the project at a new directory.
//
// `enabled` gates the disk check: a project living on a REMOTE hub has its files
// on that hub's host, not the client's default-hub filesystem, so probing
// `app.files.pathExists` (which hits the default hub) would be meaningless.
// Multi-hub passes `false` for remote projects; single-hub always `true` →
// byte-identical.
export function useProjectPathGuard(
  selectedProjectId: string,
  projects: Project[],
  updateProject: (project: Project) => void,
  enabled = true
): ProjectPathGuardApi {
  const trpcClient = useTRPCClient()
  const [projectPathMissing, setProjectPathMissing] = useState(false)
  const validateProjectPath = useCallback(
    async (project: Project | undefined) => {
      if (!enabled || !project?.path) {
        setProjectPathMissing(false)
        return
      }
      const exists = await trpcClient.app.files.pathExists.query({ filePath: project.path })
      setProjectPathMissing(!exists)
    },
    [trpcClient, enabled]
  )

  useEffect(() => {
    validateProjectPath(projects.find((p) => p.id === selectedProjectId))
  }, [selectedProjectId, projects, validateProjectPath])

  useEffect(() => {
    if (!enabled) return
    const project = projects.find((p) => p.id === selectedProjectId)
    if (!project?.path) return
    const handleFocus = (): void => {
      validateProjectPath(project)
    }
    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [selectedProjectId, projects, validateProjectPath, enabled])

  const handleFixProjectPath = useCallback(async (): Promise<void> => {
    const project = projects.find((p) => p.id === selectedProjectId)
    if (!project) return
    const result = await trpcClient.app.dialog.showOpenDialog.mutate({
      title: 'Select Project Directory',
      defaultPath: project.path || undefined,
      properties: ['openDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return
    const updated = await trpcClient.projects.update.mutate({
      id: project.id,
      path: result.filePaths[0]
    })
    updateProject(updated)
    validateProjectPath(updated)
  }, [selectedProjectId, projects, updateProject, validateProjectPath, trpcClient])

  return { projectPathMissing, validateProjectPath, handleFixProjectPath }
}
