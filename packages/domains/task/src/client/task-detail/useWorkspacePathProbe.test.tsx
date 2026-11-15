// @vitest-environment jsdom
/**
 * FU5 (computer stalls, request fan-out): every task tab stays mounted, and each one
 * re-asked its computer "does the project folder still exist?" on EVERY window focus —
 * with 60 open tabs, 60 `fs.pathExists` per focus (6,905 in 12 h of the dev request
 * log, bursts of 300 per 10 s). Only the visible tab asks now; a hidden one asks the
 * moment it is shown, so what you see is as fresh as before.
 */
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { useWorkspacePathProbe } from './useWorkspacePathProbe'

afterEach(cleanup)

const focus = () => act(() => void window.dispatchEvent(new Event('focus')))

describe('useWorkspacePathProbe', () => {
  test('60 open tabs, one visible: a window focus is one probe', () => {
    const probe = vi.fn()
    const noRoot = vi.fn()
    for (let i = 0; i < 59; i++)
      renderHook(() => useWorkspacePathProbe('/repo', false, probe, noRoot))
    renderHook(() => useWorkspacePathProbe('/repo', true, probe, noRoot))
    probe.mockClear()
    focus()
    expect(probe).toHaveBeenCalledTimes(1)
  })

  test('a hidden tab probes the moment it is shown, then on focus like any visible one', () => {
    const probe = vi.fn()
    const { rerender } = renderHook(
      ({ active }) => useWorkspacePathProbe('/repo', active, probe, vi.fn()),
      { initialProps: { active: false } }
    )
    expect(probe).not.toHaveBeenCalled()
    focus()
    expect(probe).not.toHaveBeenCalled()
    rerender({ active: true })
    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe).toHaveBeenLastCalledWith('/repo')
    focus()
    expect(probe).toHaveBeenCalledTimes(2)
    rerender({ active: false })
    focus()
    expect(probe).toHaveBeenCalledTimes(2)
  })

  test('a visible tab probes on mount and when its folder changes; no folder = no probe', () => {
    const probe = vi.fn()
    const noRoot = vi.fn()
    const { rerender } = renderHook(
      ({ root }: { root: string | null }) => useWorkspacePathProbe(root, true, probe, noRoot),
      { initialProps: { root: '/a' as string | null } }
    )
    expect(probe).toHaveBeenLastCalledWith('/a')
    rerender({ root: '/b' })
    expect(probe).toHaveBeenLastCalledWith('/b')
    rerender({ root: null })
    expect(noRoot).toHaveBeenCalled()
    probe.mockClear()
    focus()
    expect(probe).not.toHaveBeenCalled()
  })
})
