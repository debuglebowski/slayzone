/**
 * Which `system/hook_response` frames reach the chat timeline. Shapes recorded
 * from Claude Code 2.1.312 with `--include-hook-events` (fixture
 * `chatui-hooks.ndjson`); JSON-decision cases follow the CLI's hook output spec.
 */
import { describe, expect, test } from 'vitest'
import { classifyClaudeHookResponse } from './claude-hook-output'

const response = (over: Record<string, unknown>): Record<string, unknown> => ({
  type: 'system',
  subtype: 'hook_response',
  hook_id: 'h1',
  hook_name: 'PreToolUse:Bash',
  hook_event: 'PreToolUse',
  output: '',
  stdout: '',
  stderr: '',
  exit_code: 0,
  outcome: 'success',
  uuid: 'u1',
  session_id: 's1',
  ...over
})

describe('quiet hooks stay out of the timeline', () => {
  test('success with `{}` (SlayZone notify.sh) or nothing', () => {
    expect(classifyClaudeHookResponse(response({ stdout: '{}\n', output: '{}\n' }))).toBe(null)
    expect(classifyClaudeHookResponse(response({}))).toBe(null)
  })

  test('plain stdout of a tool hook is transcript-only, not shown to Claude', () => {
    expect(
      classifyClaudeHookResponse(
        response({ stdout: 'pre hook stdout\n', output: 'pre hook stdout\n' })
      )
    ).toBe(null)
  })

  test('a systemMessage is left to its own system/informational frame', () => {
    const out = '{"systemMessage":"Formatter ran on 0 files"}\n'
    expect(
      classifyClaudeHookResponse(
        response({
          hook_name: 'PostToolUse:Bash',
          hook_event: 'PostToolUse',
          stdout: out,
          output: out
        })
      )
    ).toBe(null)
  })

  test('unknown outcomes are not guessed at', () => {
    expect(classifyClaudeHookResponse(response({ outcome: 'something-new' }))).toBe(null)
  })
})

describe('hooks that change what happens', () => {
  test('exit 2 blocks the tool; its stderr is sent to Claude', () => {
    const stderr = 'Blocked by policy: never echo the word forbidden\n'
    expect(
      classifyClaudeHookResponse(
        response({ outcome: 'error', exit_code: 2, stderr, output: stderr })
      )
    ).toEqual({
      kind: 'hook-output',
      hookId: 'h1',
      hookName: 'PreToolUse:Bash',
      hookEvent: 'PreToolUse',
      effect: 'blocked',
      audience: 'agent',
      text: 'Blocked by policy: never echo the word forbidden',
      exitCode: 2
    })
  })

  test('a blocked prompt (UserPromptSubmit) is only shown to the user', () => {
    expect(
      classifyClaudeHookResponse(
        response({
          hook_name: 'UserPromptSubmit',
          hook_event: 'UserPromptSubmit',
          outcome: 'blocking',
          exit_code: 2,
          stderr: 'No secrets in prompts'
        })
      )
    ).toMatchObject({ effect: 'blocked', audience: 'user', text: 'No secrets in prompts' })
  })

  test('another non-zero exit is a failed hook, shown to the user', () => {
    const stderr = 'post hook crashed: lint server unreachable\n'
    expect(
      classifyClaudeHookResponse(
        response({
          hook_name: 'PostToolUse:Bash',
          hook_event: 'PostToolUse',
          outcome: 'error',
          exit_code: 1,
          stderr,
          output: stderr
        })
      )
    ).toMatchObject({
      effect: 'failed',
      audience: 'user',
      text: 'post hook crashed: lint server unreachable',
      exitCode: 1
    })
    expect(
      classifyClaudeHookResponse(response({ outcome: 'non_blocking_error', exit_code: 127 }))
    ).toMatchObject({ effect: 'failed', exitCode: 127 })
  })

  test('a timed-out hook is cancelled', () => {
    expect(
      classifyClaudeHookResponse(
        response({ hook_name: 'Stop', hook_event: 'Stop', outcome: 'cancelled', exit_code: 1 })
      )
    ).toMatchObject({ effect: 'cancelled', audience: 'user', text: '', hookName: 'Stop' })
  })

  test('JSON decision:block (PostToolUse / Stop) — the reason goes to Claude', () => {
    const out = '{"decision":"block","reason":"Run the tests before stopping"}'
    expect(
      classifyClaudeHookResponse(response({ hook_name: 'Stop', hook_event: 'Stop', stdout: out }))
    ).toMatchObject({ effect: 'blocked', audience: 'agent', text: 'Run the tests before stopping' })
  })

  test('JSON permissionDecision deny (PreToolUse) — the reason goes to Claude', () => {
    const out = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'use printf'
      }
    })
    expect(classifyClaudeHookResponse(response({ stdout: out }))).toMatchObject({
      effect: 'blocked',
      audience: 'agent',
      text: 'use printf'
    })
  })

  test('JSON continue:false stops Claude; the stopReason is for the user', () => {
    const out = '{"continue":false,"stopReason":"Budget reached"}'
    expect(classifyClaudeHookResponse(response({ stdout: out }))).toMatchObject({
      effect: 'stopped',
      audience: 'user',
      text: 'Budget reached'
    })
  })
})

describe('hooks that tell Claude something', () => {
  test('plain stdout of SessionStart / UserPromptSubmit becomes context for Claude', () => {
    const stdout = 'Project rule from the SessionStart hook: prefer printf over echo.\n'
    expect(
      classifyClaudeHookResponse(
        response({
          hook_name: 'SessionStart:startup',
          hook_event: 'SessionStart',
          stdout,
          output: stdout
        })
      )
    ).toEqual({
      kind: 'hook-output',
      hookId: 'h1',
      hookName: 'SessionStart:startup',
      hookEvent: 'SessionStart',
      effect: 'context',
      audience: 'agent',
      text: 'Project rule from the SessionStart hook: prefer printf over echo.',
      exitCode: 0
    })
  })

  test('JSON additionalContext becomes context for Claude', () => {
    const out =
      '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"the user prefers short replies."}}\n'
    expect(
      classifyClaudeHookResponse(
        response({ hook_name: 'UserPromptSubmit', hook_event: 'UserPromptSubmit', stdout: out })
      )
    ).toMatchObject({
      effect: 'context',
      audience: 'agent',
      text: 'the user prefers short replies.'
    })
  })
})
