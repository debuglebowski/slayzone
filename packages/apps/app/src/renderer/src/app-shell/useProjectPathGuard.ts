import { useCallback, useEffect, useState } from 'react'
import { useTRPCClient } from '@slayzone/transport/client'
import type { Project } from '@slayzone/projects/shared'

export interface ProjectPathGuardApi {
  projectPathMissing: boolean
  validateProjectPath: (project: Project | undefined) => Promise<void>
  /** Opens the directory picker. The shell renders it; see the note below. */
  handleFixProjectPath: () => Promise<void>
  fixPickerOpen: boolean
  setFixPickerOpen: (open: boolean) => void
  /** Persist a path chosen in the picker and re-validate. */
  applyFixedPath: (path: string) => Promise<void>
}

// Validates that the selected project's path still exists — on selection change
// and on window focus (the dir may have moved). Exposes a fixer that re-points
// the project at a new directory.
//
// The probe goes through `workspace.pathExists`, which runs on the machine that
// owns the project's files (its computer), not on whichever hub the client happens
// to be talking to. The old `app.files.pathExists` always answered about the
// hub's own disk, so a project on a computer was reported missing whenever the two
// were different machines — the `enabled` gate existed only to suppress that
// wrong answer, and is gone now that the answer is right.
//
// `reachable: false` (computer offline) is deliberately NOT "missing": we could not
// ask, which is a different thing to tell the user than "your path is gone".
export function useProjectPathGuard(
  selectedProjectId: string,
  projects: Project[],
  updateProject: (project: Project) => void
): ProjectPathGuardApi {
  const trpcClient = useTRPCClient()
  const [projectPathMissing, setProjectPathMissing] = useState(false)
  const validateProjectPath = useCallback(
    async (project: Project | undefined) => {
      if (!project?.path) {
        setProjectPathMissing(false)
        return
      }
      const res = await trpcClient.workspace.pathExists.query({
        projectId: project.id,
        path: project.path
      })
      setProjectPathMissing(res.reachable && !res.exists)
    },
    [trpcClient]
  )

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

  // Picking is a dialog, and a hook cannot render one — so the hook owns the
  // open flag and the apply step, and the shell renders `<WorkspaceDirPicker>`
  // against them. It used to call the native dialog straight from here, which is
  // exactly the bug: that dialog browses the DESKTOP, and the path it returned
  // need not exist on the computer that owns the project.
  const [fixPickerOpen, setFixPickerOpen] = useState(false)
  const handleFixProjectPath = useCallback(async (): Promise<void> => {
    setFixPickerOpen(true)
  }, [])

  const applyFixedPath = useCallback(
    async (path: string): Promise<void> => {
      const project = projects.find((p) => p.id === selectedProjectId)
      if (!project) return
      const updated = await trpcClient.projects.update.mutate({ id: project.id, path })
      updateProject(updated)
      validateProjectPath(updated)
    },
    [selectedProjectId, projects, updateProject, validateProjectPath, trpcClient]
  )

  return {
    projectPathMissing,
    validateProjectPath,
    handleFixProjectPath,
    fixPickerOpen,
    setFixPickerOpen,
    applyFixedPath
  }
}
