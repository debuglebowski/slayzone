/**
 * Strings a computer reports about a terminal (title, prompt text, conversation id,
 * dev-server URLs, error text) and exit signals flow into the hub's state and DB.
 * Unbounded, one runaway OSC title or prompt held megabytes per session. They are
 * bounded — truncated, not rejected, so an oversized title never drops the state
 * signal carrying it.
 */
import { describe, expect, it } from 'vitest'
import {
  COMPUTER_EVENT_LOOP_STALL_EVENT_NAME,
  computerEventLoopStallPayloadSchema,
  procExitParamsSchema,
  ptyExitParamsSchema,
  ptySignalPayloadSchema
} from './frames'

const huge = 'x'.repeat(1_000_000)

describe('pty signal bounds', () => {
  it('oversized strings are cut, the signal kept', () => {
    const parsed = ptySignalPayloadSchema.parse({
      sessionId: 's',
      seq: 3,
      activity: 'idle',
      refreshIdleClock: true,
      preview: '',
      error: { code: 'E', message: huge, recoverable: true },
      suppressOutput: false,
      prompt: { type: 'question', text: huge, position: 0 },
      title: huge,
      devServerUrls: Array.from({ length: 500 }, (_, i) => `http://localhost:${i}/${huge}`),
      conversationId: huge
    })
    expect(parsed.activity, 'the state is kept').toBe('idle')
    expect(parsed.title!.length).toBeLessThanOrEqual(1024)
    expect(parsed.prompt!.text.length).toBeLessThanOrEqual(16 * 1024)
    expect(parsed.error!.message.length).toBeLessThanOrEqual(16 * 1024)
    expect(parsed.conversationId!.length).toBeLessThanOrEqual(256)
    expect(parsed.devServerUrls.length).toBeLessThanOrEqual(32)
    for (const url of parsed.devServerUrls) expect(url.length).toBeLessThanOrEqual(2048)
  })

  it('exit signals are bounded too', () => {
    const base = { sessionId: 's', exitCode: null, signal: huge }
    expect(ptyExitParamsSchema.parse(base).signal!.length).toBeLessThanOrEqual(64)
    expect(procExitParamsSchema.parse(base).signal!.length).toBeLessThanOrEqual(64)
  })
})

describe('event-loop stall report bounds', () => {
  const stall = {
    startedAt: 1,
    durationMs: 4200,
    mainThreadCpuMs: 4000,
    processCpuMs: 4100,
    gcMs: 12,
    machineCpuBusyPct: 80,
    stacks: [{ atMs: 2, frames: ['readSince (chat-events-store.js:10:3)'] }],
    children: [{ atMs: 2, processes: [{ pid: 7, elapsed: '01:02', command: 'zsh' }] }],
    topCpu: [{ atMs: 2, processes: [{ pid: 7, cpuPct: 99.5, command: 'node' }] }]
  }

  it('round-trips a report under the shared event name', () => {
    expect(COMPUTER_EVENT_LOOP_STALL_EVENT_NAME).toBe('event-loop-stall')
    expect(computerEventLoopStallPayloadSchema.parse(stall)).toEqual(stall)
  })

  it('oversized fields are cut, the report kept', () => {
    const parsed = computerEventLoopStallPayloadSchema.parse({
      ...stall,
      stacks: Array.from({ length: 50 }, () => ({
        atMs: 2,
        frames: Array.from({ length: 500 }, () => huge)
      })),
      children: Array.from({ length: 50 }, () => ({
        atMs: 2,
        processes: Array.from({ length: 5000 }, () => ({ pid: 1, elapsed: huge, command: huge }))
      }))
    })
    expect(parsed.durationMs).toBe(4200)
    expect(parsed.stacks.length).toBeLessThanOrEqual(5)
    expect(parsed.stacks[0].frames.length).toBeLessThanOrEqual(20)
    expect(parsed.stacks[0].frames[0].length).toBeLessThanOrEqual(512)
    expect(parsed.children.length).toBeLessThanOrEqual(5)
    expect(parsed.children[0].processes.length).toBeLessThanOrEqual(64)
    expect(parsed.children[0].processes[0].command.length).toBeLessThanOrEqual(64)
  })

  it('carries the verdict and its evidence (FU5); a report from an older computer has none', () => {
    const verdict = {
      ...stall,
      verdict: 'starved',
      loadAvg1: 151.2,
      cpuCount: 10,
      majorPageFaults: 3,
      voluntaryCtxSwitches: 0,
      involuntaryCtxSwitches: 812
    }
    expect(computerEventLoopStallPayloadSchema.parse(verdict)).toEqual(verdict)
    expect(computerEventLoopStallPayloadSchema.parse(stall)).not.toHaveProperty('verdict')
    expect(
      computerEventLoopStallPayloadSchema.safeParse({ ...stall, verdict: 'sleepy' }).success
    ).toBe(false)
  })

  it('rejects a report without its measurements', () => {
    expect(computerEventLoopStallPayloadSchema.safeParse({ durationMs: 'x' }).success).toBe(false)
  })
})
