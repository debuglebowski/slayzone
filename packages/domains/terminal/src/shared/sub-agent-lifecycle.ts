/**
 * When a sub-agent starts, goes to the background and ends — the rules the chat
 * timeline (its sub-agent rows) and the chat transport (the tab's `background`
 * state) both follow, so a row and the tab's state never disagree:
 *   - a `sub-agent` event opens it (`in-flight`), or closes it with an explicit
 *     phase (Codex);
 *   - a foreground run ends with its outer tool call's `tool-result`;
 *   - a background run (the Agent tool answered `isAsync`, or the event says
 *     `backgrounded`) outlives that result and its turn: its notification's
 *     status ends it, or its process ending does.
 *
 * @module terminal/shared/sub-agent-lifecycle
 */
import type { ToolResultEvent } from '@slayzone/terminal-contracts'

/**
 * Back-compat normalizer for stored `SubAgentEvent.phase`. Persisted events
 * from before the semantic rename carry legacy CLI subtype strings
 * (`'started'|'updated'|'notification'`). All map to `'in-flight'` on intake;
 * the canonical close signal is the outer Task tool's `tool-result`.
 */
export function normalizeSubAgentPhase(phase: string): 'in-flight' | 'completed' | 'failed' {
  if (phase === 'completed' || phase === 'failed') return phase
  return 'in-flight'
}

/** The Agent tool's answer for a background run: it launched (`isAsync`), it did not end. */
export function isAsyncAgentLaunch(event: ToolResultEvent): boolean {
  const structured = event.structured as { isAsync?: unknown } | null | undefined
  return !event.isError && structured?.isAsync === true
}

/** The phase a `task_notification` status ends a sub-agent in; null = still running. */
export function endedSubAgentPhase(status: string | undefined): 'completed' | 'failed' | null {
  if (status === 'completed') return 'completed'
  if (status === 'failed' || status === 'killed' || status === 'stopped') return 'failed'
  return null
}
