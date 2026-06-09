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
  setConversationResolver,
  type ConversationResolver,
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
  touchTaskMainSession,
  interruptPty,
  noteSessionConversationId,
  setSessionAwaitingInput,
  findSessionByTaskIdAndMode,
  transitionStateFromHook,
  markSessionActiveFromHook,
  notifyGlobalStateListeners,
  ptyEvents,
  type PtyEventMap
} from './pty-manager'
export { resolveUserShell, getShellStartupArgs, whichBinary, getEnrichedPath } from '../server/shell-env'
export { syncTerminalModes } from '../server/startup-sync'
export { isHookDrivenMode, HOOK_DRIVEN_MODES } from '../server/adapters'
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
} from '../server/claude-transcripts'
export { beginTerminalShutdown } from './shutdown'
export { listSessions, getSessionState } from './session-registry'
export { getAutoModeEligibility, type AutoModeEligibility } from '../server/auto-mode-eligibility'
export { supportsChatMode } from '../server/agents/registry'
export {
  hasSessionUserInput,
  markSessionUserInput,
  clearSessionUserInputMark
} from '../server/user-input-tracker'
