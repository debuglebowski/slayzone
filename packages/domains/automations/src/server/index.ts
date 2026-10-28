export {
  listAutomationsByProject,
  getAutomation,
  createAutomation,
  updateAutomation,
  deleteAutomation,
  toggleAutomation,
  reorderAutomations,
  listAutomationRuns,
  clearAutomationRuns
} from './automations-store'
export { AutomationEngine, cronMatches, type AutomationTriggerBus } from './engine'

// `automations.*` tRPC router, its event bus (host-wired via `setAutomationsEvents`)
// and the `automationEngine` context field it reads. Composed by `@slayzone/api`.
export {
  automationsRouter,
  type AutomationsRouter,
  type AutomationsMounts
} from './automations-router'
export {
  setAutomationsEvents,
  getAutomationsEvents,
  type AutomationsEventMap
} from './automations-events'
export type { AutomationEngineLike } from './automation-engine-context'
