// What the `projects` router needs from its host, injected so this domain never
// imports `@slayzone/api`. The computer gateway registry it reads is api's
// (`ComputersDeps`, shared with the computers/hub routers), so api wires this seam at
// load, reading its own registry live on every call (`api/src/domain-router-deps.ts`).

export type ProjectsRouterDeps = {
  /**
   * How many computers can take work right now (`listUsableComputers`), or null when
   * no computer gateway is wired at all: the fork sidecar or a pre-init boot, where
   * this process IS the only machine.
   */
  countUsableComputers: () => number | null
}

// Unwired = no gateway, the same answer api gives before its gateway exists.
let deps: ProjectsRouterDeps = { countUsableComputers: () => null }

export function setProjectsRouterDeps(next: ProjectsRouterDeps): void {
  deps = next
}

export function getProjectsRouterDeps(): ProjectsRouterDeps {
  return deps
}
