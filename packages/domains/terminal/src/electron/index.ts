import { BrowserWindow, nativeTheme, ipcMain } from 'electron'
import { configurePtyHost } from '../server/pty-host'

// Wire the pty/chat runtime's host bridge to the real Electron primitives at
// entry-import time — before any re-exported runtime fn can run. The runtime
// itself is electron-free (slice 6c inversion); this side effect is what makes
// the Electron app behave exactly as before. The standalone server never
// imports this entry and keeps the inert defaults.
configurePtyHost({
  getAllWindows: () => BrowserWindow.getAllWindows(),
  getFocusedWindow: () => BrowserWindow.getFocusedWindow(),
  isDarkTheme: () => nativeTheme.shouldUseDarkColors,
  bus: ipcMain
})

export { wireWarmWindowCleanup } from './warm-window-cleanup'
export { createPtyOps, type PtyCreateOpts } from '../server/runtime/pty-store'
export { registerUsageHandlers, buildUsageOps } from './usage'
export {
  initWarmProcessManager,
  teardownAllWarm,
  getWarmStatus
} from '../server/runtime/warm-process-manager'
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
  setReinstallHooks,
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
} from '../server/runtime/pty-manager'
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
} from '../server/runtime/chat-handlers'
export {
  createChatQueueOps,
  chatQueueEvents,
  type ChatQueueOps,
  type ChatQueueEventMap
} from '../server/runtime/chat-queue-handlers'
export {
  setSpawnedTabRecorder as setChatSpawnedTabRecorder,
  chatEvents,
  type ChatEventMap
} from '../server/runtime/chat-transport-manager'
export {
  encodeClaudeProjectDir,
  claudeProjectDir,
  claudeTranscriptPath,
  claudeTranscriptExists,
  readClaudeTranscriptMeta,
  listClaudeTranscriptIds,
  type ClaudeTranscriptMeta
} from '../server/claude-transcripts'
export { beginTerminalShutdown } from '../server/runtime/shutdown'
export { listSessions, getSessionState } from '../server/runtime/session-registry'
export { getAutoModeEligibility, type AutoModeEligibility } from '../server/auto-mode-eligibility'
export { supportsChatMode } from '../server/agents/registry'
export {
  hasSessionUserInput,
  markSessionUserInput,
  clearSessionUserInputMark
} from '../server/user-input-tracker'
