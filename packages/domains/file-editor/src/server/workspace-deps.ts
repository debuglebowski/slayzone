// The workspace filesystem registry. Owned here: its adapters are this domain's
// (`workspace-fs.ts`), and so are the routers serving them (`fileEditor`, `workspace`).
// Composition roots wire it (`setWorkspaceDeps`); the `worktrees` router reads it
// through its own seam, which api wires (`api/src/domain-router-deps.ts`).
import { createLocalWorkspaceFsAdapters, type WorkspaceFsAdapters } from './workspace-fs'

/**
 * The workspace filesystem seam.
 *
 * Every fs op the UI runs against a workspace must execute on the machine that
 * owns it — a computer, which may be another host. Serving these from the hub is
 * what made a remote task report "No repository path configured" for a path that
 * existed: the hub was answering about its own disk.
 *
 * `resolveComputer` deliberately mirrors the pty backend's resolution rather than
 * reading `tasks.computer_id` directly, so the directory picker browses exactly the
 * filesystem the agent will get. Precedence: an explicit `computerId` the user
 * chose → the task's binding → the project default → the connected default.
 *
 * Default: in-process adapters and a null resolver — correct for hosts with no
 * computer gateway (the standalone/fork sidecar, tests), where the hub's disk is
 * the only disk there is. The hub composition replaces both when it wires the
 * computer gateway.
 */
export type WorkspaceComputerTarget = {
  /** A computer the caller already chose. Wins over every other field. */
  computerId?: string | null
  taskId?: string
  projectId?: string
}

export type WorkspaceDeps = {
  fs: WorkspaceFsAdapters
  resolveComputer: (target: WorkspaceComputerTarget) => Promise<string | null>
  /**
   * Is this computer the desktop's own co-resident child?
   *
   * Only the desktop-local case can meaningfully "reveal in Finder" or hand a
   * path to a local editor — there is no file manager on a headless computer, and
   * revealing a folder on a machine the user is not sitting at is not the action
   * they asked for. Defaults to true: a host with no computer gateway is by
   * definition working on its own disk.
   */
  isLocalComputer: (computerId: string | null) => boolean
}

let workspaceDeps: WorkspaceDeps = {
  fs: createLocalWorkspaceFsAdapters(),
  resolveComputer: async () => null,
  isLocalComputer: () => true
}

export function setWorkspaceDeps(deps: WorkspaceDeps): void {
  workspaceDeps = deps
}

export function getWorkspaceDeps(): WorkspaceDeps {
  return workspaceDeps
}
