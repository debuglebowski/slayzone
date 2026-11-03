import { describe, expect, test } from 'vitest'
import type { PermissionRequestEvent } from '@slayzone/terminal-contracts'
import { ChatPromptAnswerError, decideChatPrompt, describeChatPrompt } from './prompt-answers'
import { buildPermissionView, feedbackDenial, REJECT_MESSAGE } from './prompt-options'
import { CODEX_QUESTIONS } from './question-options'

const ctx = { autoModeAvailable: false, cwd: '/repo' }

function req(toolName: string, input: unknown, extra: Partial<PermissionRequestEvent> = {}) {
  return {
    kind: 'permission-request',
    requestId: 'r1',
    toolName,
    toolUseId: 't1',
    input,
    ...extra
  } as PermissionRequestEvent
}

const bashWithRule = req(
  'Bash',
  { command: 'ls' },
  {
    permissionSuggestions: [
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'localSettings',
        rules: [{ toolName: 'Bash', ruleContent: 'ls' }]
      }
    ]
  }
)

describe('permission prompts', () => {
  test('describe lists the same rows the card shows', () => {
    const view = describeChatPrompt(bashWithRule, ctx)
    expect(view.kind).toBe('permission')
    expect(view.title).toBe('Bash command')
    expect(view.options.map((o) => o.id)).toEqual(
      buildPermissionView(bashWithRule, ctx).options.map((o) => o.id)
    )
    expect(view.questions).toEqual([])
  })

  test('a row id answers with that row', () => {
    const card = buildPermissionView(bashWithRule, ctx)
    expect(decideChatPrompt(bashWithRule, { optionId: 'yes-rules' }, ctx)).toEqual({
      optionId: 'yes-rules',
      decision: card.options.find((o) => o.id === 'yes-rules')!.decision
    })
  })

  test('allow / deny / always aliases', () => {
    expect(decideChatPrompt(bashWithRule, { optionId: 'allow' }, ctx)).toEqual({
      optionId: 'yes',
      decision: { behavior: 'allow' }
    })
    expect(decideChatPrompt(bashWithRule, { optionId: 'deny' }, ctx)).toEqual({
      optionId: 'no',
      decision: { behavior: 'deny', message: REJECT_MESSAGE, interrupt: true }
    })
    expect(decideChatPrompt(bashWithRule, { optionId: 'always' }, ctx).optionId).toBe('yes-rules')
    expect(() =>
      decideChatPrompt(req('Bash', { command: 'ls' }), { optionId: 'always' }, ctx)
    ).toThrow(ChatPromptAnswerError)
  })

  test('deny with a message rejects with feedback and lets the turn continue', () => {
    expect(decideChatPrompt(bashWithRule, { optionId: 'deny', message: 'use rg' }, ctx)).toEqual({
      optionId: 'no-feedback',
      decision: feedbackDenial('use rg')
    })
  })

  test('a feedback row needs its message', () => {
    const fetch = req('WebFetch', { url: 'https://example.com' })
    expect(() => decideChatPrompt(fetch, { optionId: 'no-feedback' }, ctx)).toThrow(/message/)
    expect(decideChatPrompt(fetch, { optionId: 'deny', message: 'no' }, ctx)).toEqual({
      optionId: 'no-feedback',
      decision: feedbackDenial('no')
    })
  })

  test('an unknown row names the valid ones', () => {
    expect(() => decideChatPrompt(bashWithRule, { optionId: 'maybe' }, ctx)).toThrow(
      /yes, yes-rules, no/
    )
  })
})

describe('plan prompts', () => {
  const plan = req('ExitPlanMode', { plan: '1. do it' })
  test('describe offers the plan rows plus reject', () => {
    const view = describeChatPrompt(plan, ctx)
    expect(view.kind).toBe('plan')
    expect(view.options.map((o) => o.id)).toEqual([
      'plan-accept-edits',
      'plan-manual',
      'plan-feedback',
      'plan-reject'
    ])
  })
  test('allow approves with the first row; deny rejects and stops the turn', () => {
    expect(decideChatPrompt(plan, { optionId: 'allow' }, ctx).optionId).toBe('plan-accept-edits')
    expect(decideChatPrompt(plan, { optionId: 'deny' }, ctx)).toEqual({
      optionId: 'plan-reject',
      decision: { behavior: 'deny', message: REJECT_MESSAGE, interrupt: true }
    })
  })
  test('deny with a message keeps planning with that feedback', () => {
    expect(decideChatPrompt(plan, { optionId: 'deny', message: 'smaller' }, ctx)).toEqual({
      optionId: 'plan-feedback',
      decision: feedbackDenial('smaller')
    })
  })
  test('approve with a message approves, then sends the message', () => {
    expect(decideChatPrompt(plan, { optionId: 'plan-manual', message: 'go' }, ctx)).toEqual({
      optionId: 'plan-manual',
      decision: { behavior: 'allow' },
      followUpMessage: 'go'
    })
  })
})

describe('AskUserQuestion', () => {
  const ask = req('AskUserQuestion', {
    questions: [
      {
        question: 'Which db?',
        header: 'DB',
        options: [{ label: 'SQLite' }, { label: 'Postgres' }]
      },
      {
        question: 'Which features?',
        header: 'Features',
        multiSelect: true,
        options: [{ label: 'Auth' }, { label: 'Billing' }]
      }
    ]
  })

  test('describe lists the questions and their options', () => {
    const view = describeChatPrompt(ask, ctx)
    expect(view.kind).toBe('question')
    expect(view.questions).toEqual([
      {
        key: 'Which db?',
        header: 'DB',
        question: 'Which db?',
        options: ['SQLite', 'Postgres'],
        multiSelect: false,
        allowsOther: true
      },
      {
        key: 'Which features?',
        header: 'Features',
        question: 'Which features?',
        options: ['Auth', 'Billing'],
        multiSelect: true,
        allowsOther: true
      }
    ])
  })

  test('answers by question text, header or position; labels, numbers or free text', () => {
    const decided = decideChatPrompt(
      ask,
      { answers: { DB: 'postgres', '2': ['1', 'Billing'] } },
      ctx
    )
    expect(decided.optionId).toBe('answer')
    expect(decided.decision).toEqual({
      behavior: 'allow',
      updatedInput: {
        ...(ask.input as object),
        answers: { 'Which db?': 'Postgres', 'Which features?': 'Auth, Billing' }
      }
    })
    const other = decideChatPrompt(ask, { answers: { '1': 'DuckDB', '2': 'Auth' } }, ctx)
    expect(other.decision).toMatchObject({
      updatedInput: { answers: { 'Which db?': 'DuckDB', 'Which features?': 'Auth' } }
    })
  })

  test('every question needs an answer; unknown keys are refused', () => {
    expect(() => decideChatPrompt(ask, { answers: { DB: 'SQLite' } }, ctx)).toThrow(
      /Which features\?/
    )
    expect(() => decideChatPrompt(ask, { answers: { nope: 'x' } }, ctx)).toThrow(/nope/)
  })

  test('decline / deny declines just the question', () => {
    expect(decideChatPrompt(ask, { optionId: 'deny' }, ctx)).toEqual({
      optionId: 'decline',
      decision: { behavior: 'deny', message: REJECT_MESSAGE }
    })
  })
})

describe('Codex questions', () => {
  const codex = req(CODEX_QUESTIONS, {
    questions: [
      {
        id: 'q1',
        header: 'Env',
        question: 'Which env?',
        options: [{ label: 'dev' }, { label: 'prod' }]
      },
      { id: 'q2', header: 'Token', question: 'Token?', isOther: true, isSecret: true, options: [] }
    ]
  })

  test('answers are keyed by question id, one value each', () => {
    expect(describeChatPrompt(codex, ctx).kind).toBe('codex-question')
    expect(decideChatPrompt(codex, { answers: { q1: '2', Token: 'abc' } }, ctx)).toEqual({
      optionId: 'submit',
      decision: { behavior: 'allow', updatedInput: { answers: { q1: ['prod'], q2: ['abc'] } } }
    })
  })

  test('a free-text answer is refused where the question has no "other"', () => {
    expect(() => decideChatPrompt(codex, { answers: { q1: 'staging', q2: 'x' } }, ctx)).toThrow(
      /staging/
    )
  })

  test('deny skips (the turn goes on); cancel stops the turn', () => {
    expect(decideChatPrompt(codex, { optionId: 'deny' }, ctx)).toEqual({
      optionId: 'skip',
      decision: { behavior: 'deny', message: '' }
    })
    expect(decideChatPrompt(codex, { optionId: 'cancel' }, ctx)).toEqual({
      optionId: 'cancel',
      decision: { behavior: 'deny', message: '', interrupt: true }
    })
  })
})
