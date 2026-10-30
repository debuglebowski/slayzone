// @vitest-environment jsdom
/**
 * The Bash card (plan 3.2 / 3.9): the command as it streams, a running timer,
 * the live output of a command the CLI runs as a task (polled only while it
 * runs), background state, Move to background / Stop, the final output.
 */
import type React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { CommandTaskOutput } from '@slayzone/terminal-contracts'
import type { CommandTaskView, ToolInvocation } from '@slayzone/terminal/client'

const polled: Array<{ taskId: string | undefined; running: boolean }> = []
let pollAnswer: CommandTaskOutput | undefined
const stop = vi.fn()
const background = vi.fn()

vi.mock('./command-task-hooks', async () => {
  const { createContext } = await import('react')
  return {
    CommandTaskContext: createContext(null),
    useCommandTaskOutput: (taskId: string | undefined, running: boolean) => {
      polled.push({ taskId, running })
      return running ? pollAnswer : undefined
    },
    useCommandTaskActions: () => ({ stop, background, pending: false })
  }
})
vi.mock('@slayzone/markdown/client', () => ({
  GhMarkdown: ({ children }: { children?: React.ReactNode }) => <>{children}</>
}))
vi.mock('../../trpc', () => ({
  useTRPCClient: () => ({
    app: { shell: { openPath: { mutate: vi.fn() }, openExternal: { mutate: vi.fn() } } }
  })
}))

const { BashCard } = await import('./BashCard')

const NOW = 1_000_000
const invocation = (
  over: Partial<ToolInvocation> = {},
  task?: Partial<CommandTaskView>
): ToolInvocation => ({
  id: 'toolu_1',
  name: 'Bash',
  input: { command: 'for i in 1 2 3; do echo tick $i; done', description: 'Ticks' },
  status: 'pending',
  ...(task
    ? {
        task: {
          taskId: 't1',
          status: 'running',
          backgrounded: false,
          startedAt: NOW - 3_000,
          ...task
        }
      }
    : {}),
  ...over
})
const show = (inv: ToolInvocation, timestamp = NOW) =>
  render(<BashCard invocation={inv} timestamp={timestamp} />)
const card = () => screen.getByTestId('tool-bash')

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false })
  vi.setSystemTime(NOW)
  polled.length = 0
  pollAnswer = undefined
  stop.mockReset()
  background.mockReset()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('Bash card', () => {
  it('a command still streaming / not yet a task: the command, a timer, nothing polled', () => {
    show(invocation({ input: { command: 'ls -la' } }), NOW - 2_000)
    expect(screen.getByTestId('bash-command').textContent).toBe('ls -la')
    expect(card().getAttribute('data-task-state')).toBe(null)
    expect(screen.getByTestId('bash-elapsed').textContent).toBe('2s')
    expect(screen.queryByTestId('bash-live-output')).toBe(null)
    expect(polled).toEqual([])
  })

  it('a running foreground task: live output, timer from its start, Move to background', () => {
    pollAnswer = { state: 'running', output: 'tick 1\ntick 2\n', totalBytes: 14, truncated: false }
    show(invocation({}, {}))
    expect(card().getAttribute('data-task-state')).toBe('running')
    expect(polled.at(-1)).toEqual({ taskId: 't1', running: true })
    expect(screen.getByTestId('bash-live-output').textContent).toContain('tick 2')
    expect(screen.getByTestId('bash-elapsed').textContent).toBe('3s')
    act(() => {
      vi.advanceTimersByTime(2_000)
    })
    expect(screen.getByTestId('bash-elapsed').textContent).toBe('5s')
    fireEvent.click(screen.getByRole('button', { name: 'Move to background' }))
    expect(background).toHaveBeenCalledWith('toolu_1')
    expect(screen.queryByRole('button', { name: 'Stop command' })).toBe(null)
  })

  it('a long output says it shows only the tail', () => {
    pollAnswer = {
      state: 'running',
      output: 'x'.repeat(10),
      totalBytes: 2_500_000,
      truncated: true
    }
    show(invocation({}, {}))
    expect(card().textContent).toMatch(/last 8 KB of 2\.4 MB/)
  })

  it('a background task: badge, live output after its turn, Stop', () => {
    pollAnswer = { state: 'running', output: 'serving\n', totalBytes: 8, truncated: false }
    show(
      invocation(
        {
          status: 'done',
          result: {
            rawContent: 'Command running in background with ID: t1. Output is being written to: /x',
            structured: null,
            isError: false
          }
        },
        { backgrounded: true }
      )
    )
    expect(card().getAttribute('data-task-state')).toBe('background')
    expect(card().textContent).toContain('Background')
    expect(screen.getByTestId('bash-live-output').textContent).toContain('serving')
    fireEvent.click(screen.getByRole('button', { name: 'Stop command' }))
    expect(stop).toHaveBeenCalledWith('t1')
    expect(screen.queryByRole('button', { name: 'Move to background' })).toBe(null)
  })

  it('a finished foreground command: the tool result is the output; polling stops', () => {
    show(
      invocation(
        {
          status: 'done',
          result: { rawContent: 'tick 1\ntick 2\ntick 3', structured: null, isError: false }
        },
        { status: 'completed', endedAt: NOW - 1_000 }
      )
    )
    expect(card().getAttribute('data-task-state')).toBe('exited')
    expect(screen.getByTestId('bash-output').textContent).toContain('tick 3')
    expect(screen.queryByTestId('bash-live-output')).toBe(null)
    expect(screen.queryByTestId('bash-elapsed')).toBe(null)
    expect(screen.getByTestId('bash-duration').textContent).toBe('ran 2s')
    expect(polled.some((p) => p.running)).toBe(false)
  })

  it('a finished background command shows its saved final output', () => {
    show(
      invocation(
        {
          status: 'done',
          result: {
            rawContent: 'Command running in background with ID: t1.',
            structured: null,
            isError: false
          }
        },
        {
          backgrounded: true,
          status: 'completed',
          finalOutput: {
            output: 'tick 1\n\n[exited with code 0]\n',
            totalBytes: 29,
            truncated: false
          }
        }
      )
    )
    expect(card().getAttribute('data-task-state')).toBe('exited')
    expect(screen.getByTestId('bash-output').textContent).toContain('[exited with code 0]')
  })

  it('a stopped command reads stopped', () => {
    show(invocation({ status: 'done' }, { backgrounded: true, status: 'killed' }))
    expect(card().getAttribute('data-task-state')).toBe('stopped')
    expect(screen.queryByRole('button', { name: 'Stop command' })).toBe(null)
  })

  it('a quick command (never a task) shows its result as before', () => {
    show(
      invocation({
        input: { command: 'echo hi' },
        status: 'done',
        result: { rawContent: 'hi', structured: null, isError: false }
      })
    )
    expect(card().getAttribute('data-task-state')).toBe(null)
    expect(screen.getByTestId('bash-output').textContent).toBe('hi')
    expect(screen.queryByTestId('bash-elapsed')).toBe(null)
  })
})
