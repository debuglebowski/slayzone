export {
  listAllProjects,
  createProject,
  updateProject,
  deleteProject,
  uploadProjectIcon,
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
export { handleTerminalStateChange } from './task-automation'
