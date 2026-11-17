import { expect, test, vi } from 'vitest'
import { reduceChatLifecycle } from '../../shared/chat-lifecycle'
import { ChatLifecycleShadow, type LifecycleObservation } from './chat-lifecycle-shadow'

const flush = async () => {
  await Promise.resolve()
}
const idle = (generation = 1): LifecycleObservation => ({
  generation,
  conversationId: 'conversation',
  state: 'idle',
  reportedState: 'idle',
  turnOpen: false,
  mainTurnOpen: false,
  pendingRequestIds: [],
  outboxInFlight: 0,
  backgroundHelpers: 0,
  backgroundJobs: 0,
  readyForMessage: true,
  seq: 0,
  live: 0
})

test('compares after an atomic operation; transient starting state is never a false mismatch', async () => {
  const reports: unknown[] = []
  const s = new ChatLifecycleShadow('tab', {
    autonomous: true,
    observe: () => idle(),
    report: (p) => reports.push(p)
  })
  s.feed(1, { type: 'process-start', conversationId: 'conversation' })
  s.feed(1, { type: 'process-ready' })
  await flush()
  expect(s.read()).toMatchObject({
    checks: 1,
    mismatches: 0,
    disabled: false,
    snapshot: { state: 'idle' }
  })
  expect(reports).toEqual([])
})

test('diagnostics are bounded, deduplicated and contain no provider payload or prompt ids', async () => {
  const reports: unknown[] = []
  const secret = 'PRIVATE prompt identifier and command'
  const s = new ChatLifecycleShadow('tab', {
    autonomous: true,
    observe: () => idle(),
    report: (p) => reports.push(p),
    reportLimit: 2
  })
  s.feed(1, { type: 'process-start', conversationId: 'conversation' })
  s.feed(1, { type: 'process-ready' })
  await flush()
  for (let i = 0; i < 5; i++) {
    s.event(1, {
      kind: 'permission-request',
      requestId: `${secret}-${i}`,
      toolUseId: secret,
      toolName: 'Bash',
      input: { command: secret }
    })
    await flush()
  }
  expect(s.read()).toMatchObject({ mismatches: 5, reported: 2, suppressed: 3, disabled: false })
  expect(reports).toHaveLength(2)
  expect(JSON.stringify(reports)).not.toContain(secret)
  expect(reports[0]).toMatchObject({
    kind: 'mismatch',
    generation: 1,
    fields: expect.arrayContaining(['pendingRequests'])
  })
})

test('reducer or observation failure disables shadow only, without leaking error content', async () => {
  for (const source of ['reducer', 'observation'] as const) {
    const reports: unknown[] = []
    let broken = false
    const s = new ChatLifecycleShadow('tab', {
      autonomous: true,
      observe: () => {
        if (broken && source === 'observation') throw new Error('PRIVATE failure')
        return idle()
      },
      reduce: (state, input) => {
        if (broken && source === 'reducer') throw new Error('PRIVATE failure')
        return reduceChatLifecycle(state, input)
      },
      report: (p) => reports.push(p)
    })
    s.feed(1, { type: 'process-start', conversationId: 'conversation' })
    s.feed(1, { type: 'process-ready' })
    await flush()
    broken = true
    expect(() => s.feed(1, { type: 'turn-start', turnId: 'T1', origin: 'user' })).not.toThrow()
    await flush()
    expect(s.read().disabled).toBe(true)
    expect(reports).toEqual([expect.objectContaining({ kind: 'disabled', reason: source })])
    expect(JSON.stringify(reports)).not.toContain('PRIVATE')
    expect(() => s.feed(1, { type: 'process-ended' })).not.toThrow()
  }
})

test('a diagnostics failure does not affect comparison or propagate to the runtime', async () => {
  const s = new ChatLifecycleShadow('tab', {
    autonomous: true,
    observe: () => idle(),
    report: () => {
      throw new Error('diagnostics unavailable')
    }
  })
  s.feed(1, { type: 'process-start', conversationId: 'conversation' })
  s.feed(1, { type: 'process-ready' })
  await flush()
  s.feed(1, { type: 'turn-start', turnId: 'T1', origin: 'user' })
  await flush()
  expect(s.read()).toMatchObject({ mismatches: 1, disabled: false })
})

test('stale process events are ignored and closing cancels queued comparisons', async () => {
  let observed = idle()
  const s = new ChatLifecycleShadow('tab', {
    autonomous: true,
    observe: () => observed,
    report: () => {}
  })
  s.feed(1, { type: 'process-start', conversationId: 'conversation' })
  s.feed(1, { type: 'process-ready' })
  await flush()
  observed = idle(2)
  s.feed(2, { type: 'process-start', conversationId: 'conversation' })
  s.feed(2, { type: 'process-ready' })
  s.event(1, { kind: 'process-exit', code: 0, signal: null })
  await flush()
  expect(s.read()).toMatchObject({ mismatches: 0, snapshot: { generation: 2, state: 'idle' } })
  const checks = s.read().checks
  s.feed(2, { type: 'turn-start', turnId: 'T2', origin: 'user' })
  s.close()
  await flush()
  expect(s.read().checks).toBe(checks)
})

test('steady-state token fragments do not schedule a comparison per token', async () => {
  const observed = {
    ...idle(),
    state: 'running' as const,
    reportedState: 'running' as const,
    turnOpen: true,
    mainTurnOpen: true,
    readyForMessage: false
  }
  const s = new ChatLifecycleShadow('tab', {
    autonomous: true,
    observe: () => observed,
    report: () => {}
  })
  s.feed(1, { type: 'process-start', conversationId: 'conversation' })
  s.feed(1, { type: 'process-ready' })
  s.feed(1, { type: 'turn-start', turnId: 'T1', origin: 'user' })
  await flush()
  const checks = s.read().checks
  for (let i = 0; i < 1_000; i++) {
    s.event(1, {
      kind: 'stream-block-delta',
      blockIndex: 0,
      deltaType: 'text',
      text: 'PRIVATE token'
    })
    await flush()
  }
  expect(s.read()).toMatchObject({ checks, mismatches: 0 })
  expect(JSON.stringify(s.read())).not.toContain('PRIVATE')
})

test('an ignored child event still detects a legacy-only state change', async () => {
  let observed: LifecycleObservation = idle()
  const reports: unknown[] = []
  const s = new ChatLifecycleShadow('tab', {
    autonomous: true,
    observe: () => observed,
    report: (r) => reports.push(r)
  })
  s.feed(1, { type: 'process-start', conversationId: 'conversation' })
  s.feed(1, { type: 'process-ready' })
  await flush()
  observed = {
    ...idle(),
    state: 'running',
    reportedState: 'running',
    turnOpen: true,
    readyForMessage: false
  }
  s.event(1, {
    kind: 'tool-call',
    id: 'child-tool',
    name: 'Bash',
    input: {},
    parentToolUseId: 'helper'
  })
  await flush()
  expect(s.read()).toMatchObject({ mismatches: 1, snapshot: { state: 'idle', main: null } })
  expect(reports).toHaveLength(1)
})

test('normalization and scheduling failures cannot escape into the chat runtime', () => {
  const records: unknown[] = []
  const make = () =>
    new ChatLifecycleShadow('tab', {
      autonomous: true,
      observe: () => idle(),
      report: (record) => records.push(record)
    })
  const normalization = make()
  const event = new Proxy(
    { kind: 'tool-call' as const, id: 'tool', name: 'Bash', input: {} },
    {
      has: () => {
        throw new Error('PRIVATE normalization failure')
      }
    }
  )
  expect(() => normalization.event(0, event)).not.toThrow()
  expect(normalization.read().disabled).toBe(true)

  const scheduling = make()
  const queued = vi.spyOn(globalThis, 'queueMicrotask').mockImplementationOnce(() => {
    throw new Error('PRIVATE scheduling failure')
  })
  try {
    expect(() => scheduling.feed(1, { type: 'process-start', conversationId: 'c' })).not.toThrow()
    expect(scheduling.read().disabled).toBe(true)
  } finally {
    queued.mockRestore()
  }
  expect(JSON.stringify(records)).not.toContain('PRIVATE')
})

test.each([Number.NaN, Number.POSITIVE_INFINITY, 1_000])(
  'report budget remains bounded for limit %s',
  async (reportLimit) => {
    const reports: unknown[] = []
    const s = new ChatLifecycleShadow('tab', {
      autonomous: true,
      observe: () => idle(),
      reportLimit,
      report: (record) => reports.push(record)
    })
    s.feed(1, { type: 'process-start', conversationId: 'conversation' })
    s.feed(1, { type: 'process-ready' })
    await flush()
    for (let i = 0; i < 40; i++) {
      s.event(1, {
        kind: 'permission-request',
        requestId: `request-${i}`,
        toolUseId: 't',
        toolName: 'Bash',
        input: {}
      })
      await flush()
    }
    expect(reports.length).toBeLessThanOrEqual(32)
    expect(s.read().disabled).toBe(false)
  }
)
