/**
 * What a resumed (`--resume <id>`) chat process is allowed to hide.
 *
 * Only the CLI's real "this conversation can't be resumed" signals are withheld:
 * the transport then starts a fresh conversation and re-sends the user's
 * message, so those signals are not news to the user (a notice says what
 * happened). Every other event is shown at once — the old holding pen staged
 * EVERYTHING until a healthy event, so an auth or API error on a resumed first
 * turn was never shown, and a failed resume discarded the user's message (#2).
 *
 * Signals, as Claude Code 2.1.312 sends them for a missing conversation:
 * stderr `No conversation found with session ID: <id>`, then an error `result`
 * (`error_during_execution`, 0 turns) carrying the same text, then exit 1.
 *
 * @module terminal/server/runtime/chat-resume-guard
 */
import type { AgentEvent } from '@slayzone/terminal-contracts'

const NOT_FOUND = /no conversation found/i

export type ResumeVerdict = 'failure' | 'confirm' | 'neutral'

export interface ResumeClassification {
  verdict: ResumeVerdict
  /** What may still be shown (`null`: nothing) — stderr minus the failure lines. */
  event: AgentEvent | null
}

export function classifyResumeEvent(
  event: AgentEvent,
  ctx: { interruptIssued: boolean }
): ResumeClassification {
  switch (event.kind) {
    case 'stderr': {
      if (!NOT_FOUND.test(event.text)) return { verdict: 'neutral', event }
      const rest = event.text
        .split(/(?<=\n)/)
        .filter((line) => !NOT_FOUND.test(line))
        .join('')
      return { verdict: 'failure', event: rest.trim() ? { kind: 'stderr', text: rest } : null }
    }
    case 'result': {
      if (!event.isError) return { verdict: 'confirm', event }
      if (NOT_FOUND.test(event.text ?? '')) return { verdict: 'failure', event: null }
      // A resume that never loaded a conversation ends its only "turn" with
      // nothing run. An interrupt ends the same way, so it never counts as one.
      if (
        event.subtype === 'error_during_execution' &&
        event.numTurns === 0 &&
        !ctx.interruptIssued
      ) {
        return { verdict: 'failure', event: null }
      }
      return { verdict: 'neutral', event }
    }
    case 'assistant-text':
    case 'assistant-thinking':
    case 'tool-call':
      return { verdict: 'confirm', event }
    default:
      return { verdict: 'neutral', event }
  }
}
