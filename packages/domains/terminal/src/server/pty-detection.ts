/**
 * `@slayzone/terminal/pty-detection` — the lean half of the terminal domain that the
 * COMPUTER runs over its own pty output: mode adapters (activity / error / prompt /
 * conversation-id detection), the state-machine helpers, the output filter, terminal
 * sync-query answers and the ring buffer.
 *
 * Everything reachable from here must stay free of the hub/app tree (no electron,
 * React, node-pty, DB, tRPC): the computer bundles it into one standalone file.
 * `pty-detection.test.ts` bundles this entry and fails on any such import.
 */
export {
  getAdapter,
  getDefaultAdapter,
  isHookDrivenMode,
  HOOK_DRIVEN_MODES,
  type GetAdapterOptions
} from './adapters'
export type {
  ActivityState,
  ErrorInfo,
  PromptInfo,
  TerminalAdapter,
  AgentId
} from './adapters/types'
export {
  StateMachine,
  activityToTerminalState,
  shouldRefreshIdleClock,
  shouldFlipToIdle,
  shouldHibernate,
  shouldFlipToRunningOnInput,
  recordWorkingDetection,
  WORKING_DETECTION_WINDOW_MS,
  WORKING_DETECTION_THRESHOLD,
  type StateChangeCallback,
  type StateTraceCallback,
  type StateTraceEvent
} from './state-machine'
export { RingBuffer, type BufferChunk } from './ring-buffer'
export { filterBufferData } from './filter-buffer-data'
export {
  computeSyncQueryResponse,
  type SyncQueryResult,
  type TerminalTheme
} from './sync-query-response'
export { TerminalReplyMirror } from './terminal-reply-mirror'
export { shouldHonorDetectedError } from './session-error-gate'
export {
  PtyOutputDetector,
  stripAnsiForSessionParse,
  SESSION_ERROR_WINDOW_MS,
  CONVERSATION_ID_WATCH_TIMEOUT_MS,
  DISK_SESSION_POLL_MS,
  DISK_SESSION_POLL_ATTEMPTS,
  type PtyOutputDetection,
  type PtyOutputDetectorOptions
} from './pty-output-detector'
export { DEV_SERVER_URL_PATTERN } from '@slayzone/terminal-contracts'
export { claudeTranscriptExists } from './claude-transcripts'
