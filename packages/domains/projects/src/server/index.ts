export {
  listAllProjects,
  createProject,
  assignUnownedProjects,
  updateProject,
  deleteProject,
  uploadProjectIcon,
  relocateProjectIcons,
  reorderProjects,
  parseProject
} from './project-store'
export {
  listProjectGroups,
  createProjectGroup,
  createFolderWithProjects,
  updateProjectGroup,
  deleteProjectGroup,
  moveProjectToGroup,
  reorderTopLevel,
  reorderProjectsInGroup,
  type ProjectGroupsSnapshot
} from './project-groups-store'
export {
  projectGroupsRouter,
  type ProjectGroupsRouter,
  type ProjectGroupsMounts
} from './project-groups-router'
// `projects.*` tRPC router + the host seam it reads. Composed by `@slayzone/api`,
// which also wires the seam from its computer gateway registry.
export { projectsRouter, type ProjectsRouter } from './projects-router'
export {
  setProjectsRouterDeps,
  getProjectsRouterDeps,
  type ProjectsRouterDeps
} from './projects-router-deps'
export type { ProjectsMounts } from './router-mounts'
export { handleTerminalStateChange } from './task-automation'
export {
  mayAccessProject,
  mayAccessProjectId,
  type ProjectAccessPrincipal,
  type ProjectAccessRequest,
  type ProjectOwnership
} from './project-access'
