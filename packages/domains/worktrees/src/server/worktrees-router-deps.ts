// What the `worktrees` router needs from its host, injected so this domain never
// imports `@slayzone/api`. Both registries it reads are api's and shared with routers
// still in api (the workspace fs seam with `workspace`/`fileEditor`, `AppDeps` with
// most of them), so api wires this seam at load and each member reads its registry
// live on every call (`api/src/domain-router-deps.ts`).
import type { WorkspaceFsAdapters } from '@slayzone/file-editor/server'

/** Which machine a workspace path belongs to, as a pty spawn resolves it. */
export type WorktreesComputerTarget = {
  computerId?: string | null
  taskId?: string
  projectId?: string
}

export type WorktreesRouterDeps = {
  /** The workspace filesystem seam: fs adapters + the computer owning a target. */
  getWorkspace: () => {
    fs: WorkspaceFsAdapters
    resolveComputer: (target: WorktreesComputerTarget) => Promise<string | null>
  }
  /** Electron shell op (host-only), over the capability bridge. */
  shellOpenPath: (absPath: string) => Promise<string>
}

let deps: WorktreesRouterDeps | null = null

export function setWorktreesRouterDeps(next: WorktreesRouterDeps): void {
  deps = next
}

export function getWorktreesRouterDeps(): WorktreesRouterDeps {
  if (!deps)
    throw new Error(
      'worktrees router deps not initialized — @slayzone/api wires them when it composes the router'
    )
  return deps
}
