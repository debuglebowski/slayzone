import type { TerminalState } from '@slayzone/terminal-contracts'
import { AGENT_GROUP_ORDER, AGENT_GROUP_TITLES, agentGroup, agentStateLabel } from './agent-status'

describe('agentGroup', () => {
  it.each<[TerminalState, boolean, string]>([
    ['starting', false, 'running'],
    ['running', false, 'running'],
    ['background', false, 'running'],
    // The hub clears needs_attention when work resumes; a stale flag never hides work.
    ['running', true, 'running'],
    // A turn the user started has ended: finished, or asking (the hub sets the flag
    // for both; it does not tell them apart).
    ['idle', true, 'waiting'],
    // Seen (the flag was cleared by opening it): nothing to do.
    ['idle', false, 'done'],
    ['dead', false, 'done'],
    ['dead', true, 'done'],
    ['error', false, 'error'],
    ['error', true, 'error'],
    ['hibernated', false, 'hibernated'],
    ['hibernated', true, 'hibernated']
  ])('%s with needs_attention=%s → %s', (state, needsAttention, group) => {
    expect(agentGroup(state, needsAttention)).toBe(group)
  })

  it('orders the groups by what needs the user first', () => {
    expect(AGENT_GROUP_ORDER).toEqual(['waiting', 'error', 'running', 'hibernated', 'done'])
    expect(AGENT_GROUP_TITLES.waiting).toBe('Waiting for you')
  })
})

describe('agentStateLabel', () => {
  it("uses desktop's words for each state", () => {
    expect(agentStateLabel('running')).toBe('Active')
    expect(agentStateLabel('hibernated')).toBe('Paused')
    expect(agentStateLabel('dead')).toBe('Stopped')
  })
})
