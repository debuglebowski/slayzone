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
