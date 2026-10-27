/**
 * agent-event-handler unit tests
 */
import { expect, test } from 'vitest'
import { mapEventType, HOOK_SUPPORTED_AGENT_IDS } from './agent-event-handler.js'

const cases: Array<[string, ReturnType<typeof mapEventType>]> = [
  // Claude Code canonical names.
  ['SessionStart', 'session-start'],
  ['SessionEnd', 'session-end'],
  ['UserPromptSubmit', 'agent-start'],
  ['PreToolUse', 'agent-start'],
  ['PostToolUse', 'agent-stop'],
  ['PostToolUseFailure', 'agent-stop'],
  ['Stop', 'agent-stop'],
  ['SubagentStop', 'agent-stop'],
  ['Notification', 'permission-request'],
  ['PreCompact', 'agent-stop'],

  // Case variants.
  ['sessionstart', 'session-start'],
  ['SESSIONSTART', 'session-start'],
  ['Session-Start', 'session-start'],
  ['session_start', 'session-start'],

  // Codex / generic.
  ['onStart', 'agent-start'],
  ['onStop', 'agent-stop'],
  ['onSessionStart', 'session-start'],
  ['onSessionEnd', 'session-end'],
  ['before_tool', 'agent-start'],
  ['after_tool', 'agent-stop'],
  ['beforeTool', 'agent-start'],
  ['afterTool', 'agent-stop'],
  ['toolStart', 'agent-start'],
  ['toolEnd', 'agent-stop'],
  ['turnStart', 'agent-start'],
  ['turnEnd', 'agent-stop'],
  ['agent-turn-start', 'agent-start'],
  ['agent-turn-complete', 'agent-stop'],
  ['agent-turn-end', 'agent-stop'],

  // Codex wrapper synthetic + codex native completion types.
  ['Start', 'agent-start'],
  ['task_started', 'agent-start'],
  ['task_complete', 'agent-stop'],
  ['exec_approval_request', 'permission-request'],
  ['apply_patch_approval_request', 'permission-request'],
  ['request_user_input', 'permission-request'],

  // Permission aliases.
  ['permission-request', 'permission-request'],
  ['PermissionRequest', 'permission-request'],
  ['permission-prompt', 'permission-request'],
  ['approval_request', 'permission-request'],
  ['approvalRequest', 'permission-request'],

  // Gemini.
  ['preRequest', 'agent-start'],
  ['post_request', 'agent-stop'],

  // Unknown → null.
  ['', null],
  ['UnknownThing', null],
  ['random', null]
]

for (const [input, expected] of cases) {
  test(`map "${input}" → ${expected}`, () => expect(mapEventType(input)).toBe(expected))
}

const overrideCases: Array<
  [string, Parameters<typeof mapEventType>[1], ReturnType<typeof mapEventType>]
> = [
  ['BeforeAgent', 'gemini', 'agent-start'],
  ['AfterAgent', 'gemini', 'agent-stop'],
  ['AfterTool', 'gemini', 'agent-start'],
  ['after_tool', 'gemini', 'agent-start'],
  ['SessionStart', 'gemini', 'session-start'],
  ['SessionEnd', 'gemini', 'session-end'],
  ['after_tool', 'codex', 'agent-stop'],
  ['AfterTool', 'codex', 'agent-stop'],
  ['Stop', 'claude-code', 'agent-stop']
]

for (const [input, agentId, expected] of overrideCases) {
  test(`map "${input}" (${agentId}) → ${expected}`, () =>
    expect(mapEventType(input, agentId)).toBe(expected))
}

test('HOOK_SUPPORTED_AGENT_IDS contains claude-code', () => {
  expect(HOOK_SUPPORTED_AGENT_IDS.has('claude-code')).toBe(true)
})

test('HOOK_SUPPORTED_AGENT_IDS contains codex', () => {
  expect(HOOK_SUPPORTED_AGENT_IDS.has('codex')).toBe(true)
})

test('HOOK_SUPPORTED_AGENT_IDS contains gemini', () => {
  expect(HOOK_SUPPORTED_AGENT_IDS.has('gemini')).toBe(true)
})
