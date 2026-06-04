// Electron-free task server surface. Consumed by the transport task/template/artifacts
// routers (which must run under plain Node for the standalone @slayzone/server host).
// Electron-coupled task CRUD ops are NOT exported here — they're injected into transport
// via app-deps `setTaskDeps()` (same pattern as chat/integrations).

export { taskEvents } from './events'
export type { TaskEventMap } from './events'

export {
  artifactWatcherEvents,
  startArtifactWatcher,
  closeArtifactWatcher
} from './artifact-watcher'
export type { ArtifactWatcherEventMap } from './artifact-watcher'

export {
  parseTemplate,
  getTemplateForTask,
  listTemplatesByProject,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  setDefaultTemplate
} from './template-store'

export {
  createArtifactStore,
  parseArtifact,
  parseFolder,
  buildFolderPathResolver,
  collectFolderAndDescendants
} from './artifact-store'
export type { ArtifactStore } from './artifact-store'
