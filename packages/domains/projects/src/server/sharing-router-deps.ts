// What the `sharing` router needs from its host, injected so this domain never imports
// `@slayzone/api`: the access decision (`access.ts`) is api's, and copying a
// computer-held artifact to the hub is the hub's (`computer-artifacts.ts`). api wires
// the first at load (`api/src/domain-router-deps.ts`), the hub the rest.
import type { TrpcContext } from '@slayzone/trpc-server'
import type { AccessRole } from './project-access'

export type SharingRouterDeps = {
  /** The caller's role on a resource (null: none, or it does not exist). */
  roleOf: (
    ctx: TrpcContext,
    resource: { kind: 'project' | 'task' | 'artifact'; id: string }
  ) => Promise<AccessRole | null>
  /** Who-may-see-what changed: every live access decision is made again. */
  invalidate: () => void
  /** These tasks' visibility changed: subscribed boards refetch them. */
  tasksChanged: (taskIds: readonly string[]) => void
  /**
   * A task became reachable by someone besides its owner: its artifacts held by a
   * computer move to the hub (a shared artifact always lives there).
   */
  onTaskShared: (taskId: string) => Promise<void>
  /** Copy one computer-held artifact (every version) to the hub; a hub one: no-op. */
  promoteArtifact: (artifactId: string) => Promise<void>
}

// Unwired (a unit harness, a hub without login): nobody but the owner, nothing to move.
let deps: SharingRouterDeps = {
  roleOf: async () => null,
  invalidate: () => {},
  tasksChanged: () => {},
  onTaskShared: async () => {},
  promoteArtifact: async () => {}
}

export function setSharingRouterDeps(next: Partial<SharingRouterDeps>): void {
  deps = { ...deps, ...next }
}

export function getSharingRouterDeps(): SharingRouterDeps {
  return deps
}
