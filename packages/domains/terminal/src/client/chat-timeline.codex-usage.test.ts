/**
 * Codex usage in the chat timeline: the context meter reads the driver's saved
 * `context-usage` events (codex `thread/tokenUsage/updated`: `last.totalTokens`
 * of `modelContextWindow`, contract X1 → X2); Codex reports no cost, so a turn
 * has no dollar amount (not `$0`) and the session cost stays unknown.
 * Numbers: what real codex 0.159.2 reported (`fake-codex/transcripts/command-exec.jsonl`).
 */
import { describe, expect, test } from 'vitest'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import { recordedCodexMessages } from '@slayzone/test-utils/fake-codex/recorded'
import { initialState, reducer, selectUsageSummary, type TimelineItem } from './chat-timeline'

const codexResult = (): AgentEvent => ({
  kind: 'result',
  subtype: 'completed',
  isError: false,
  durationMs: 10,
  durationApiMs: 10,
  numTurns: 1,
  totalCostUsd: 0,
  stopReason: null,
  terminalReason: null,
  text: null,
  modelUsage: {},
  usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  permissionDenials: []
})

/** The driver's event for a recorded `thread/tokenUsage/updated`. */
function recordedContextUsage(): AgentEvent {
  const msg = recordedCodexMessages('command-exec').find(
    (m) => m.method === 'thread/tokenUsage/updated'
  )!
  const usage = msg.params.tokenUsage as {
    last: { totalTokens: number }
    modelContextWindow: number | null
  }
  return {
    kind: 'context-usage',
    contextTokens: usage.last.totalTokens,
    contextWindow: usage.modelContextWindow
  } as unknown as AgentEvent
}

const run = (events: AgentEvent[]) => reducer(initialState(), { type: 'events', events })

describe('Codex usage', () => {
  test('the context meter shows the recorded tokens of the window, no cost', () => {
    const state = run([
      { kind: 'turn-init', sessionId: 'thread-1', model: 'gpt-6-luna', cwd: '/r', tools: [] },
      { kind: 'user-message', text: 'hi' },
      recordedContextUsage(),
      codexResult()
    ])
    expect(selectUsageSummary(state)).toEqual({
      contextTokens: 14207,
      contextWindow: 258400,
      sessionCostUsd: null
    })
  })

  test('a later update replaces the earlier one; a window the CLI did not report stays unknown', () => {
    const state = run([
      { kind: 'context-usage', contextTokens: 100, contextWindow: null } as unknown as AgentEvent,
      { kind: 'context-usage', contextTokens: 250, contextWindow: null } as unknown as AgentEvent
    ])
    expect(selectUsageSummary(state)).toEqual({
      contextTokens: 250,
      contextWindow: null,
      sessionCostUsd: null
    })
  })

  test('a turn with no reported cost has no dollar amount', () => {
    const state = run([{ kind: 'user-message', text: 'hi' }, codexResult()])
    const result = state.timeline.find(
      (it): it is Extract<TimelineItem, { kind: 'result' }> => it.kind === 'result'
    )
    expect(result).toBeDefined()
    expect(result?.turnCostUsd).toBeUndefined()
  })

  test('Claude: a turn that cost something keeps its amount', () => {
    const state = run([
      { kind: 'user-message', text: 'hi' },
      {
        ...codexResult(),
        totalCostUsd: 0.25,
        modelUsage: {
          opus: {
            inputTokens: 1,
            outputTokens: 1,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUsd: 0.25,
            contextWindow: 200_000
          }
        }
      } as AgentEvent
    ])
    const result = state.timeline.find(
      (it): it is Extract<TimelineItem, { kind: 'result' }> => it.kind === 'result'
    )
    expect(result?.turnCostUsd).toBe(0.25)
  })
})
