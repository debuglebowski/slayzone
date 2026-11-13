// @vitest-environment jsdom
// Stale-skill counts are read from each project's folder, on the hub that OWNS the
// project (multi-hub federation). Both hooks run in the app shell / sidebar under the
// default hub's client; the sidebar lists every hub's projects. A project another hub
// owns sent to the default hub is unknown there — its count must come from its own hub.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'

const calls: Array<[string, string, unknown]> = []
const clientNamed = (name: string, base: number) => ({
  aiConfig: {
    getProjectsStaleSkillCounts: {
      query: async (batch: Array<{ projectId: string }>) => {
        calls.push([name, 'counts', batch])
        return Object.fromEntries(batch.map((p, i) => [p.projectId, base + i]))
      }
    },
    getProjectStaleSkillCount: {
      query: async (input: unknown) => {
        calls.push([name, 'count', input])
        return base
      }
    }
  }
})
const local = clientNamed('local', 1)
const remote = clientNamed('remote', 10)

vi.mock('./trpc', () => ({
  useTRPCClient: () => local,
  getClientForHub: (hubId: string | undefined, fallback: unknown) =>
    hubId === 'remote' ? remote : fallback
}))
vi.mock('@slayzone/transport/client', () => ({
  getHubIdForProject: (id: string | undefined) => (id === 'R' ? 'remote' : undefined)
}))

const { useStaleSkillCounts } = await import('./useStaleSkillCounts')
const { useStaleSkillCount } = await import('./useStaleSkillCount')

const at = (id: string, path: string) => ({
  id,
  placements: [{ computer_id: 'c1', path, status: 'ready' as const }],
  resolved_computer_id: 'c1'
})
const PROJECTS = [at('L', '/Users/me/l'), at('R', '/home/remote/r')] as never

const flush = () => act(async () => await new Promise((r) => setTimeout(r, 0)))

afterEach(() => {
  cleanup()
  calls.length = 0
})

describe('stale-skill counts come from the hub that owns each project', () => {
  it('the sidebar batch is split by hub; counts are merged', async () => {
    const { result } = renderHook(() => useStaleSkillCounts(PROJECTS))
    await flush()
    expect(calls).toEqual(
      expect.arrayContaining([
        ['local', 'counts', [{ projectId: 'L', projectPath: '/Users/me/l' }]],
        ['remote', 'counts', [{ projectId: 'R', projectPath: '/home/remote/r' }]]
      ])
    )
    expect(calls).toHaveLength(2)
    expect(Object.fromEntries(result.current.counts)).toEqual({ L: 1, R: 10 })
  })

  it("the selected project's count: another hub's project asks that hub", async () => {
    const { result } = renderHook(() => useStaleSkillCount('R', '/home/remote/r'))
    await flush()
    expect(calls).toEqual([['remote', 'count', { projectId: 'R', projectPath: '/home/remote/r' }]])
    expect(result.current.count).toBe(10)
  })
})
