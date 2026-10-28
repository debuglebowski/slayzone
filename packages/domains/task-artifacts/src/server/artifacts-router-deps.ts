// What the `artifacts` router needs from its host, injected so this domain never
// imports `@slayzone/api`. The download procedures' host-only steps (save sheet,
// directory picker, downloads dir, reveal, offscreen PDF/PNG render) come from api's
// `AppDeps` capability bridge, shared with routers still in api, so api wires this
// seam at load and it reads the registry live on every call
// (`api/src/domain-router-deps.ts`).
import type { ArtifactDownloadHost } from '@slayzone/task/server'

export type ArtifactsRouterDeps = {
  /** The host side of an artifact download, built from the capability bridge. */
  getDownloadHost: () => ArtifactDownloadHost
}

let deps: ArtifactsRouterDeps | null = null

export function setArtifactsRouterDeps(next: ArtifactsRouterDeps): void {
  deps = next
}

export function getArtifactsRouterDeps(): ArtifactsRouterDeps {
  if (!deps)
    throw new Error(
      'artifacts router deps not initialized — @slayzone/api wires them when it composes the router'
    )
  return deps
}
