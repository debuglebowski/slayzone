export { registerPtyHandlers } from './handlers'
export { registerUsageHandlers } from './usage'
export {
  killAllPtys,
  shutdownAllPtys,
  killPty,
  killPtysByTaskId,
  onTaskReachedTerminal,
  startIdleChecker,
  stopIdleChecker,
  getPtyPids,
  onSessionChange,
  onGlobalStateChange,
  listPtys,
  setPtyEnricher,
  getBuffer,
  getBufferSince,
  writePty,
  submitPty,
  getState,
  hasPty,
  subscribeToPtyData,
  subscribeToStateChange,
  onPtyInputSubmit,
  redirectSessionWindow,
  setOnHostKillHandler,
  broadcastRespawnRequest,
  requestEnsureAlive,
  type EnsureAliveResult,
  PTY_EXIT_KILLED_BY_HOST,
  type PtyShutdownOptions,
  type PtyShutdownResult,
  setSpawnedTabRecorder as setPtySpawnedTabRecorder,
  setHibernatedTabRecorder as setPtyHibernatedTabRecorder,
  setIdleCloseConfigGetter,
  touchPty,
  noteSessionConversationId,
  setSessionAwaitingInput,
  findSessionByTaskIdAndMode,
  transitionStateFromHook,
  markSessionActiveFromHook
} from './pty-manager'
export { resolveUserShell, getShellStartupArgs, whichBinary, getEnrichedPath } from './shell-env'
export { syncTerminalModes } from './startup-sync'
export { isHookDrivenMode, HOOK_DRIVEN_MODES } from './adapters'
export {
  registerChatHandlers,
  shutdownChatTransports,
  killAllChatTransports,
  inspectPermissionFlags,
  backfillChatModes,
  chatModeToFlags,
  type ChatMode
} from './chat-handlers'
export { setSpawnedTabRecorder as setChatSpawnedTabRecorder } from './chat-transport-manager'
export { beginTerminalShutdown } from './shutdown'
export { listSessions, getSessionState } from './session-registry'
export { getAutoModeEligibility, type AutoModeEligibility } from './auto-mode-eligibility'
export { supportsChatMode } from './agents/registry'
export {
  hasSessionUserInput,
  markSessionUserInput,
  clearSessionUserInputMark
} from './user-input-tracker'
export { notifyGlobalStateListeners } from './pty-manager'
