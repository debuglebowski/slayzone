import { useCallback, useEffect, useState } from 'react'
import { useTRPCClient } from '@slayzone/transport/client'
import type { Project } from '@slayzone/projects-contracts'

export interface ProjectPathGuardApi {
  /**
   * Drives the Home "project path missing" UI: the latest check's answer, whichever
   * project it was for. While a newly selected project's check is in flight it still
   * shows the previous answer.
   */
  projectPathMissing: boolean
  /**
   * The SELECTED project's own answer, for diagnostics: `null` until a check of its
   * current path has answered. Never another project's answer.
   */
  selectedProjectPathMissing: boolean | null
  validateProjectPath: (project: Project | undefined) => Promise<void>
  /** Opens the directory picker. The shell renders it; see the note below. */
  handleFixProjectPath: () => Promise<void>
  fixPickerOpen: boolean
  setFixPickerOpen: (open: boolean) => void
  /** Persist a path chosen in the picker and re-validate. */
  applyFixedPath: (path: string) => Promise<void>
}

/** The latest check's answer, and the project + path it answers for. */
interface PathCheck {
  projectId: string | null
  path: string | null
  missing: boolean
}

const NOT_CHECKED: PathCheck = { projectId: null, path: null, missing: false }

/** A project with no path has nothing to probe: its answer is known without one. */
function noPathCheck(project: Project | undefined): PathCheck {
  return { projectId: project?.id ?? null, path: null, missing: false }
}

/**
 * State update to `next` that keeps the current object when it already holds the same
 * answer, so a repeated identical answer (every window-focus re-probe) is a same-value
 * update React bails out of instead of re-rendering the host (App).
 */
function toCheck(next: PathCheck): (prev: PathCheck) => PathCheck {
  return (prev) =>
    prev.projectId === next.projectId && prev.path === next.path && prev.missing === next.missing
      ? prev
      : next
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
  const [check, setCheck] = useState<PathCheck>(NOT_CHECKED)

  const probe = useCallback(
    (projectId: string, path: string): Promise<void> =>
      trpcClient.workspace.pathExists.query({ projectId, path }).then((res) => {
        setCheck(toCheck({ projectId, path, missing: res.reachable && !res.exists }))
      }),
    [trpcClient]
  )

  const validateProjectPath = useCallback(
    async (project: Project | undefined) => {
      if (!project?.path) {
        setCheck(toCheck(noPathCheck(project)))
        return
      }
      return probe(project.id, project.path)
    },
    [probe]
  )

  const selectedProject = projects.find((p) => p.id === selectedProjectId)

  // Re-check on every selection or projects change. A path is probed from the effect
  // below; a project without one is answered right here while rendering, at those
  // same moments (React's "adjust state on a prop change" pattern).
  const [checkedFor, setCheckedFor] = useState({ selectedProjectId, projects })
  if (checkedFor.selectedProjectId !== selectedProjectId || checkedFor.projects !== projects) {
    setCheckedFor({ selectedProjectId, projects })
    if (!selectedProject?.path) setCheck(toCheck(noPathCheck(selectedProject)))
  }

  useEffect(() => {
    const project = projects.find((p) => p.id === selectedProjectId)
    if (!project?.path) return
    void probe(project.id, project.path)
  }, [selectedProjectId, projects, probe])

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

  // Only an answer about the selected project AND its current path counts as the
  // selected project's: right after a switch (or a path change) the latest answer is
  // still the previous one's until the new probe resolves.
  const selectedProjectPathMissing = !selectedProject?.path
    ? false
    : check.projectId === selectedProject.id && check.path === selectedProject.path
      ? check.missing
      : null

  return {
    projectPathMissing: check.missing,
    selectedProjectPathMissing,
    validateProjectPath,
    handleFixProjectPath,
    fixPickerOpen,
    setFixPickerOpen,
    applyFixedPath
  }
}
