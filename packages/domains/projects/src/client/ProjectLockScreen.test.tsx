// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { Project } from '@slayzone/projects-contracts'
import { ProjectLockScreen } from './ProjectLockScreen'
import { clearLockOverrides, isProjectDurationLocked } from './useProjectLockGuard'

const START = new Date('2026-10-26T12:00:00.000Z').getTime()

type Schedule = { from: string; to: string }

function project(lockedUntil: string | null, schedule: Schedule | null = null): Project {
  return {
    id: 'p-lock',
    name: 'Locky',
    lock_config: { locked_until: lockedUntil, rate_limit: null, schedule }
  } as unknown as Project
}

describe('ProjectLockScreen', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(START)
  })
  afterEach(() => {
    cleanup()
    clearLockOverrides('p-lock')
    vi.useRealTimers()
  })

  it('counts down a duration lock', () => {
    const until = new Date(START + 3_000).toISOString()
    render(<ProjectLockScreen project={project(until)} lockedUntil={until} onUnlocked={vi.fn()} />)
    expect(screen.getByText('00:03')).toBeTruthy()
    act(() => vi.advanceTimersByTime(1_000))
    expect(screen.getByText('00:02')).toBeTruthy()
  })

  it('auto-unlocks once when the duration countdown reaches zero', () => {
    const until = new Date(START + 2_500).toISOString()
    const p = project(until)
    const onUnlocked = vi.fn()
    render(<ProjectLockScreen project={p} lockedUntil={until} onUnlocked={onUnlocked} />)
    // One tick per act — React re-renders between timer tasks, as in the app.
    for (let i = 0; i < 5; i++) act(() => vi.advanceTimersByTime(1_000))
    expect(onUnlocked).toHaveBeenCalledTimes(1)
    expect(onUnlocked).toHaveBeenCalledWith(p)
    expect(isProjectDurationLocked(p)).toBe(false)
  })

  it('schedule lock shows the end time and no countdown', () => {
    const schedule = { from: '00:00', to: '23:59' }
    const p = project(null, schedule)
    const onUnlocked = vi.fn()
    render(
      <ProjectLockScreen
        project={p}
        lockedUntil={null}
        schedule={schedule}
        onUnlocked={onUnlocked}
      />
    )
    expect(screen.getByText('Available at 23:59')).toBeTruthy()
    expect(screen.queryByText(/^\d\d:\d\d$/)).toBeNull()
    expect(onUnlocked).not.toHaveBeenCalled()
  })
})
