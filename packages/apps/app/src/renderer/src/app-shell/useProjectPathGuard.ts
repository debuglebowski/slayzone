import { useCallback, useEffect, useState } from 'react'
import { useTRPCClient } from '../trpc'
import { placementOn, type Project, type ProjectPlacement } from '@slayzone/projects-contracts'

export interface ProjectPathGuardApi {
  /**
   * Drives the Home "project path missing" UI: the latest check's answer, whichever
   * project it was for. While a newly selected project's check is in flight it still
   * shows the previous answer.
   */
  projectPathMissing: boolean
  /**
   * The folder is there but its computer will not use it: outside that computer's
   * allowed folders. Set together with `projectPathMissing` (the UI is blocked
   * either way) so the message can say which.
   */
  projectPathRefused: boolean
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
  refused: boolean
}

const NOT_CHECKED: PathCheck = { projectId: null, path: null, missing: false, refused: false }

/**
 * The project's folder on the computer its work runs on (`resolved_computer_id`).
 * A project has one folder per computer; project-wide views use that one.
 */
function folderOf(project: Project | undefined): ProjectPlacement | null {
  return placementOn(project, project?.resolved_computer_id)
}

/**
 * The answer known without asking the computer: no folder at all (nothing to
 * check), or one the computer already turned down (`missing` / `refused`).
 * Null = a usable folder, which is probed.
 */
function knownCheck(project: Project | undefined): PathCheck | null {
  const folder = folderOf(project)
  const projectId = project?.id ?? null
  if (!folder) return { projectId, path: null, missing: false, refused: false }
  if (folder.status === 'missing')
    return { projectId, path: folder.path, missing: true, refused: false }
  if (folder.status === 'refused')
    return { projectId, path: folder.path, missing: true, refused: true }
  return null
}

/**
 * State update to `next` that keeps the current object when it already holds the same
 * answer, so a repeated identical answer (every window-focus re-probe) is a same-value
 * update React bails out of instead of re-rendering the host (App).
 */
function toCheck(next: PathCheck): (prev: PathCheck) => PathCheck {
  return (prev) =>
    prev.projectId === next.projectId &&
    prev.path === next.path &&
    prev.missing === next.missing &&
    prev.refused === next.refused
      ? prev
      : next
}

// Validates that the selected project's folder still exists — on selection change
// and on window focus (the dir may have moved). Exposes a fixer that re-points
// the project at a new directory.
//
// The folder is the one on the project's computer (`resolved_computer_id`), and the
// probe goes through `workspace.pathExists`, which runs on that computer, not on
// whichever hub the client happens to be talking to.
//
// `reachable: false` (computer offline) is deliberately NOT "missing": we could not
// ask, which is a different thing to tell the user than "your path is gone".
export function useProjectPathGuard(
  selectedProjectId: string,
  projects: Project[],
  updateProject: (project: Project) => void
): ProjectPathGuardApi {
  const trpcClient = useTRPCClient()
  // A folder the computer already turned down is known from the first render.
  const [check, setCheck] = useState<PathCheck>(
    () => knownCheck(projects.find((p) => p.id === selectedProjectId)) ?? NOT_CHECKED
  )

  const probe = useCallback(
    (projectId: string, path: string): Promise<void> =>
      trpcClient.workspace.pathExists.query({ projectId, path }).then((res) => {
        setCheck(
          toCheck({ projectId, path, missing: res.reachable && !res.exists, refused: false })
        )
      }),
    [trpcClient]
  )

  const validateProjectPath = useCallback(
    async (project: Project | undefined) => {
      const known = knownCheck(project)
      if (known) {
        setCheck(toCheck(known))
        return
      }
      return probe(project!.id, folderOf(project)!.path)
    },
    [probe]
  )

  const selectedProject = projects.find((p) => p.id === selectedProjectId)
  const selectedFolder = folderOf(selectedProject)

  // Re-check on every selection or projects change. A usable folder is probed from
  // the effect below; anything else is answered right here while rendering, at
  // those same moments (React's "adjust state on a prop change" pattern).
  const [checkedFor, setCheckedFor] = useState({ selectedProjectId, projects })
  if (checkedFor.selectedProjectId !== selectedProjectId || checkedFor.projects !== projects) {
    setCheckedFor({ selectedProjectId, projects })
    const known = knownCheck(selectedProject)
    if (known) setCheck(toCheck(known))
  }

  useEffect(() => {
    const project = projects.find((p) => p.id === selectedProjectId)
    if (knownCheck(project)) return
    void probe(project!.id, folderOf(project)!.path)
  }, [selectedProjectId, projects, probe])

  useEffect(() => {
    const project = projects.find((p) => p.id === selectedProjectId)
    if (knownCheck(project)) return
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
      // Recorded on the project's computer (the hub routes a path update there).
      const updated = await trpcClient.projects.update.mutate({ id: project.id, path })
      updateProject(updated)
      validateProjectPath(updated)
    },
    [selectedProjectId, projects, updateProject, validateProjectPath, trpcClient]
  )

  // Only an answer about the selected project AND its current folder counts as the
  // selected project's: right after a switch (or a folder change) the latest answer
  // is still the previous one's until the new probe resolves.
  const selectedProjectPathMissing = !selectedFolder
    ? false
    : check.projectId === selectedProject?.id && check.path === selectedFolder.path
      ? check.missing
      : null

  return {
    projectPathMissing: check.missing,
    projectPathRefused: check.refused,
    selectedProjectPathMissing,
    validateProjectPath,
    handleFixProjectPath,
    fixPickerOpen,
    setFixPickerOpen,
    applyFixedPath
  }
}
