// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { BackgroundJobsBanner } from './BackgroundJobsBanner'
import type { BgShell } from './chat-timeline'

const START = 1_000_000

function shell(spawnedAt: number): BgShell {
  return {
    spawnToolUseId: 'tu-1',
    shellId: 'bash_1',
    command: 'npm run dev',
    status: 'running',
    exitCode: null,
    spawnedAt,
    lastPolledAt: null,
    latestStdout: '',
    latestStderr: '',
    spawnedInSpawnId: null
  }
}

describe('BackgroundJobsBanner', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(START)
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('ages tick while the job list is expanded', () => {
    const shells = new Map([['tu-1', shell(START - 5_000)]])
    render(<BackgroundJobsBanner shells={shells} order={['tu-1']} />)
    expect(screen.getByText('5s')).toBeTruthy()
    act(() => vi.advanceTimersByTime(3_000))
    expect(screen.getByText('8s')).toBeTruthy()
  })

  it('renders nothing without jobs', () => {
    const { container } = render(<BackgroundJobsBanner shells={new Map()} order={[]} />)
    expect(container.firstChild).toBeNull()
  })
})
