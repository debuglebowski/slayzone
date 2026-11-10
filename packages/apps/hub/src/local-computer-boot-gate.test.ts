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
})
