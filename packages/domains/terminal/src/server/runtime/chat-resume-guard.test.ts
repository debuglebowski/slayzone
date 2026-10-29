/**
 * The holding pen, reduced to what it must hold: only the CLI's real
 * "this conversation can't be resumed" signals are withheld; every other event
 * of a resumed process is shown at once.
 */
import { expect, test } from 'vitest'
import type { AgentEvent, ResultEvent } from '@slayzone/terminal-contracts'
import { classifyResumeEvent } from './chat-resume-guard'

const result = (over: Partial<ResultEvent>): AgentEvent => ({
  kind: 'result',
  subtype: 'success',
  isError: false,
  durationMs: 0,
  durationApiMs: 0,
  numTurns: 1,
  totalCostUsd: 0,
  stopReason: null,
  terminalReason: null,
  text: null,
  modelUsage: {},
  usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  permissionDenials: [],
  ...over
})
const ctx = { interruptIssued: false }

test('"No conversation found" on stderr is a failure; other stderr lines still show', () => {
  expect(
    classifyResumeEvent({ kind: 'stderr', text: 'No conversation found with session ID: x\n' }, ctx)
  ).toEqual({ verdict: 'failure', event: null })
  expect(
    classifyResumeEvent(
      { kind: 'stderr', text: 'warn: slow disk\nNo conversation found with session ID: x\n' },
      ctx
    )
  ).toEqual({ verdict: 'failure', event: { kind: 'stderr', text: 'warn: slow disk\n' } })
})

test('an error result naming the missing conversation is a failure', () => {
  const r = result({
    isError: true,
    subtype: 'error_during_execution',
    text: 'No conversation found with session ID: x'
  })
  expect(classifyResumeEvent(r, ctx)).toEqual({ verdict: 'failure', event: null })
})

test('error_during_execution with 0 turns is a failure — unless the user interrupted', () => {
  const r = result({ isError: true, subtype: 'error_during_execution', numTurns: 0 })
  expect(classifyResumeEvent(r, ctx).verdict).toBe('failure')
  expect(classifyResumeEvent(r, { interruptIssued: true })).toEqual({
    verdict: 'neutral',
    event: r
  })
})

test('any other first-turn error is shown, not withheld', () => {
  const r = result({
    isError: true,
    subtype: 'success',
    text: 'Invalid API key · Please run /login',
    numTurns: 1
  })
  expect(classifyResumeEvent(r, ctx)).toEqual({ verdict: 'neutral', event: r })
  const err: AgentEvent = { kind: 'stderr', text: 'Error: 401 Unauthorized\n' }
  expect(classifyResumeEvent(err, ctx)).toEqual({ verdict: 'neutral', event: err })
})

test('real content confirms the resume', () => {
  for (const e of [
    { kind: 'assistant-text', messageId: 'm', text: 'hi' },
    { kind: 'assistant-thinking', messageId: 'm', text: '', hasSignature: false },
    { kind: 'tool-call', id: 't', name: 'Bash', input: {} },
    result({})
  ] as AgentEvent[]) {
    expect(classifyResumeEvent(e, ctx)).toEqual({ verdict: 'confirm', event: e })
  }
})

test('metadata neither confirms nor fails', () => {
  const init: AgentEvent = { kind: 'turn-init', sessionId: 's', model: 'm', cwd: '/', tools: [] }
  expect(classifyResumeEvent(init, ctx)).toEqual({ verdict: 'neutral', event: init })
})
