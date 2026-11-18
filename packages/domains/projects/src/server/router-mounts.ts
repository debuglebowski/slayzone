import type { ProjectsRouter } from './projects-router'
import type { ProjectGroupsRouter } from './project-groups-router'
import type { SharingRouter } from './sharing-router'

/**
 * Where this domain's routers sit in the app router. One combined type: projects and
 * their groups are one domain's surface and its client calls both. `@slayzone/api`
 * mounts them at these keys and asserts the slice in its `router.ts`.
 */
export type ProjectsMounts = {
  projects: ProjectsRouter
  projectGroups: ProjectGroupsRouter
  /** Who else may reach a project, task or artifact (T-100). */
  sharing: SharingRouter
}
