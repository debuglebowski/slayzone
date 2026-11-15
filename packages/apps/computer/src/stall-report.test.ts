/**
 * The computer's own main-thread stalls: logged to computer.log and reported to
 * every hub it serves — including a hub the stall itself disconnected (the report is
 * kept until that hub is back). Commands are reduced to executable names: a shell's
 * `-c` carries the agent command line, prompt included.
 */
import { describe, expect, it } from 'vitest'
import type { EventLoopStall } from '@slayzone/platform/event-loop-stall'
import {
  COMPUTER_EVENT_LOOP_STALL_EVENT_NAME,
  computerEventLoopStallPayloadSchema
} from '@slayzone/computer-transport/shared'
import { createStallReporter, sanitizeStallForHub, STALL_OUTBOX_MAX } from './stall-report'

const stall: EventLoopStall = {
  startedAt: 1_000,
  durationMs: 7_000,
  mainThreadCpuMs: 6_500,
  processCpuMs: 6_900,
  gcMs: 40,
  machineCpuBusyPct: 55,
  stacks: [{ atMs: 2_000, frames: ['readSince (chat-events-store.js:10:3)', 'all (db.js:1:1)'] }],
  children: [
    {
      atMs: 2_000,
      processes: [
        {
          pid: 77,
          elapsed: '03:10',
          command: "/bin/zsh -l -c claude --resume abc 'secret prompt text'"
        }
      ]
    }
  ],
  topCpu: [{ atMs: 2_000, processes: [{ pid: 9, cpuPct: 98, command: 'node' }] }]
}

class FakeDialer {
  connected = true
  sent: Array<{ method: string; params: unknown }> = []
  private onConnected: Array<() => void> = []
  events = {
    on: (_event: 'connected', cb: () => void): (() => void) => {
      this.onConnected.push(cb)
      return () => {
        this.onConnected = this.onConnected.filter((c) => c !== cb)
      }
    }
  }
  notify(method: string, params?: unknown): boolean {
    if (!this.connected) return false
    this.sent.push({ method, params })
    return true
  }
  reconnect(): void {
    this.connected = true
    for (const cb of this.onConnected) cb()
  }
  stalls(): Array<Record<string, unknown>> {
    return this.sent
      .filter((s) => s.method === 'event')
      .map((s) => s.params as { name: string; payload: Record<string, unknown> })
      .filter((p) => p.name === COMPUTER_EVENT_LOOP_STALL_EVENT_NAME)
      .map((p) => p.payload)
  }
}

describe('sanitizeStallForHub', () => {
  it('keeps the measurements and stacks, reduces commands to executable names', () => {
    const out = sanitizeStallForHub(stall)
    expect(out).toMatchObject({
      startedAt: 1_000,
      durationMs: 7_000,
      mainThreadCpuMs: 6_500,
      processCpuMs: 6_900,
      gcMs: 40,
      machineCpuBusyPct: 55,
      stacks: stall.stacks,
      topCpu: stall.topCpu
    })
    expect(out.children[0].processes[0]).toEqual({ pid: 77, elapsed: '03:10', command: 'zsh' })
    expect(JSON.stringify(out)).not.toContain('secret prompt text')
    // What the hub accepts.
    expect(computerEventLoopStallPayloadSchema.safeParse(out).success).toBe(true)
  })

  it('keeps the verdict and its evidence (FU5)', () => {
    const evidence = {
      verdict: 'starved' as const,
      loadAvg1: 151.2,
      cpuCount: 10,
      majorPageFaults: 3,
      voluntaryCtxSwitches: 0,
      involuntaryCtxSwitches: 812
    }
    const out = sanitizeStallForHub({ ...stall, ...evidence })
    expect(out).toMatchObject(evidence)
    expect(computerEventLoopStallPayloadSchema.parse(out)).toMatchObject(evidence)
  })
})

describe('createStallReporter', () => {
  const own = { primary: true, ownedPids: () => [77] }
  it('logs the stall and reports it to every connected hub', () => {
    const lines: Array<{ message: string; meta?: Record<string, unknown> }> = []
    const reporter = createStallReporter({ log: (message, meta) => lines.push({ message, meta }) })
    const a = new FakeDialer()
    const b = new FakeDialer()
    reporter.attach(a, own)
    reporter.attach(b, own)
    reporter.report(stall)
    expect(lines).toHaveLength(1)
    expect(lines[0].message).toContain('7000ms')
    expect(JSON.stringify(lines[0].meta)).not.toContain('secret prompt text')
    expect(a.stalls()).toHaveLength(1)
    expect(b.stalls()).toHaveLength(1)
    expect(a.stalls()[0]).toMatchObject({ durationMs: 7_000 })
  })

  it('keeps a report for a disconnected hub until it is back', () => {
    const reporter = createStallReporter({ log: () => undefined })
    const d = new FakeDialer()
    reporter.attach(d, own)
    d.connected = false
    reporter.report(stall)
    expect(d.stalls()).toEqual([])
    d.reconnect()
    expect(d.stalls()).toHaveLength(1)
    // Delivered once.
    d.reconnect()
    expect(d.stalls()).toHaveLength(1)
  })

  it('bounds the outbox and says how many it dropped', () => {
    const reporter = createStallReporter({ log: () => undefined })
    const d = new FakeDialer()
    reporter.attach(d, own)
    d.connected = false
    for (let i = 0; i < STALL_OUTBOX_MAX + 3; i++) reporter.report({ ...stall, startedAt: i })
    d.reconnect()
    const got = d.stalls()
    expect(got).toHaveLength(STALL_OUTBOX_MAX)
    expect(got[0]).toMatchObject({ startedAt: 3, dropped: 3 })
    expect(got[1].dropped).toBeUndefined()
  })

  it('a detached hub gets nothing more', () => {
    const reporter = createStallReporter({ log: () => undefined })
    const d = new FakeDialer()
    const detach = reporter.attach(d, own)
    detach()
    reporter.report(stall)
    d.reconnect()
    expect(d.stalls()).toEqual([])
  })
})

describe('what each hub may see', () => {
  // pid 77 is hub A's agent, 88 hub B's; 99 belongs to no hub's work (a blocking
  // `git` the computer itself spawned).
  const many: EventLoopStall = {
    ...stall,
    children: [
      {
        atMs: 2_000,
        processes: [
          { pid: 77, elapsed: '1', command: 'zsh -c a' },
          { pid: 88, elapsed: '1', command: 'zsh -c b' },
          { pid: 99, elapsed: '1', command: 'git status' }
        ]
      }
    ]
  }
  const pids = (d: FakeDialer) =>
    (d.stalls()[0].children as Array<{ processes: Array<{ pid: number }> }>)[0].processes.map(
      (p) => p.pid
    )

  it('a hub sees only its own processes; machine-wide CPU only on the primary hub', () => {
    const reporter = createStallReporter({ log: () => undefined })
    const primary = new FakeDialer()
    const joined = new FakeDialer()
    reporter.attach(primary, { primary: true, ownedPids: () => [77] })
    reporter.attach(joined, { primary: false, ownedPids: () => [88] })
    reporter.report(many)
    // The primary (the desktop's own hub) also gets work no hub owns.
    expect(pids(primary)).toEqual([77, 99])
    expect(pids(joined)).toEqual([88])
    expect(primary.stalls()[0].topCpu).toEqual(stall.topCpu)
    expect(joined.stalls()[0].topCpu).toBeUndefined()
    // Measurements and stacks go to every hub.
    for (const d of [primary, joined])
      expect(d.stalls()[0]).toMatchObject({ durationMs: 7_000, stacks: stall.stacks })
  })

  it("the local log keeps everything (it is this machine's own)", () => {
    const lines: Array<Record<string, unknown> | undefined> = []
    const reporter = createStallReporter({ log: (_m, meta) => lines.push(meta) })
    reporter.attach(new FakeDialer(), { primary: false, ownedPids: () => [88] })
    reporter.report(many)
    expect(JSON.stringify(lines[0])).toContain('"pid":77')
    expect(JSON.stringify(lines[0])).toContain('topCpu')
  })
})
