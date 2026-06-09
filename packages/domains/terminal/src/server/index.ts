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
