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
export { projectGroupsRouter } from './project-groups-router'
export { handleTerminalStateChange } from './task-automation'
export {
  mayAccessProject,
  mayAccessProjectId,
  type ProjectAccessPrincipal,
  type ProjectAccessRequest,
  type ProjectOwnership
} from './project-access'
