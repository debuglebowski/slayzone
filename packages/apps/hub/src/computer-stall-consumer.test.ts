/**
 * A computer's main-thread stall, reported over its authed socket, becomes the hub
 * diagnostic `computer.event_loop_stall` naming the computer. Anything else on the
 * generic `event` channel, or a malformed report, is ignored.
 */
import { describe, expect, test } from 'vitest'
import type { DiagnosticEvent } from '@slayzone/diagnostics/shared'
import { attachComputerStallConsumer, type ComputerStallGateway } from './computer-stall-consumer'

type Evt = { computerId: string; name: string; payload?: unknown }

function fakeGateway(): ComputerStallGateway & { emit(e: Evt): void } {
  const listeners: Array<(e: Evt) => void> = []
  return {
    events: { on: (_event, listener) => void listeners.push(listener) },
    emit: (e) => {
      for (const l of listeners) l(e)
    }
  }
}

const stall = {
  startedAt: 10,
  durationMs: 7_000,
  mainThreadCpuMs: 6_800,
  processCpuMs: 6_900,
  gcMs: 30,
  machineCpuBusyPct: 40,
  stacks: [{ atMs: 11, frames: ['readSince (chat-events-store.js:1:1)'] }],
  children: []
}

describe('attachComputerStallConsumer', () => {
  test('records the stall as a hub diagnostic naming the computer', () => {
    const recorded: DiagnosticEvent[] = []
    const gw = fakeGateway()
    attachComputerStallConsumer(gw, (e) => recorded.push(e))
    gw.emit({ computerId: 'pc-1', name: 'event-loop-stall', payload: stall })
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({
      level: 'warn',
      event: 'computer.event_loop_stall',
      payload: { computerId: 'pc-1', ...stall }
    })
    expect(recorded[0].message).toContain('7000ms')
  })

  test('ignores other events and malformed reports', () => {
    const recorded: DiagnosticEvent[] = []
    const gw = fakeGateway()
    attachComputerStallConsumer(gw, (e) => recorded.push(e))
    gw.emit({ computerId: 'pc-1', name: 'agent-hook', payload: stall })
    gw.emit({ computerId: 'pc-1', name: 'event-loop-stall', payload: { durationMs: 'long' } })
    gw.emit({ computerId: 'pc-1', name: 'event-loop-stall' })
    expect(recorded).toEqual([])
  })

  test('a recorder that throws never escapes into the gateway', () => {
    const gw = fakeGateway()
    attachComputerStallConsumer(gw, () => {
      throw new Error('db gone')
    })
    expect(() =>
      gw.emit({ computerId: 'pc-1', name: 'event-loop-stall', payload: stall })
    ).not.toThrow()
  })
})
