import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ptySignalPayloadSchema, type PtySignalPayload } from '@slayzone/computer-transport/shared'
import { createPtySessionSignals, IDLE_CLOCK_SIGNAL_MS } from './pty-signals'

const ids = { sessionId: () => 's-1', spawnId: () => 'sp-1' }

function harness(mode: string, resuming = false) {
  const sent: PtySignalPayload[] = []
  let t = 1_000
  const signals = createPtySessionSignals(
    { mode, resuming },
    ids,
    (p) => sent.push(ptySignalPayloadSchema.parse(p)),
    () => t
  )
  return { sent, signals, advance: (ms: number) => (t += ms) }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('pty signals (computer-side detection)', () => {
  test('activity, title and dev URL reach the hub as one schema-valid signal per chunk', () => {
    const { sent, signals } = harness('gemini')
    signals.onOutput(`\x1b]0;Gemini busy\x07${'x'.repeat(80)} http://0.0.0.0:5173`, 7)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      sessionId: 's-1',
      spawnId: 'sp-1',
      seq: 7,
      activity: 'working',
      title: 'Gemini busy',
      devServerUrls: ['http://localhost:5173']
    })
  })

  test('a chunk that says nothing (hook-driven claude redraw) sends nothing', () => {
    const { sent, signals } = harness('claude-code')
    signals.onOutput('\x1b[2K\r spinner', 1)
    expect(sent).toEqual([])
  })

  test('terminal queries are taken out before detection', () => {
    // DA1 is `ESC [ c`; as text it would be output. Answered/stripped, it says nothing.
    const { sent, signals } = harness('claude-code')
    signals.onOutput('\x1b[c', 1)
    expect(sent).toEqual([])
  })

  test('idle-clock-only chunks (plain shell) coalesce: leading + trailing per window', () => {
    vi.useFakeTimers()
    const { sent, signals, advance } = harness('terminal')
    signals.onOutput('a', 1)
    signals.onOutput('b', 2)
    signals.onOutput('c', 3)
    expect(sent.map((s) => s.seq)).toEqual([1])
    advance(IDLE_CLOCK_SIGNAL_MS)
    vi.advanceTimersByTime(IDLE_CLOCK_SIGNAL_MS)
    expect(sent.map((s) => s.seq)).toEqual([1, 3])
    expect(sent[1].refreshIdleClock).toBe(true)
    signals.dispose()
  })

  test('stale-resume window: honored at start, closed after the window', () => {
    vi.useFakeTimers()
    const msg = 'No conversation found with session ID: x'
    const early = harness('claude-code', true)
    early.signals.onOutput(msg, 1)
    expect(early.sent[0]?.error?.code).toBe('SESSION_NOT_FOUND')
    expect(early.sent[0]?.suppressOutput).toBe(true)

    const late = harness('claude-code', true)
    vi.advanceTimersByTime(5_000)
    late.signals.onOutput(msg, 1)
    expect(late.sent).toEqual([])
  })

  test("codex: the conversation id is read from THIS machine's session files after first output", async () => {
    const home = mkdtempSync(join(tmpdir(), 'pty-signals-home-'))
    const prevHome = process.env.HOME
    process.env.HOME = home
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const id = '11111111-2222-3333-4444-555555555555'
      const now = new Date()
      const dir = join(
        home,
        '.codex',
        'sessions',
        String(now.getFullYear()),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0')
      )
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, `rollout-x-${id}.jsonl`),
        `${JSON.stringify({ payload: { cwd: '/work/repo' } })}\n`
      )
      const sent: PtySignalPayload[] = []
      const signals = createPtySessionSignals(
        { mode: 'codex', resuming: false },
        ids,
        (p) => sent.push(ptySignalPayloadSchema.parse(p)),
        Date.now,
        { cwd: '/work/repo', startedAt: Date.now() }
      )
      signals.onOutput('booting', 4)
      vi.advanceTimersByTime(3_000)
      await vi.waitFor(() =>
        expect(sent).toContainEqual(expect.objectContaining({ seq: 4, conversationId: id }))
      )
      signals.dispose()
    } finally {
      process.env.HOME = prevHome
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('conversation id only after /status is submitted, and only within the watch', () => {
    vi.useFakeTimers()
    const id = '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b'
    const { sent, signals } = harness('gemini')
    const found = () => sent.filter((s) => s.conversationId).map((s) => s.seq)
    signals.onOutput(`session: ${id}`, 1)
    expect(found()).toEqual([])
    signals.watchConversationId()
    signals.onOutput(`session: ${id}`, 2)
    expect(sent.at(-1)?.conversationId).toBe(id)
    signals.watchConversationId()
    vi.advanceTimersByTime(5_000)
    signals.onOutput(`session: ${id}`, 3)
    expect(found()).toEqual([2])
  })
})
