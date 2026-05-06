export { resolveUserShell, getShellStartupArgs, whichBinary, getEnrichedPath } from './shell-env'
export { syncTerminalModes } from './startup-sync'
// session-registry moved to electron/ (depends on PTY runtime)
export { getAutoModeEligibility, type AutoModeEligibility } from './auto-mode-eligibility'
export { supportsChatMode } from './agents/registry'
export { onTaskReachedTerminal, setOnTaskReachedTerminalHandler } from './task-events'
