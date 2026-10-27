/**
 * What the dead-session overlay says. The exit code alone hid WHY a session
 * ended — 39 tabs showed a bare "exited with code -1" on 2026-10-23 when the
 * hub had given up on them, not the agents.
 */
import { expect, test } from 'vitest'
import { describeExit } from './exit-description'

test('a known reason replaces the bare code', () => {
  expect(describeExit(0, 'startup-timeout')).toBe(
    'The agent printed nothing while starting and was stopped.'
  )
  expect(describeExit(1, 'computer-restarted')).toBe('The computer running this agent restarted.')
  expect(describeExit(1, 'spawn-failed')).toBe("The computer couldn't start the agent.")
  expect(describeExit(1, 'reattach-timeout')).toBe(
    'Lost contact with the computer running this agent.'
  )
  expect(describeExit(1, 'exited-while-detached')).toBe(
    'The agent exited while its computer was unreachable.'
  )
  expect(describeExit(-1, 'no-response')).toBe('No response from the agent while it was starting.')
})

test('no reason (or an unknown one) keeps the exit code line', () => {
  expect(describeExit(7, null)).toBe('Process exited with code 7')
  expect(describeExit(7, 'something-new')).toBe('Process exited with code 7')
})
