/**
 * The 10,000-event Claude Code session the long-session specs open (plan 4.1):
 * the generated session (`@slayzone/test-utils/chat-long-session`) with known
 * text in it — the first prompt, a needle in two turns far apart — ending with
 * a turn that ran one Bash command. Same budget session as `chat/__perf__`.
 */
import type { AgentEvent } from '@slayzone/terminal-contracts'
import { buildLongSession } from '@slayzone/test-utils/chat-long-session'

export const FIRST_PROMPT = 'FIRST-PROMPT-165 where does it all begin'
export const NEEDLE = 'ZEBRA-165'
export const LAST_REPLY = 'The probe ran.'
export const PROBE_COMMAND = 'echo probe-165'

const RESULT = {
  kind: 'result',
  subtype: 'success',
  isError: false,
  durationMs: 1,
  durationApiMs: 1,
  numTurns: 1,
  totalCostUsd: 0,
  stopReason: null,
  terminalReason: null,
  modelUsage: {},
  usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  permissionDenials: []
}

export function longSessionEvents(events = 10_000): Array<Record<string, unknown>> {
  const out: AgentEvent[] = buildLongSession({ events: events - 5 })
  for (const e of out) {
    if (e.kind !== 'user-message') continue
    if (e.id === 'u0') e.text = FIRST_PROMPT
    if (e.id === 'u3') e.text = `${NEEDLE} the first one`
    if (e.id === 'u600') e.text = `${NEEDLE} the second one`
  }
  out.push(
    { kind: 'user-message', id: 'u-probe', text: 'run the probe' },
    { kind: 'tool-call', id: 'toolu_probe', name: 'Bash', input: { command: PROBE_COMMAND } },
    {
      kind: 'tool-result',
      toolUseId: 'toolu_probe',
      isError: false,
      rawContent: 'probe-165 output',
      structured: { stdout: 'probe-165 output', stderr: '', interrupted: false, isImage: false }
    },
    { kind: 'assistant-text', messageId: 'm-probe', text: LAST_REPLY },
    { ...RESULT, text: LAST_REPLY } as AgentEvent
  )
  if (out.length !== events) throw new Error(`long session: ${out.length} events, wanted ${events}`)
  return out as unknown as Array<Record<string, unknown>>
}

/**
 * The same session, each message answered (as the outbox saves it). Without
 * deliveries, the hub marks every message failed when it loads the tab (sent
 * before an app restart, never confirmed): ~1,500 changes to old rows.
 */
export function answeredLongSessionEvents(events = 10_000): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const e of longSessionEvents(events)) {
    out.push(e)
    if (e.kind === 'user-message' && typeof e.id === 'string') {
      out.push({ kind: 'user-message-delivery', id: e.id, state: 'answered' })
    }
  }
  return out
}

export const CODEX_FIRST = 'FIRST-CODEX-182 where it begins'
export const CODEX_NEEDLE = 'OKAPI-182'
export const CODEX_LAST = 'The codex probe ran.'
/** The thread id the generated Codex session's turn-init names. */
export const CODEX_THREAD = 'codex-thread'

/**
 * A Codex chat session of `events` events (as `codex-chat-session.ts` saves
 * one): the first prompt, a needle in turns 3 and 600, a last answer.
 */
export function codexLongSessionEvents(events: number): Array<Record<string, unknown>> {
  const out = buildLongSession({ events: events - 4, provider: 'codex' }) as unknown as Array<
    Record<string, unknown>
  >
  for (const e of out) {
    if (e.kind !== 'user-message') continue
    if (e.id === 'u0') e.text = CODEX_FIRST
    if (e.id === 'u3') e.text = `${CODEX_NEEDLE} the first one`
    if (e.id === 'u600') e.text = `${CODEX_NEEDLE} the second one`
  }
  out.push(
    { kind: 'user-message', id: 'u-probe', text: 'run the probe' },
    { kind: 'user-message-delivery', id: 'u-probe', state: 'answered' },
    { kind: 'assistant-text', messageId: 'msg-probe', text: CODEX_LAST },
    { ...RESULT, subtype: 'completed', text: null }
  )
  return out
}
