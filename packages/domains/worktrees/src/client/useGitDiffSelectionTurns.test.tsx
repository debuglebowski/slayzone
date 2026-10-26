// @vitest-environment jsdom
// Pins the self-correcting selection of useGitDiffSelection (always a valid file
// in non-continuous mode) and useGitDiffTurns (vanished turn → "all").
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import type { AgentTurnRange } from '@slayzone/agent-turns/client'
import type { FileEntry } from './GitDiffPanel.types'

let turnsData: AgentTurnRange[] = []
vi.mock('@slayzone/agent-turns/client', () => ({
  useAgentTurns: () => turnsData
}))

const { useGitDiffSelection } = await import('./useGitDiffSelection')
const { useGitDiffTurns } = await import('./useGitDiffTurns')

afterEach(() => {
  cleanup()
  turnsData = []
})

const entry = (path: string, source: FileEntry['source'] = 'unstaged'): FileEntry => ({
  path,
  status: 'M',
  source
})

type SelProps = { flatEntries: FileEntry[]; diffContinuousFlow: boolean }

function renderSelection(initial: SelProps) {
  return renderHook(
    ({ flatEntries, diffContinuousFlow }: SelProps) =>
      useGitDiffSelection({
        flatEntries,
        visibleFlatEntries: flatEntries,
        diffContinuousFlow,
        getDiffForEntry: () => undefined
      }),
    { initialProps: initial }
  )
}

describe('useGitDiffSelection', () => {
  it('auto-selects the first entry on mount', () => {
    const { result } = renderSelection({
      flatEntries: [entry('a.ts', 'staged'), entry('b.ts')],
      diffContinuousFlow: false
    })
    expect(result.current.selectedFile).toEqual({ path: 'a.ts', source: 'staged' })
  })

  it('keeps a still-valid selection and re-picks the first when it vanishes', () => {
    const { result, rerender } = renderSelection({
      flatEntries: [entry('a.ts'), entry('b.ts'), entry('c.ts')],
      diffContinuousFlow: false
    })
    act(() => result.current.handleSelectFile('b.ts', 'unstaged'))
    expect(result.current.selectedFile).toEqual({ path: 'b.ts', source: 'unstaged' })

    rerender({ flatEntries: [entry('c.ts'), entry('b.ts')], diffContinuousFlow: false })
    expect(result.current.selectedFile).toEqual({ path: 'b.ts', source: 'unstaged' })

    rerender({ flatEntries: [entry('c.ts'), entry('d.ts')], diffContinuousFlow: false })
    expect(result.current.selectedFile).toEqual({ path: 'c.ts', source: 'unstaged' })
  })

  it('treats the same path from the other source as a different file', () => {
    const { result, rerender } = renderSelection({
      flatEntries: [entry('a.ts', 'staged')],
      diffContinuousFlow: false
    })
    rerender({ flatEntries: [entry('z.ts'), entry('a.ts', 'unstaged')], diffContinuousFlow: false })
    expect(result.current.selectedFile).toEqual({ path: 'z.ts', source: 'unstaged' })
  })

  it('clears the selection when the list empties, re-picks when it grows', () => {
    const { result, rerender } = renderSelection({
      flatEntries: [entry('a.ts')],
      diffContinuousFlow: false
    })
    rerender({ flatEntries: [], diffContinuousFlow: false })
    expect(result.current.selectedFile).toBeNull()
    rerender({ flatEntries: [entry('n.ts')], diffContinuousFlow: false })
    expect(result.current.selectedFile).toEqual({ path: 'n.ts', source: 'unstaged' })
  })

  it('leaves selection alone in continuous-flow mode, resumes when it is turned off', () => {
    const { result, rerender } = renderSelection({
      flatEntries: [entry('a.ts')],
      diffContinuousFlow: true
    })
    expect(result.current.selectedFile).toBeNull()
    act(() => result.current.handleSelectFile('gone.ts', 'unstaged'))
    rerender({ flatEntries: [], diffContinuousFlow: true })
    expect(result.current.selectedFile).toEqual({ path: 'gone.ts', source: 'unstaged' })

    rerender({ flatEntries: [entry('a.ts')], diffContinuousFlow: false })
    expect(result.current.selectedFile).toEqual({ path: 'a.ts', source: 'unstaged' })
  })
})

const turn = (id: string, sha: string, prev: string | null = null): AgentTurnRange =>
  ({ id, snapshot_sha: sha, prev_snapshot_sha: prev }) as AgentTurnRange

describe('useGitDiffTurns', () => {
  it('falls back to "all" when the selected turn disappears', () => {
    turnsData = [turn('t1', 's1'), turn('t2', 's2', 's1')]
    const { result, rerender } = renderHook(() => useGitDiffTurns('/repo'))
    expect(result.current.selectedTurnId).toBe('all')

    act(() => result.current.setSelectedTurnId('t2'))
    expect(result.current.selectedTurnId).toBe('t2')
    expect(result.current.fromSha).toBe('s1')
    expect(result.current.toSha).toBe('s2')

    turnsData = [turn('t1', 's1'), turn('t2', 's2', 's1'), turn('t3', 's3', 's2')]
    rerender()
    expect(result.current.selectedTurnId).toBe('t2')

    turnsData = [turn('t1', 's1')]
    rerender()
    expect(result.current.selectedTurnId).toBe('all')
    expect(result.current.fromSha).toBeUndefined()
    expect(result.current.toSha).toBeUndefined()
  })

  it('selecting a turn that is not listed snaps back to "all"', () => {
    turnsData = [turn('t1', 's1')]
    const { result } = renderHook(() => useGitDiffTurns('/repo'))
    act(() => result.current.setSelectedTurnId('missing'))
    expect(result.current.selectedTurnId).toBe('all')
  })
})
