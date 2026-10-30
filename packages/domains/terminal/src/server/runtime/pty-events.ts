import { TypedEmitter } from '@slayzone/platform/events'
import type { TerminalState } from '@slayzone/terminal-contracts'

/**
 * The session event stream every `pty.*` subscription reads (the composition root
 * hands it to the router via `setPtyDeps`). Window-agnostic: it carries the GLOBAL
 * event, not a per-window stream. Reuses the shared TypedEmitter (P6).
 *
 * Its own module, not pty-manager's, so the chat transport can publish onto it:
 * pty-manager imports the chat transport, so the transport importing pty-manager
 * back would be a cycle. Every session kind's facts go through this one stream —
 * `state-change` carries terminal AND chat agents (`${taskId}:${tabId}` keys), so a
 * client follows every agent with one subscription.
 */
export type PtyEventMap = {
  data: [sessionId: string, data: string, seq: number]
  'state-change': [sessionId: string, newState: TerminalState, oldState: TerminalState]
  'title-change': [sessionId: string, title: string]
  /** `exitReason`: lifecycle cause the code cannot carry (`startup-timeout`,
   *  `computer-restarted`, `spawn-failed`, …) — distinct from the adapter's `errorCode`.
   *  `exitDetail`: the owner's own words for it — on `spawn-failed`, the computer's
   *  refusal ("posix_spawnp failed. … Fix: …"). */
  exit: [
    sessionId: string,
    exitCode: number | null,
    errorCode: string | null,
    exitReason?: string | null,
    exitDetail?: string | null
  ]
  // Fired SYNCHRONOUSLY the instant `createPty` decides to replace a live
  // session at this id (respawn/mode-switch/warm-pool adopt) — strictly
  // BEFORE `killPty` and before the new session is registered. `exit` for the
  // outgoing process is NOT a substitute: `killPty` only SIGKILLs, it does not
  // await `finalizeSessionExit` (real onExit, or the watchdog fallback), so
  // that `exit` can land well after the new session already has live hook
  // state. A listener that must reset per-session state on id reuse (e.g. the
  // agent-hook route's subagent tracker) needs THIS event, not `exit`, or it
  // either inherits the outgoing session's stale state (too late) or wipes the
  // incoming session's fresh state (too late the other way, once `exit`
  // finally arrives).
  replacing: [sessionId: string]
  /** Count of claude background jobs (Bash run_in_background / Monitor) still
   *  running under the session — a separate fact from `state` (see agent-tree.ts). */
  'background-jobs': [sessionId: string, count: number]
  prompt: [sessionId: string, prompt: unknown]
  'session-detected': [sessionId: string, conversationId: string]
  'dev-server-detected': [sessionId: string, url: string]
  'respawn-suggested': [taskId: string]
  'ensure-alive': [taskId: string, reqId: number, force: boolean]
  'hibernate-warn': [sessionId: string, graceSecs: number]
  'hibernate-cancelled': [sessionId: string]
  hibernated: [sessionId: string]
  // Per-process CPU/RSS sampler snapshot, keyed by sessionId. Dual-emitted
  // alongside the legacy `pty:stats` webContents.send (host poller).
  stats: [stats: Record<string, { cpu: number; rss: number }>]
  // PTY dimensions need a renderer-side re-fit (e.g. after floating-agent
  // reattach). Dual-emitted alongside the legacy `pty:resize-needed` send.
  'resize-needed': [sessionId: string]
}

export const ptyEvents = new TypedEmitter<PtyEventMap>()
