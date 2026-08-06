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
  localPtyBackend,
  type PtyBackend,
  type PtyHandle,
  type PtySpawnSpec
} from './runtime/pty-backend'
export {
  createDbPtySessionLedger,
  createDbPtySpawnLookups,
  type PtySessionLedger,
  type PtySpawnLookups
} from './runtime/pty-data-ops'
// The CHAT spawn seam — the exact counterpart of `PtyBackend` above, so a chat
// agent can run on a runner like a terminal agent already can. Injected via
// `configureTransport({ backend })`; unset = in-process spawn.
export {
  childProcessToHandle,
  createLineSplitter,
  createLocalChatBackend,
  type ChatBackend,
  type ChatDisposable,
  type ChatProcHandle,
  type ChatSpawnSpec
} from './runtime/chat-proc-handle'
// Wave-3 remote-MCP-env contracts: the composition root builds a provider of
// this shape and injects it via `setRemoteMcpEnvProvider`.
export {
  AGENT_HOOK_PATH,
  type RemoteMcpEnv,
  type RemoteMcpEnvProvider
} from './mcp-env'
// Warm-process pool lifecycle. Lives in this (server) package — the slice-9
// sidecar owns pty + must initialize it (the renderer's warm tab-count reports
// land here, not in the Electron host). See plans/agent-sessions.md.
export {
  initWarmProcessManager,
  reapOrphanWarms,
  teardownAllWarm
} from './runtime/warm-process-manager'
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
  // Pty enricher seam — decorates PtyInfo with task/tab context. FOURTH instance
  // of the same defect on this list: electron-free, in runtime/, exported only
  // from the electron barrel, therefore wireable only by a host that owns no
  // sessions. If you are adding a seam here, export it from THIS barrel.
  setPtyEnricher,
  // Host-kill stamp seam. Same story as the healer/resolver below: it lives in
  // pty-manager (electron-free) but was exported only from the electron barrel,
  // so only the host could wire it — against a session registry the host no
  // longer owns. The side-car owns the sessions, so it must be able to import it.
  setOnHostKillHandler,
  // E2E seam: drives a synthetic pty state transition. Must be reachable from the
  // SERVER barrel because the listeners that react to it (attention flag,
  // task auto-move) live in the side-car — firing it in the host reaches nothing.
  notifyGlobalStateListeners,
  // Conversation self-heal + authoritative-resolve seams. `createPty` (which
  // lives in THIS process post-slice-9) calls the injected healer before a
  // resume and the resolver when the renderer passes no hint. The composition
  // root registers both — the sidecar MUST wire them here (the pty runtime is
  // here), or a stale/phantom conversation id loops `--resume` forever. Were
  // exported only from the electron barrel pre-fix, so the main process wired
  // its (empty, post-inversion) copy while the sidecar's stayed null.
  setConversationHealer,
  type ConversationHealer,
  type ConversationHealRequest,
  setConversationResolver,
  type ConversationResolver,
  // Wave-1 session-ledger seam (was landed but left unexported): lets a later
  // hub/runner wave inject a non-DB-backed ledger from the composition root.
  setPtySessionLedger,
  // Wave-3 remote-MCP-env seam: the runner transport injects a provider that
  // resolves the hub base URL so a runner-routed pty's slay CLI dials the hub.
  // Unset => loopback. (The agent hook posts to loopback regardless.)
  setRemoteMcpEnvProvider,
  // Spawn-time hook self-heal seam: the app injects a callback that re-runs the
  // version-gated notify.sh installer just-in-time, so a hook-driven spawn can't
  // fire through a stale cross-release-channel copy left on disk between boots.
  setReinstallHooks,
  // The real "task reached terminal status" teardown (host-kill hook + kill
  // PTYs + kill chat transports). Aliased to avoid colliding with the seam
  // `onTaskReachedTerminal` (task-events) exported above; the side-car wires
  // THIS as the seam handler so status→done actually tears down sessions in
  // this process (where the PTYs/chats live post-cutover).
  onTaskReachedTerminal as runtimeOnTaskReachedTerminal,
  // Idle-close (hibernation) config seam. Only the ELECTRON barrel exported this,
  // which is how the feature went dead: the sweep that reads it runs in the
  // side-car (slice 9), and with the getter unset it fails safe to disabled — so
  // hibernation silently never fired. The side-car composition wires it now, and
  // it must be reachable from the server barrel to do that.
  setIdleCloseConfigGetter,
  // `was_spawned` recorder seam — the flag that decides whether a restart
  // restores your agents. Same orphaning as `setIdleCloseConfigGetter` above:
  // only the ELECTRON barrel exported it, so when the pty runtime moved to the
  // side-car (and spawning to the runner) the host kept wiring a manager that
  // owns no sessions, every `spawnedSetter?.(…)` became a no-op, and restore
  // silently died. The side-car composition wires it now (tab-flag-recorders.ts)
  // and needs it reachable from the SERVER barrel to do that.
  setSpawnedTabRecorder as setPtySpawnedTabRecorder,
  getSpawnedTabRecorder as getPtySpawnedTabRecorder
} from './runtime/pty-manager'
export {
  createChatOps,
  // One-shot backfill for pre-chat-mode tasks. Electron-free (it lives right
  // here in runtime/), but was exported only from the electron barrel — so only
  // the Electron host could run it, and a standalone hub silently never did.
  backfillChatModes,
  type ChatOps,
  type ChatMode
} from './runtime/chat-handlers'
// The chat data seam. Exported so a composition root can override ONE method
// (e.g. runner resolution) over the db-backed defaults instead of reimplementing
// the whole interface.
export { createDbChatDataOps, type ChatDataOps } from './runtime/chat-data-ops'
export {
  createChatQueueOps,
  chatQueueEvents,
  type ChatQueueOps,
  type ChatQueueEventMap
} from './runtime/chat-queue-handlers'
export {
  chatEvents,
  configureTransport,
  // Chat's half of the `was_spawned` seam — a chat-mode agent must flip the same
  // column a pty-mode one does, or restore works for half your tasks.
  setSpawnedTabRecorder as setChatSpawnedTabRecorder,
  getSpawnedTabRecorder as getChatSpawnedTabRecorder,
  type ChatEventMap,
  type TransportDeps
} from './runtime/chat-transport-manager'
// Quit-time gate: flip BEFORE any teardown that can fire pty/chat exit handlers,
// or the kill cascade clears the very `was_spawned` flags the next boot needs.
export { beginTerminalShutdown } from './runtime/shutdown'
