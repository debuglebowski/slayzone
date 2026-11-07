/**
 * Views backed by a computer (git panel, processes, AI config, turns, test panel,
 * usage, the file editor and workspace picker, terminal settings probes) answer
 * "connect a computer" until one is there — on the desktop, the seconds before the
 * local computer enrolls. When a computer connects they refetch, so nothing stays
 * stuck on that state; a disconnect refetches nothing. `onStatusChange` sends no
 * snapshot, so a connect that landed before the subscription started is caught by
 * refetching once it starts.
 */
import { describe, expect, it } from 'vitest'
import { COMPUTER_BACKED_QUERIES, computerConnectRefetcher } from './computer-connect-refetch'

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
  it('covers every view that refuses without a computer', () => {
    expect(COMPUTER_BACKED_QUERIES).toEqual(
      expect.arrayContaining([
        'worktrees',
        'processes',
        'aiConfig',
        'agentTurns',
        'testPanel',
        'usageAnalytics',
        'fileEditor',
        'workspace',
        'pty.testExecutionContext',
        'pty.agentsTest'
      ])
    )
  })

  it('a connect invalidates every computer-backed query', () => {
    const { client, invalidated } = fakeClient()
    const refetch = computerConnectRefetcher(client, (q) => [q])
    refetch.onData({ computerId: 'c1', connected: true })
    expect(invalidated).toEqual(COMPUTER_BACKED_QUERIES.map((q) => ({ queryKey: [q] })))
  })

  it('a disconnect refetches nothing', () => {
    const { client, invalidated } = fakeClient()
    computerConnectRefetcher(client, (q) => [q]).onData({ computerId: 'c1', connected: false })
    expect(invalidated).toEqual([])
  })

  it('the subscription starting refetches them too (a connect before it is never sent)', () => {
    const { client, invalidated } = fakeClient()
    computerConnectRefetcher(client, (q) => [q]).onStarted()
    expect(invalidated).toHaveLength(COMPUTER_BACKED_QUERIES.length)
  })
})
