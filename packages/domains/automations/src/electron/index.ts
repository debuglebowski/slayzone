export { registerAutomationHandlers } from './handlers'
// Engine moved to the electron-free server entry (slice 6); re-exported so
// existing electron-entry importers keep working.
export { AutomationEngine } from '../server'
