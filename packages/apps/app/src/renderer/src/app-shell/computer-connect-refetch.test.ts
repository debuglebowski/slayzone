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
import {
  COMPUTER_BACKED_KEYS,
  COMPUTER_BACKED_QUERIES,
  computerConnectRefetcher
} from './computer-connect-refetch'

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
        'pty.agentsTest',
        // S1: the prompt sidebar and the sessions list read the computer's ledger.
        'agentPrompts',
        'agentSessions'
      ])
    )
    // S1: a task's worktree / custom folder (useTaskPath's own key, not a tRPC one):
    // an offline answer cached before the local computer enrolled must not stick.
    expect(COMPUTER_BACKED_KEYS).toContainEqual(['task-paths'])
    // S6: the worktree colours (useWorktreeColors' own key): a boot-time failure
    // must not leave them neutral until they age out.
    expect(COMPUTER_BACKED_KEYS).toContainEqual(['worktree-colors'])
  })

  it('a connect invalidates every computer-backed query', () => {
    const { client, invalidated } = fakeClient()
    const refetch = computerConnectRefetcher(client, (q) => [q])
    refetch.onData({ computerId: 'c1', connected: true })
    expect(invalidated).toEqual([
      ...COMPUTER_BACKED_QUERIES.map((q) => ({ queryKey: [q] })),
      ...COMPUTER_BACKED_KEYS.map((queryKey) => ({ queryKey }))
    ])
  })

  it('a disconnect refetches nothing', () => {
    const { client, invalidated } = fakeClient()
    computerConnectRefetcher(client, (q) => [q]).onData({ computerId: 'c1', connected: false })
    expect(invalidated).toEqual([])
  })

  it('the subscription starting refetches them too (a connect before it is never sent)', () => {
    const { client, invalidated } = fakeClient()
    computerConnectRefetcher(client, (q) => [q]).onStarted()
    expect(invalidated).toHaveLength(COMPUTER_BACKED_QUERIES.length + COMPUTER_BACKED_KEYS.length)
  })
})
