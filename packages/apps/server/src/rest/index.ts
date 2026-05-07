import type { Express } from 'express'
import type { RestApiDeps } from './types'
import { registerNotifyRoute } from './notify'
import { registerOpenTaskRoute } from './tasks/open'
import { registerCloseTaskRoute } from './tasks/close'
import { registerArchiveTaskRoute } from './tasks/archive'
import { registerArchiveManyTaskRoute } from './tasks/archive-many'
import { registerCreateTaskRoute } from './tasks/create'
import { registerDeleteTaskRoute } from './tasks/delete'
import { registerUnarchiveTaskRoute } from './tasks/unarchive'
import { registerUpdateTaskRoute } from './tasks/update'
import { registerOpenArtifactRoute } from './artifacts/open'
import { registerAutomationsRunRoute } from './automations/run'
import { registerTabsCreateRoute } from './tabs/create'
import { registerTabsSplitRoute } from './tabs/split'

export type { RestApiDeps } from './types'
export { getArtifactFilePath, artifactsDir } from './artifacts/shared'

/** Pure REST routes (no Electron coupling). Mounted in both standalone and embedded. */
export function registerCoreRest(app: Express, deps: RestApiDeps): void {
  registerNotifyRoute(app, deps)

  registerOpenTaskRoute(app, deps)
  registerCloseTaskRoute(app, deps)
  registerCreateTaskRoute(app, deps)
  registerUpdateTaskRoute(app, deps)
  registerDeleteTaskRoute(app, deps)
  registerArchiveTaskRoute(app, deps)
  registerArchiveManyTaskRoute(app, deps)
  registerUnarchiveTaskRoute(app, deps)

  registerOpenArtifactRoute(app, deps)

  registerAutomationsRunRoute(app, deps)

  registerTabsCreateRoute(app, deps)
  registerTabsSplitRoute(app, deps)
}
