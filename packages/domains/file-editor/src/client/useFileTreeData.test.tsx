// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { createTrpcTest } from '@slayzone/transport/testing'
import { useFileTreeData } from './useFileTreeData'
import { createElement } from 'react'
import { WorkspaceTargetProvider } from './workspace-target'

/** The trpc test wrapper inside a project panel's path scope (every call names one). */
function scopedWrapper(
  base: (props: { children: ReactNode }) => ReactNode
): (props: { children: ReactNode }) => ReactNode {
  return ({ children }) =>
    createElement(
      base,
      null,
      createElement(WorkspaceTargetProvider, { target: { projectId: 'p1' }, children })
    )
}

type GitResult = { isGitRepo: boolean; files: Record<string, string> }

let git: GitResult
let wrapper: (props: { children: ReactNode }) => ReactNode

beforeEach(() => {
  vi.useFakeTimers()
  git = { isGitRepo: true, files: { 'src/a.ts': 'modified', 'src/deep/b.ts': 'untracked' } }
  wrapper = createTrpcTest({
    procedures: {
      'fileEditor.gitStatus': () => git,
      'fileEditor.readDir': () => []
    },
    subscriptions: { 'fileEditor.watch': () => () => undefined }
  }).wrapper
  wrapper = scopedWrapper(wrapper)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
    await vi.advanceTimersByTimeAsync(0)
  })
}

describe('useFileTreeData git status', () => {
  it('mirrors repo results; a non-repo result keeps the previous map', async () => {
    const { result, rerender } = renderHook(
      ({ refreshKey }: { refreshKey: number }) =>
        useFileTreeData({ projectPath: '/proj', refreshKey }),
      { initialProps: { refreshKey: 0 }, wrapper }
    )
    expect(result.current.gitStatus.size).toBe(0)
    await flush()
    expect(Object.fromEntries(result.current.gitStatus)).toEqual(git.files)
    expect(result.current.dirGitStatus.get('src')).toBeDefined()
    expect(result.current.dirGitStatus.get('src/deep')).toBe('untracked')
    const before = result.current.gitStatus

    git = { isGitRepo: false, files: {} }
    rerender({ refreshKey: 1 })
    await flush()
    expect(result.current.gitStatus).toBe(before)

    git = { isGitRepo: true, files: { 'c.ts': 'staged' } }
    rerender({ refreshKey: 2 })
    await flush()
    expect(Object.fromEntries(result.current.gitStatus)).toEqual({ 'c.ts': 'staged' })

    // Same result refetched → structurally shared → the map is not rebuilt.
    const same = result.current.gitStatus
    rerender({ refreshKey: 3 })
    await flush()
    expect(result.current.gitStatus).toBe(same)
  })
})

it('coalesces watcher changes into reads of the affected directories only', async () => {
  const readDir = vi.fn(() => [])
  const listeners = new Set<(data: unknown) => void>()
  const backend = createTrpcTest({
    procedures: { 'fileEditor.gitStatus': () => git, 'fileEditor.readDir': readDir },
    subscriptions: {
      'fileEditor.watch': (_input, push) => {
        listeners.add(push)
        return () => listeners.delete(push)
      }
    }
  })
  const folders = new Set(['src', 'docs', 'vendor'])
  renderHook(() => useFileTreeData({ projectPath: '/proj', controlledExpanded: folders }), {
    wrapper: scopedWrapper(backend.wrapper)
  })
  await flush()
  readDir.mockClear()
  await act(async () => {
    for (const push of listeners) {
      push({ type: 'changed', root: '/proj', relPath: 'src/a.ts' })
      push({ type: 'deleted', root: '/proj', relPath: 'docs/b.md' })
    }
    await vi.advanceTimersByTimeAsync(100)
  })
  expect(readDir.mock.calls).toEqual([
    [expect.objectContaining({ dirPath: 'src' })],
    [expect.objectContaining({ dirPath: 'docs' })]
  ])
})

it('loads a folder that becomes expanded without its contents (a renamed or moved folder)', async () => {
  const readDir = vi.fn((input: { dirPath: string }) =>
    input.dirPath === 'newname' ? [{ name: 'sub', path: 'newname/sub', type: 'directory' }] : []
  )
  const backend = createTrpcTest({
    procedures: { 'fileEditor.gitStatus': () => git, 'fileEditor.readDir': readDir },
    subscriptions: { 'fileEditor.watch': () => () => undefined }
  })
  const { result, rerender } = renderHook(
    ({ expanded }: { expanded: Set<string> }) =>
      useFileTreeData({ projectPath: '/proj', controlledExpanded: expanded }),
    { initialProps: { expanded: new Set(['oldname']) }, wrapper: scopedWrapper(backend.wrapper) }
  )
  await flush()
  readDir.mockClear()

  // What a rename of `oldname` → `newname` does to the expanded set.
  rerender({ expanded: new Set(['newname']) })
  await flush()

  expect(readDir.mock.calls).toEqual([[expect.objectContaining({ dirPath: 'newname' })]])
  expect(result.current.dirContents.get('newname')?.map((e) => e.path)).toEqual(['newname/sub'])
})
