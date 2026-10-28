// @vitest-environment jsdom
// Pins the terminal status button/dialog refresh wiring: they list PTYs on mount
// (dialog: on open) and re-list on every pty.onStateChange event.
import type React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { PtyInfo } from '@slayzone/terminal-contracts'

const subs = new Map<string, Array<(payload: unknown) => unknown>>()
const list = vi.fn<() => Promise<PtyInfo[]>>()
vi.mock('@slayzone/transport/client', () => ({
  useTRPC: () => ({
    pty: {
      onStateChange: {
        subscriptionOptions: (_i: unknown, o: object) => ({ proc: 'onStateChange', ...o })
      },
      onStats: { subscriptionOptions: (_i: unknown, o: object) => ({ proc: 'onStats', ...o }) },
      kill: { mutationOptions: () => ({}) }
    }
  }),
  useTRPCClient: () => ({ pty: { list: { query: list } } }),
  useSubscription: (o: { proc: string; onData: (p: unknown) => unknown }) => {
    const arr = subs.get(o.proc) ?? []
    arr.push(o.onData)
    subs.set(o.proc, arr)
  }
}))
vi.mock('@tanstack/react-query', () => ({ useMutation: () => ({ mutateAsync: vi.fn() }) }))

let terminalsOpen = false
vi.mock('@slayzone/dialogs', () => ({
  useDialogStore: Object.assign(
    (sel: (s: { terminalsOpen: boolean; closeTerminals: () => void }) => unknown) =>
      sel({ terminalsOpen, closeTerminals: vi.fn() }),
    { getState: () => ({ openTerminals: vi.fn() }) }
  )
}))

vi.mock('@slayzone/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@slayzone/ui')>()
  const Pass = ({ children }: { children?: React.ReactNode }) => <>{children}</>
  return {
    useStableCallback: actual.useStableCallback,
    IconButton: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
    getTerminalStateStyle: () => null,
    useStablePoll: () => undefined,
    useNow: actual.useNow,
    Dialog: Pass,
    DialogContent: Pass,
    DialogHeader: Pass,
    DialogTitle: Pass,
    DialogDescription: Pass,
    Tooltip: Pass,
    TooltipTrigger: Pass,
    TooltipContent: () => null
  }
})

const { TerminalStatusButton, TerminalStatusDialog } = await import('./TerminalStatusPopover')

const pty = (sessionId: string, state: PtyInfo['state'] = 'running', createdAt = 0): PtyInfo =>
  ({ sessionId, taskId: sessionId.split(':')[0], state, createdAt }) as PtyInfo

/** Fire the LATEST registered onStateChange handler (last render wins). */
async function stateChange(): Promise<void> {
  const handlers = subs.get('onStateChange') ?? []
  await act(async () => {
    await handlers.at(-1)?.({ sessionId: 'x', newState: 'idle', oldState: 'running' })
  })
}
const flush = (): Promise<void> => act(async () => {})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  subs.clear()
  list.mockReset()
  terminalsOpen = false
})

describe('TerminalStatusButton', () => {
  it('counts PTYs on mount and re-counts on every state change', async () => {
    list.mockResolvedValue([])
    render(<TerminalStatusButton />)
    await flush()
    expect(list).toHaveBeenCalledTimes(1)
    expect(screen.queryByLabelText('Active terminals')).toBeNull()

    list.mockResolvedValue([pty('a:a'), pty('b:b')])
    await stateChange()
    expect(screen.getByLabelText('Active terminals').textContent).toBe('2')

    list.mockResolvedValue([pty('a:a')])
    await stateChange()
    expect(screen.getByLabelText('Active terminals').textContent).toBe('1')
  })
})

describe('TerminalStatusDialog', () => {
  it('lists PTYs when open and re-lists on state changes', async () => {
    terminalsOpen = true
    list.mockResolvedValue([pty('t1:t1')])
    render(
      <TerminalStatusDialog
        tasks={[
          { id: 't1', title: 'Build' },
          { id: 't2', title: 'Docs' }
        ]}
      />
    )
    await flush()
    expect(screen.getByText('Build')).toBeDefined()
    expect(screen.queryByText('Docs')).toBeNull()

    list.mockResolvedValue([pty('t1:t1'), pty('t2:t2')])
    await stateChange()
    expect(screen.getByText('Docs')).toBeDefined()
  })

  it('a session created between clock ticks shows 0s, never a negative age', async () => {
    // The duration clock (useNow) is sampled once per second; a PTY that spawns
    // between two ticks has createdAt AFTER the clock's last sample.
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    const T = 1_000_000
    vi.setSystemTime(T)
    terminalsOpen = true
    list.mockResolvedValue([pty('t1:t1', 'running', T - 5_000)])
    render(
      <TerminalStatusDialog
        tasks={[
          { id: 't1', title: 'Build' },
          { id: 't2', title: 'Docs' }
        ]}
      />
    )
    await flush()
    expect(screen.getByText('5s')).toBeDefined()

    vi.setSystemTime(T + 400) // 400ms into the tick — no clock update yet
    list.mockResolvedValue([pty('t1:t1', 'running', T - 5_000), pty('t2:t2', 'running', T + 400)])
    await stateChange()
    expect(screen.getByText('Docs')).toBeDefined()
    expect(screen.queryByText('-1s')).toBeNull()
    expect(screen.getByText('0s')).toBeDefined()
  })

  it('does not list while closed (state changes still refresh)', async () => {
    list.mockResolvedValue([pty('t1:t1')])
    render(<TerminalStatusDialog tasks={[{ id: 't1', title: 'Build' }]} />)
    await flush()
    expect(list).not.toHaveBeenCalled()
    await stateChange()
    expect(list).toHaveBeenCalledTimes(1)
  })
})
