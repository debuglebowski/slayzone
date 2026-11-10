/**
 * The desktop's local computer enrolls a few seconds after the hub boots. A call
 * that needs a computer in that window (the file editor opening a file restored at
 * boot) waits for it instead of failing with "connect a computer" — and never falls
 * back to the hub's own disk. After the local computer has connected once, an
 * offline computer is a real answer: nothing waits.
 */
import { describe, expect, test } from 'vitest'
import { TypedEventEmitter } from '@slayzone/computer-transport/shared'
import type { ComputerGatewayEvents } from '@slayzone/computer-transport/server'
import { createLocalComputerBootGate } from './local-computer-boot-gate'

function setup(timeoutMs = 1_000, registered = true) {
  const events = new TypedEventEmitter<ComputerGatewayEvents>()
  const usable = new Set<string>()
  const gate = createLocalComputerBootGate({
    events,
    localComputerId: 'local',
    usable: (id) => usable.has(id),
    registered: async () => registered,
    timeoutMs
  })
  const connect = (id: string) => {
    usable.add(id)
    events.emit('computer-connected', { computer: { computerId: id } } as never)
  }
  return { gate, connect, usable }
}

describe('local computer boot gate', () => {
  test('a call while the local computer is booting waits for it, then resolves again', async () => {
    const { gate, connect } = setup()
    let resolved = 0
    const pending = gate.settle(async () => {
      resolved++
      return resolved === 1 ? null : 'local'
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(resolved).toBe(1)
    connect('local')
    expect(await pending).toBe('local')
    expect(resolved).toBe(2)
  })

  test('a usable answer never waits', async () => {
    const { gate, usable } = setup()
    usable.add('remote')
    expect(await gate.settle(async () => 'remote')).toBe('remote')
  })

  test('once the local computer connected, an offline answer is final', async () => {
    const { gate, connect, usable } = setup()
    connect('local')
    usable.delete('local')
    let resolved = 0
    expect(
      await gate.settle(async () => {
        resolved++
        return 'local'
      })
    ).toBe('local')
    expect(resolved).toBe(1)
  })

  test('a boot that never completes gives up after the timeout with the first answer', async () => {
    const { gate } = setup(30)
    expect(await gate.settle(async () => null)).toBeNull()
  })

  test('a local computer never registered on this hub is not waited for', async () => {
    const { gate } = setup(60_000, false)
    const started = Date.now()
    expect(await gate.settle(async () => null)).toBeNull()
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test('S6: the boot window closes after its timeout: later calls answer at once, not 30s each', async () => {
    const { gate } = setup(60)
    expect(await gate.settle(async () => null)).toBeNull()
    const started = Date.now()
    expect(await gate.settle(async () => null)).toBeNull()
    expect(await gate.settle(async () => null)).toBeNull()
    expect(Date.now() - started).toBeLessThan(40)
    expect(gate.booting).toBe(false)
  })

  test('S6: the window is one deadline from boot, shared — a late call waits only what is left', async () => {
    const { gate } = setup(120)
    await new Promise((r) => setTimeout(r, 80))
    const started = Date.now()
    expect(await gate.settle(async () => null)).toBeNull()
    expect(Date.now() - started).toBeLessThan(100)
  })

  test('S6: a reported spawn failure closes the window: waiting calls answer now, later ones at once', async () => {
    const { gate } = setup(60_000)
    const started = Date.now()
    const pending = gate.settle(async () => null)
    await new Promise((r) => setTimeout(r, 20))
    gate.close('spawn failed')
    expect(await pending).toBeNull()
    expect(await gate.settle(async () => null)).toBeNull()
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test('S6: the local computer still connecting after the window closed is used from then on', async () => {
    const { gate, connect } = setup(30)
    expect(await gate.settle(async () => null)).toBeNull()
    connect('local')
    expect(gate.booted).toBe(true)
    expect(await gate.settle(async () => 'local')).toBe('local')
  })

  test('S6: settleWith — any read: an unanswered result, or an offline error, waits for the boot', async () => {
    const { gate, connect } = setup()
    let n = 0
    const paths = gate.settleWith(async () => (++n === 1 ? { a: 'offline' } : { a: 'ok' }), {
      unanswered: (r) => Object.values(r).includes('offline')
    })
    let m = 0
    class Offline extends Error {}
    const prompts = gate.settleWith(
      async () => {
        if (++m === 1) throw new Offline('offline')
        return ['p']
      },
      { offline: (e) => e instanceof Offline }
    )
    await new Promise((r) => setTimeout(r, 20))
    connect('local')
    expect(await paths).toEqual({ a: 'ok' })
    expect(await prompts).toEqual(['p'])
    // A real error is never waited on or swallowed.
    await expect(
      gate.settleWith(
        async () => {
          throw new Error('boom')
        },
        { offline: (e) => e instanceof Offline }
      )
    ).rejects.toThrow('boom')
  })
})
