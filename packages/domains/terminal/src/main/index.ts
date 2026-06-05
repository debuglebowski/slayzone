export { registerPtyHandlers, getPtyHandlerChannels } from './handlers'
export { createPtyOps, type PtyCreateOpts } from './pty-store'
export { registerUsageHandlers, buildUsageOps } from './usage'
export {
  initWarmProcessManager,
  teardownAllWarm,
  getWarmStatus
} from './warm-process-manager'
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
  setConversationHealer,
  type ConversationHealer,
  type ConversationHealRequest,
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
  interruptPty,
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
  createChatOps,
  shutdownChatTransports,
  killAllChatTransports,
  inspectPermissionFlags,
  backfillChatModes,
  chatModeToFlags,
  type ChatMode,
  type ChatOps
} from './chat-handlers'
export {
  createChatQueueOps,
  chatQueueEvents,
  type ChatQueueOps,
  type ChatQueueEventMap
} from './chat-queue-handlers'
export {
  setSpawnedTabRecorder as setChatSpawnedTabRecorder,
  chatEvents,
  type ChatEventMap
} from './chat-transport-manager'
export {
  encodeClaudeProjectDir,
  claudeProjectDir,
  claudeTranscriptPath,
  claudeTranscriptExists,
  readClaudeTranscriptMeta,
  listClaudeTranscriptIds,
  type ClaudeTranscriptMeta
} from './claude-transcripts'
export { beginTerminalShutdown } from './shutdown'
export { listSessions, getSessionState } from './session-registry'
export { getAutoModeEligibility, type AutoModeEligibility } from './auto-mode-eligibility'
export { supportsChatMode } from './agents/registry'
export {
  hasSessionUserInput,
  markSessionUserInput,
  clearSessionUserInputMark
} from './user-input-tracker'
export { notifyGlobalStateListeners, ptyEvents, type PtyEventMap } from './pty-manager'
