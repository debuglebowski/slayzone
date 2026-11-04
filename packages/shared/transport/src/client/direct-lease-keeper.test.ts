/**
 * keepDirectLease: hold one direct-link lease for a target while wanted — acquire,
 * hand it over, take it back when lost, try again (at once on a computer reconnect
 * or a wake, after `retryMs` on a relay answer). Shared by desktop and mobile.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { keepDirectLease } from './direct-lease-keeper'

afterEach(() => {
  vi.useRealTimers()
})

function lease() {
  const lost = new Set<(r: string) => void>()
  let released = false
  return {
    l: {
      computerId: 'c1',
      client: {} as never,
      onLost: (cb: (r: string) => void) => {
        lost.add(cb)
        return () => lost.delete(cb)
      },
      release: () => {
        released = true
      }
    },
    lose: () => {
      for (const cb of [...lost]) cb('closed')
    },
    released: () => released
  }
}

function setup(answers: Array<ReturnType<typeof lease> | null>) {
  const changes: Array<'lease' | null> = []
  let connected: (() => void) | undefined
  let wakeCb: (() => void) | undefined
  let acquires = 0
  const keeper = keepDirectLease({
    target: { kind: 'pty', sessionId: 's' },
    manager: {
      acquire: async () => {
        acquires++
        const next = answers.shift()
        return next ? (next.l as never) : null
      },
      onComputerConnected: (cb) => {
        connected = () => cb('c1')
        return () => undefined
      }
    },
    wake: (cb) => {
      wakeCb = cb
      return () => undefined
    },
    retryMs: 60_000,
    lostRetryMs: 1_000,
    onChange: (l) => changes.push(l ? 'lease' : null)
  })
  return {
    keeper,
    changes,
    acquires: () => acquires,
    computerConnected: () => connected?.(),
    wake: () => wakeCb?.()
  }
}

describe('keepDirectLease', () => {
  it('hands over a lease, takes it back when lost, and tries again shortly', async () => {
    vi.useFakeTimers()
    const a = lease()
    const b = lease()
    const { changes, acquires } = setup([a, b])
    await vi.advanceTimersByTimeAsync(0)
    expect(changes).toEqual(['lease'])
    a.lose()
    expect(changes).toEqual(['lease', null])
    expect(a.released()).toBe(true)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(acquires()).toBe(2)
    expect(changes).toEqual(['lease', null, 'lease'])
  })

  it('waits the long retry after a relay answer, unless woken or the computer reconnects', async () => {
    vi.useFakeTimers()
    const later = lease()
    const { acquires, wake, computerConnected, changes } = setup([null, null, later])
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(59_000)
    expect(acquires()).toBe(1)
    wake()
    await vi.advanceTimersByTimeAsync(0)
    expect(acquires()).toBe(2)
    computerConnected()
    await vi.advanceTimersByTimeAsync(0)
    expect(acquires()).toBe(3)
    expect(changes).toEqual(['lease'])
  })

  it('lost(): the holder found the lease unusable (stream error) — same as the manager saying so', async () => {
    vi.useFakeTimers()
    const a = lease()
    const { keeper, changes } = setup([a, null])
    await vi.advanceTimersByTimeAsync(0)
    keeper.lost()
    expect(changes).toEqual(['lease', null])
    expect(a.released()).toBe(true)
  })

  it('stop() releases and never acquires again', async () => {
    vi.useFakeTimers()
    const a = lease()
    const { keeper, acquires, changes } = setup([a])
    await vi.advanceTimersByTimeAsync(0)
    keeper.stop()
    expect(a.released()).toBe(true)
    expect(changes).toEqual(['lease', null])
    await vi.advanceTimersByTimeAsync(300_000)
    expect(acquires()).toBe(1)
  })
})
