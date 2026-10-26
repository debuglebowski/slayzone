// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { createTrpcTest } from '@slayzone/transport/testing'
import { useFileTreeData } from './useFileTreeData'

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
