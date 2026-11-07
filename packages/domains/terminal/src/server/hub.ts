/**
 * `@slayzone/terminal/hub`: what the HUB uses of this domain — the routers, the pty
 * coordinator that routes to computers, the lifecycle/state seams and the chat relay
 * wiring. Nothing here runs a process, a shell probe or an in-process agent
 * (lint:server-boundary). The `./server` barrel keeps the local implementations.
 */
export { isHookDrivenMode } from './adapters'
export {
  type AgentLifecycleEventMap,
  setAgentLifecycleEvents
} from './agent-lifecycle-events'
export {
  type AgentLifecycleMounts,
  agentLifecycleRouter
} from './agent-lifecycle-router'
export {
  type AgentTree,
  applyAgentHook,
  applyBackgroundJobHook,
  createAgentTree,
  dropBackgroundJobs,
  subagentIdOf
} from './agent-tree'
export {
  type ChatMounts,
  chatRouter
} from './chat-router'
export {
  getChatDeps,
  setChatDeps
} from './chat-router-deps'
export {
  claudeTranscriptPath,
  claudeTranscriptRetentionMs,
  listClaudeTranscriptIds,
  readClaudeTranscriptMeta
} from './claude-transcripts'
export {
  type PtySessionWindow,
  configurePtyHost
} from './pty-host'
export {
  type PtyMounts,
  ptyRouter
} from './pty-router'
export {
  getPtyDeps,
  setPtyDeps
} from './pty-router-deps'
export { createDbChatDataOps } from './runtime/chat-data-ops'
export { defaultConversationRegistry, releaseConversation } from './runtime/live-conversations'
export {
  locateClaudeTranscripts,
  setClaudeTranscriptLocator
} from './runtime/claude-transcript-locator'
export { setPtyBackend } from './runtime/pty-backend'
export { setExecutionContextProbe } from './runtime/pty-manager'
export { setTerminalCommandProbe } from './runtime/pty-store'
export { createDbPtySpawnLookups } from './runtime/pty-data-ops'
export {
  type AgentStateRecorder,
  type ConversationHealRequest,
  broadcastRespawnRequest,
  findSessionByTaskIdAndMode,
  getBuffer,
  getBufferSince,
  getPtyDirectTarget,
  applyPtyInputFacts,
  getState,
  hasLivePty,
  hasPty,
  killPty,
  killPtysByTaskId,
  listPtys,
  markSessionActiveFromHook,
  noteSessionConversationId,
  notifyGlobalStateListeners,
  onGlobalStateChange,
  onSessionChange,
  probeSessionBackgroundJobs,
  ptyEvents,
  requestEnsureAlive,
  onTaskReachedTerminal as runtimeOnTaskReachedTerminal,
  setConversationHealer,
  setConversationResolver,
  setIdleCloseConfigGetter,
  setAgentStateTabRecorder as setPtyAgentStateTabRecorder,
  setPtyEnricher,
  setRemoteMcpEnvProvider,
  setSessionAwaitingInput,
  setSessionBackgroundJobs,
  startIdleChecker,
  stopIdleChecker,
  submitPty,
  subscribeToPtyData,
  subscribeToStateChange,
  touchTaskMainSession,
  transitionStateFromHook,
  onPtyInputSubmit,
  writePty
} from './runtime/pty-manager'
export {
  createPtyOps,
  setPtySpawnLookups
} from './runtime/pty-store'
export { setChatSessionSource } from './runtime/session-registry'
export { beginTerminalShutdown } from './runtime/shutdown'
export { resetTerminalRuntimeForTest } from './runtime/test-reset'
export {
  clearWindowTabCounts,
  createDbWarmPoolDataOps,
  initWarmProcessManager,
  reapOrphanWarms,
  reserveWarmTaskId,
  teardownAllWarm,
  unadoptedWarmAgent
} from './runtime/warm-process-manager'
export {
  onTaskReachedTerminal,
  setTaskAgentsStopper
} from './task-events'
export {
  type AppUsageMounts,
  appUsageRouter
} from './usage-router'
export { setUsageRouterDeps } from './usage-router-deps'
export {
  clearSessionUserInputMark,
  hasSessionUserInput,
  markSessionUserInput
} from './user-input-tracker'
