// @vitest-environment jsdom
// The path guard runs in the app shell, under the DEFAULT hub's client. A project
// that another hub owns (multi-hub federation) must be checked and fixed on THAT
// hub: the default hub does not know it, and sent its folder to this machine's
// computer, which refused it ("path '/home/…' is outside the computer's
// allowedRoots", 2026-11-11).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { Project } from '@slayzone/projects-contracts'

const calls: Array<[string, string, unknown]> = []
const clientNamed = (name: string) => ({
  workspace: {
    pathExists: {
      query: async (input: unknown) => {
        calls.push([name, 'pathExists', input])
        return { reachable: true, exists: true }
      }
    }
  },
  projects: {
    update: {
      mutate: async (input: { id: string; path: string }) => {
        calls.push([name, 'projects.update', input])
        return project(input.id, input.path)
      }
    }
  }
})
const local = clientNamed('local')
const remote = clientNamed('remote')

vi.mock('../trpc', () => ({
  useTRPCClient: () => local,
  getClientForHub: (hubId: string | undefined, fallback: unknown) =>
    hubId === 'remote' ? remote : fallback
}))
vi.mock('@slayzone/transport/client', () => ({
  getHubIdForProject: (id: string | undefined) => (id === 'R' ? 'remote' : undefined)
}))

const { useProjectPathGuard } = await import('./useProjectPathGuard')

function project(id: string, path: string): Project {
  return {
    id,
    name: id,
    placements: [{ computer_id: 'c1', path, status: 'ready' }],
    resolved_computer_id: 'c1'
  } as unknown as Project
}

// Stable arrays: the hook re-checks on every new `projects` identity.
const REMOTE_PROJECTS = [project('R', '/home/remote/dummy')]
const LOCAL_PROJECTS = [project('L', '/Users/me/l')]
const noop = () => {}

const flush = () => act(async () => await new Promise((r) => setTimeout(r, 0)))

afterEach(() => {
  cleanup()
  calls.length = 0
})

describe("the project path guard asks the project's own hub", () => {
  it("another hub's project: checked on that hub, not the default one", async () => {
    renderHook(() => useProjectPathGuard('R', REMOTE_PROJECTS, noop))
    await flush()
    expect(calls).toEqual([
      ['remote', 'pathExists', { projectId: 'R', path: '/home/remote/dummy' }]
    ])
  })

  it("another hub's project: a fixed folder is saved on that hub", async () => {
    const { result } = renderHook(() => useProjectPathGuard('R', REMOTE_PROJECTS, noop))
    await flush()
    calls.length = 0
    await act(async () => await result.current.applyFixedPath('/home/remote/other'))
    expect(calls[0]).toEqual(['remote', 'projects.update', { id: 'R', path: '/home/remote/other' }])
    expect(calls.every(([hub]) => hub === 'remote')).toBe(true)
  })

  it("the default hub's project stays on the default hub", async () => {
    renderHook(() => useProjectPathGuard('L', LOCAL_PROJECTS, noop))
    await flush()
    expect(calls).toEqual([['local', 'pathExists', { projectId: 'L', path: '/Users/me/l' }]])
  })
})
