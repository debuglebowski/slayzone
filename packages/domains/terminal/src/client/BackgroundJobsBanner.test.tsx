// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { BackgroundJobsBanner } from './BackgroundJobsBanner'
import type { BgShell } from '../shared/chat-timeline'

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
    render(<BackgroundJobsBanner shells={shells} order={['tu-1']} defaultCollapsed={false} />)
    expect(screen.getByText('5s')).toBeTruthy()
    act(() => vi.advanceTimersByTime(3_000))
    expect(screen.getByText('8s')).toBeTruthy()
  })

  it('renders nothing without jobs', () => {
    const { container } = render(<BackgroundJobsBanner shells={new Map()} order={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('starts compact, expands active commands, and hides finished jobs', () => {
    const finished = {
      ...shell(START),
      spawnToolUseId: 'done',
      shellId: 'exec-long-uuid',
      command: 'pnpm build',
      status: 'completed' as const
    }
    const stop = vi.fn()
    render(
      <BackgroundJobsBanner
        shells={
          new Map([
            ['done', finished],
            ['tu-1', shell(START)]
          ])
        }
        order={['done', 'tu-1']}
        onStop={stop}
      />
    )
    const toggle = screen.getByRole('button', { name: '1 job running' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('npm run dev')).toBeNull()
    fireEvent.click(toggle)
    expect(screen.getByText('npm run dev')).toBeTruthy()
    expect(screen.queryByText('exec-long-uuid')).toBeNull()
    expect(screen.queryByText('pnpm build')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Stop background job npm run dev' }))
    expect(stop).toHaveBeenCalledWith(shell(START))
    expect(screen.getAllByRole('button', { name: /Stop background job/ })).toHaveLength(1)
    fireEvent.click(toggle)
    expect(screen.queryByText('npm run dev')).toBeNull()
  })
  it.each(['completed', 'killed', 'failed', 'unknown'] as const)(
    'disappears when the last active job becomes %s',
    (status) => {
      const job = shell(START)
      const { container, rerender } = render(
        <BackgroundJobsBanner shells={new Map([['tu-1', job]])} order={['tu-1']} />
      )
      expect(screen.getByRole('button', { name: '1 job running' })).toBeTruthy()
      rerender(
        <BackgroundJobsBanner shells={new Map([['tu-1', { ...job, status }]])} order={['tu-1']} />
      )
      expect(container.firstChild).toBeNull()
    }
  )
})
