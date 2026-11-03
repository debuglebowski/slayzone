/**
 * Views backed by a computer (git panel, processes, AI config, turns, test panel,
 * usage) answer "connect a computer" until one is there — on the desktop, the few
 * seconds before the local computer enrolls. When a computer connects they refetch,
 * so nothing stays stuck on that state; a disconnect refetches nothing.
 */
import { describe, expect, it } from 'vitest'
import { COMPUTER_BACKED_NAMESPACES, computerConnectRefetcher } from './computer-connect-refetch'

function fakeClient() {
  const invalidated: unknown[] = []
  return {
    invalidated,
    client: {
      invalidateQueries: async (filter: unknown) => {
        invalidated.push(filter)
      }
    }
  }
}

describe('refetch on computer connect', () => {
  it('a connect invalidates every computer-backed namespace', () => {
    const { client, invalidated } = fakeClient()
    const onStatus = computerConnectRefetcher(client, (ns) => [ns])
    onStatus({ computerId: 'c1', connected: true })
    expect(invalidated).toEqual(COMPUTER_BACKED_NAMESPACES.map((ns) => ({ queryKey: [ns] })))
    expect(COMPUTER_BACKED_NAMESPACES).toEqual(
      expect.arrayContaining([
        'worktrees',
        'processes',
        'aiConfig',
        'agentTurns',
        'testPanel',
        'usageAnalytics'
      ])
    )
  })

  it('a disconnect refetches nothing', () => {
    const { client, invalidated } = fakeClient()
    computerConnectRefetcher(client, (ns) => [ns])({ computerId: 'c1', connected: false })
    expect(invalidated).toEqual([])
  })
})
