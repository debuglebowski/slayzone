/**
 * agent-event-handler unit tests
 * Run with: pnpm tsx packages/domains/terminal/src/shared/agent-event-handler.test.ts
 */
import { mapEventType, HOOK_SUPPORTED_AGENT_IDS } from './agent-event-handler.js'

let passed = 0
let failed = 0
function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e}`)
    failed++
  }
}
function expect<T>(v: T) {
  return {
    toBe(e: T) {
      if (v !== e) throw new Error(`expected ${JSON.stringify(e)}, got ${JSON.stringify(v)}`)
    },
  }
}

console.log('\nagent-event-handler\n')

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
  ['random', null],
]

for (const [input, expected] of cases) {
  test(`map "${input}" → ${expected}`, () => expect(mapEventType(input)).toBe(expected))
}

test('HOOK_SUPPORTED_AGENT_IDS contains claude-code', () => {
  expect(HOOK_SUPPORTED_AGENT_IDS.has('claude-code')).toBe(true)
})

test('HOOK_SUPPORTED_AGENT_IDS excludes codex (not yet shipped)', () => {
  expect(HOOK_SUPPORTED_AGENT_IDS.has('codex')).toBe(false)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
