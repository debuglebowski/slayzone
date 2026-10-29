/**
 * The prompt rows and wording copy Claude Code's TUI (2.1.312). Requests are the
 * real wire shapes from the CLI spike (report item 1); the expected rows are the
 * TUI's screens for the same requests, and its row builders where no screen was
 * captured (Bash with three suggestions).
 */
import { describe, expect, test } from 'vitest'
import type { PermissionRequestEvent } from '@slayzone/terminal-contracts'
import {
  buildPermissionView,
  buildPlanOptions,
  clarifyDecision,
  declineQuestionDecision,
  feedbackDenial,
  questionAnswerDecision,
  REJECT_MESSAGE
} from './prompt-options'

const CWD = '/repo'
const ctx = { autoModeAvailable: true, cwd: CWD }

function req(over: Partial<PermissionRequestEvent>): PermissionRequestEvent {
  return {
    kind: 'permission-request',
    requestId: 'r1',
    toolName: 'Bash',
    toolUseId: 'tu1',
    input: {},
    ...over
  }
}

const labels = (r: PermissionRequestEvent, c = ctx) =>
  buildPermissionView(r, c).options.map((o) => o.label)

const BASH_PLAIN = req({
  toolName: 'Bash',
  displayName: 'Bash',
  input: { command: 'python3 -c "print(6*7)"', description: 'Print 6*7' },
  description: 'Print 6*7',
  permissionSuggestions: [
    {
      type: 'addRules',
      rules: [{ toolName: 'Bash', ruleContent: 'python3 -c "print(6*7)"' }],
      behavior: 'allow',
      destination: 'localSettings'
    }
  ],
  decisionReason: 'This command requires approval'
})

describe('Bash', () => {
  test('plain command: Yes / don’t ask again / auto mode / No', () => {
    const view = buildPermissionView(BASH_PLAIN, ctx)
    expect(view.title).toBe('Bash command')
    expect(view.question).toBe('Do you want to proceed?')
    expect(view.decisionReason).toBe('This command requires approval')
    expect(view.tip).toBe(
      'Tip: auto mode handles these prompts for you — choose "switch to auto mode" below'
    )
    expect(view.options.map((o) => o.label)).toEqual([
      'Yes',
      'Yes, and don’t ask again for: python3 -c "print(6*7)"',
      'Yes, and switch to auto mode · auto mode handles these prompts for you',
      'No'
    ])
    expect(view.footer).toBe('Esc to cancel · Tab to amend')
    expect(view.canAmend).toBe(true)
  })

  test('each row carries its own wire decision', () => {
    const [yes, always, auto, no] = buildPermissionView(BASH_PLAIN, ctx).options
    expect(yes.decision).toEqual({ behavior: 'allow' })
    expect(always.decision).toEqual({
      behavior: 'allow',
      updatedPermissions: BASH_PLAIN.permissionSuggestions
    })
    expect(auto.decision).toEqual({
      behavior: 'allow',
      updatedPermissions: [{ type: 'setMode', mode: 'auto', destination: 'session' }]
    })
    expect(no.decision).toEqual({ behavior: 'deny', message: REJECT_MESSAGE, interrupt: true })
  })

  test('no auto mode on this account: no auto row, no tip', () => {
    const view = buildPermissionView(BASH_PLAIN, { ...ctx, autoModeAvailable: false })
    expect(view.options.map((o) => o.label)).toEqual([
      'Yes',
      'Yes, and don’t ask again for: python3 -c "print(6*7)"',
      'No'
    ])
    expect(view.tip).toBeUndefined()
  })

  test('outside the project: the directory row wins over the rule row and applies only the directory', () => {
    const dirs = {
      type: 'addDirectories',
      directories: ['/repo/sandbox'],
      destination: 'session'
    }
    const r = req({
      input: { command: 'echo hi1 > out1.txt', description: 'Write hi1' },
      permissionSuggestions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'echo hi1 *' }],
          behavior: 'allow',
          destination: 'localSettings'
        },
        dirs
      ],
      blockedPath: '/repo/sandbox/out1.txt'
    })
    const view = buildPermissionView(r, ctx)
    expect(view.options.map((o) => o.label)).toEqual([
      'Yes',
      'Yes, and always allow access to /repo/sandbox from this project',
      'Yes, and switch to auto mode · auto mode handles these prompts for you',
      'No'
    ])
    expect(view.options[1].decision).toEqual({ behavior: 'allow', updatedPermissions: [dirs] })
  })

  test('a mode suggestion is a row of its own', () => {
    const r = req({
      input: { command: 'touch a.txt' },
      permissionSuggestions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'touch a.txt' }],
          behavior: 'allow',
          destination: 'localSettings'
        },
        { type: 'setMode', mode: 'acceptEdits', destination: 'session' }
      ]
    })
    expect(labels(r, { ...ctx, autoModeAvailable: false })).toEqual([
      'Yes',
      'Yes, and don’t ask again for: touch a.txt',
      'Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session',
      'No'
    ])
  })
})

describe('file tools', () => {
  const acceptEdits = [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]

  test('Edit: shows the edit, offers accept edits (shift+tab)', () => {
    const view = buildPermissionView(
      req({
        toolName: 'Edit',
        input: { file_path: '/repo/f1.txt', old_string: 'color = red', new_string: 'color = blue' },
        description: 'f1.txt',
        permissionSuggestions: acceptEdits
      }),
      ctx
    )
    expect(view.title).toBe('Edit file')
    expect(view.subtitle).toBe('f1.txt')
    expect(view.question).toBe('Do you want to make this edit to f1.txt?')
    expect(view.options.map((o) => o.label)).toEqual([
      'Yes',
      'Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)',
      'No'
    ])
    expect(view.options[1].decision).toEqual({
      behavior: 'allow',
      updatedPermissions: acceptEdits
    })
    expect(view.shiftTabOptionId).toBe(view.options[1].id)
  })

  test('Write: create file', () => {
    const view = buildPermissionView(
      req({
        toolName: 'Write',
        input: { file_path: '/repo/new1.txt', content: 'file 1' },
        description: 'new1.txt',
        permissionSuggestions: acceptEdits
      }),
      ctx
    )
    expect(view.title).toBe('Create file')
    expect(view.question).toBe('Do you want to create new1.txt?')
  })
})

describe('WebFetch and MCP', () => {
  test('WebFetch from a subagent: domain row, feedback No (esc), no Tab-to-amend', () => {
    const view = buildPermissionView(
      req({
        toolName: 'WebFetch',
        input: { url: 'https://example.com/?n=1', prompt: 'What is the title?' },
        description: 'https://example.com/?n=1',
        agentId: 'a20fbe83',
        permissionSuggestions: [
          {
            type: 'addRules',
            destination: 'localSettings',
            rules: [{ toolName: 'WebFetch', ruleContent: 'domain:example.com' }],
            behavior: 'allow'
          }
        ]
      }),
      { ...ctx, agentName: 'web-fetch' }
    )
    expect(view.title).toBe('Fetch')
    expect(view.agentLabel).toBe('from the web-fetch agent')
    expect(view.subtitle).toBe('Claude wants to fetch content from example.com')
    expect(view.question).toBe('Do you want to allow Claude to fetch this content?')
    expect(view.options.map((o) => o.label)).toEqual([
      'Yes',
      "Yes, and don't ask again for example.com",
      'No, and tell Claude what to do differently (esc)'
    ])
    expect(view.options[2].needsFeedback).toBe(true)
    expect(view.canAmend).toBe(false)
    expect(view.footer).toBeUndefined()
  })

  test('a subagent prompt whose agent is unknown still says so', () => {
    const view = buildPermissionView(req({ toolName: 'Bash', agentId: 'x' }), ctx)
    expect(view.agentLabel).toBe('from a subagent')
  })

  test('MCP tool: server — tool name, don’t ask again for its commands here', () => {
    const view = buildPermissionView(
      req({
        toolName: 'mcp__spike__echo',
        mcpServer: { name: 'spike', source: 'dynamic' },
        displayName: 'Echo',
        input: { text: 'abc1' },
        permissionSuggestions: [
          {
            type: 'addRules',
            rules: [{ toolName: 'mcp__spike__echo' }],
            behavior: 'allow',
            destination: 'localSettings'
          }
        ]
      }),
      ctx
    )
    expect(view.title).toBe('Tool use')
    expect(view.subtitle).toBe('spike — Echo Tool: (MCP)')
    expect(view.options.map((o) => o.label)).toEqual([
      'Yes',
      "Yes, and don't ask again for spike — Echo commands in /repo",
      'No'
    ])
  })
})

describe('request flags', () => {
  test('suppressAlwaysAllow drops the don’t-ask-again row; defaultToNo preselects No', () => {
    const view = buildPermissionView(
      { ...BASH_PLAIN, suppressAlwaysAllow: true, defaultToNo: true },
      { ...ctx, autoModeAvailable: false }
    )
    expect(view.options.map((o) => o.label)).toEqual(['Yes', 'No'])
    expect(view.defaultIndex).toBe(1)
    expect(buildPermissionView(BASH_PLAIN, ctx).defaultIndex).toBe(0)
  })

  test('an unknown tool gets the generic card', () => {
    const view = buildPermissionView(req({ toolName: 'NotebookEdit', input: { a: 1 } }), ctx)
    expect(view.title).toBe('Tool use')
    expect(view.subtitle).toBe('NotebookEdit')
    expect(view.options.map((o) => o.label)).toEqual(['Yes', 'No'])
  })
})

describe('answers in TUI wording', () => {
  test('Tab-to-amend: deny with the TUI text, turn continues', () => {
    expect(feedbackDenial('use pnpm')).toEqual({
      behavior: 'deny',
      message:
        "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\nuse pnpm"
    })
  })

  test('plan approval rows (auto mode available / not)', () => {
    expect(buildPlanOptions({ autoModeAvailable: true }).map((o) => [o.label, o.decision])).toEqual(
      [
        [
          'Yes, and use auto mode',
          {
            behavior: 'allow',
            updatedPermissions: [{ type: 'setMode', mode: 'auto', destination: 'session' }]
          }
        ],
        ['Yes, manually approve edits', { behavior: 'allow' }],
        ['Tell Claude what to change', null]
      ]
    )
    expect(buildPlanOptions({ autoModeAvailable: false })[0]).toMatchObject({
      label: 'Yes, auto-accept edits',
      decision: {
        behavior: 'allow',
        updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]
      }
    })
  })

  test('AskUserQuestion: answers (+ annotations when any) / decline / clarify', () => {
    const input = { questions: [{ question: 'Color?', header: 'C', options: [] }] }
    expect(questionAnswerDecision(input, { 'Color?': 'Blue' }, {})).toEqual({
      behavior: 'allow',
      updatedInput: { ...input, answers: { 'Color?': 'Blue' } }
    })
    expect(
      questionAnswerDecision(input, { 'Color?': 'Blue' }, { 'Color?': { notes: 'darker' } })
    ).toEqual({
      behavior: 'allow',
      updatedInput: {
        ...input,
        answers: { 'Color?': 'Blue' },
        annotations: { 'Color?': { notes: 'darker' } }
      }
    })
    expect(declineQuestionDecision()).toEqual({ behavior: 'deny', message: REJECT_MESSAGE })
    expect(
      clarifyDecision(
        [{ question: 'Color?' }, { question: 'Size?' }],
        { 'Color?': 'Blue' },
        { 'Size?': 'not sure' }
      )
    ).toEqual({
      behavior: 'deny',
      message:
        'The user wants to clarify these questions.\n    This means they may have additional information, context or questions for you.\n    Take their response into account and then reformulate the questions if appropriate.\n    Start by asking them what they would like to clarify.\n\n    Questions asked:\n- "Color?"\n  Answer: Blue\n- "Size?"\n  (No answer provided)\n  User notes: not sure'
    })
  })
})
