// Electron-free terminal surface (pure logic). The node-pty-backed pty/chat
// managers + their webContents.send broadcasts live in ../electron; the transport
// pty/terminal routers receive their ops + events via deps injection at boot.
// Slice 6 may extract a remote-pty server from these pure pieces.
export { resolveUserShell, getShellStartupArgs, whichBinary, getEnrichedPath } from './shell-env'
export {
  isEngagementInputType,
  shouldReportEngagement,
  ENGAGEMENT_INPUT_TYPES,
  ENGAGEMENT_TOUCH_THROTTLE_MS
} from './engagement'
export { syncTerminalModes } from './startup-sync'
export { isHookDrivenMode, HOOK_DRIVEN_MODES } from './adapters'
export {
  encodeClaudeProjectDir,
  claudeProjectDir,
  claudeTranscriptPath,
  claudeTranscriptExists,
  readClaudeTranscriptMeta,
  listClaudeTranscriptIds,
  type ClaudeTranscriptMeta
} from './claude-transcripts'
export { getAutoModeEligibility, type AutoModeEligibility } from './auto-mode-eligibility'
export { supportsChatMode } from './agents/registry'
export {
  hasSessionUserInput,
  markSessionUserInput,
  clearSessionUserInputMark
} from './user-input-tracker'
// Cross-domain seam: server-side callers (integrations sync) invoke the no-op
// default; the Electron host injects the real pty-killing impl at boot.
export { onTaskReachedTerminal, setOnTaskReachedTerminalHandler } from './task-events'

// PTY/chat runtime (slice 6c inversion: electron-free, host-bridged). The
// Electron entry configures the real window/theme/bus bridge at import time;
// the standalone server keeps the inert defaults and wires these ops into the
// transport registries directly.
export {
  configurePtyHost,
  getPtyHostBridge,
  onPtyHostBus,
  type PtyHostBridge,
  type PtySessionWindow,
  type IpcMainLike
} from './pty-host'
export { createPtyOps, setPtySpawnLookups, type PtyCreateOpts } from './runtime/pty-store'
// Hub/runner split spawn-backend seam (wave 2, Model A) + spawn-time lookups /
// session ledger (wave 1) interfaces. Default backend/lookups/ledger are the
// in-process db-backed impls, so this lands dark; a later wave injects remote
// impls via `setPtyBackend` / `setPtySpawnLookups` / `setPtySessionLedger`.
export {
  getPtyBackend,
  setPtyBackend,
  type PtyBackend,
  type PtyHandle,
  type PtySpawnSpec
} from './runtime/pty-backend'
export {
  createDbPtySessionLedger,
  type PtySessionLedger,
  type PtySpawnLookups
} from './runtime/pty-data-ops'
// Warm-process pool lifecycle. Lives in this (server) package — the slice-9
// sidecar owns pty + must initialize it (the renderer's warm tab-count reports
// land here, not in the Electron host). See plans/agent-sessions.md.
export { initWarmProcessManager, teardownAllWarm } from './runtime/warm-process-manager'
export {
  ptyEvents,
  type PtyEventMap,
  listPtys,
  hasPty,
  getBuffer,
  writePty,
  submitPty,
  killPty,
  requestEnsureAlive,
  type EnsureAliveResult,
  subscribeToPtyData,
  subscribeToStateChange,
  onSessionChange,
  getState,
  findSessionByTaskIdAndMode,
  transitionStateFromHook,
  markSessionActiveFromHook,
  noteSessionConversationId,
  setSessionAwaitingInput,
  killPtysByTaskId,
  broadcastRespawnRequest,
  onGlobalStateChange,
  // Wave-1 session-ledger seam (was landed but left unexported): lets a later
  // hub/runner wave inject a non-DB-backed ledger from the composition root.
  setPtySessionLedger,
  // The real "task reached terminal status" teardown (host-kill hook + kill
  // PTYs + kill chat transports). Aliased to avoid colliding with the seam
  // `onTaskReachedTerminal` (task-events) exported above; the side-car wires
  // THIS as the seam handler so status→done actually tears down sessions in
  // this process (where the PTYs/chats live post-cutover).
  onTaskReachedTerminal as runtimeOnTaskReachedTerminal
} from './runtime/pty-manager'
export { createChatOps, type ChatOps, type ChatMode } from './runtime/chat-handlers'
export {
  createChatQueueOps,
  chatQueueEvents,
  type ChatQueueOps,
  type ChatQueueEventMap
} from './runtime/chat-queue-handlers'
export { chatEvents, type ChatEventMap } from './runtime/chat-transport-manager'
