/**
 * What the dead-session overlay says. The exit code alone hid WHY a session
 * ended — 39 tabs showed a bare "exited with code -1" on 2026-10-23 when the
 * hub had given up on them, not the agents.
 * Run with: pnpm tsx packages/domains/terminal/src/client/exit-description.test.ts
 */
import { describeExit } from './exit-description'

let passed = 0
let failed = 0
function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗ ${name}\n    ${(e as Error).message}`)
    failed++
  }
}
function eq(actual: unknown, expected: unknown): void {
  if (actual !== expected)
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

test('a known reason replaces the bare code', () => {
  eq(
    describeExit(0, 'startup-timeout'),
    'The agent printed nothing while starting and was stopped.'
  )
  eq(describeExit(1, 'computer-restarted'), 'The computer running this agent restarted.')
  eq(describeExit(1, 'spawn-failed'), "The computer couldn't start the agent.")
  eq(describeExit(1, 'reattach-timeout'), 'Lost contact with the computer running this agent.')
  eq(
    describeExit(1, 'exited-while-detached'),
    'The agent exited while its computer was unreachable.'
  )
  eq(describeExit(-1, 'no-response'), 'No response from the agent while it was starting.')
})

test('no reason (or an unknown one) keeps the exit code line', () => {
  eq(describeExit(7, null), 'Process exited with code 7')
  eq(describeExit(7, 'something-new'), 'Process exited with code 7')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
