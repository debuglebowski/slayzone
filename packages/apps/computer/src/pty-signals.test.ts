import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ptySignalPayloadSchema, type PtySignalPayload } from '@slayzone/computer-transport/shared'
import { createPtySessionSignals, IDLE_CLOCK_SIGNAL_MS } from './pty-signals'

const ids = { sessionId: () => 's-1', spawnId: () => 'sp-1' }

function harness(mode: string, resuming = false) {
  const sent: PtySignalPayload[] = []
  const answers: string[] = []
  let t = 1_000
  const pipeline = createPtySessionSignals({
    params: { mode, resuming },
    ids,
    emit: (p) => sent.push(ptySignalPayloadSchema.parse(p)),
    respond: (a) => answers.push(a),
    now: () => t
  })
  const cleaned: string[] = []
  /** What the pty handler does per chunk: process, buffer as `seq`, report. */
  const signals = {
    onOutput(data: string, seq: number) {
      const { clean, detection } = pipeline.process(data)
      cleaned.push(clean)
      pipeline.report(detection, seq)
    },
    watchConversationId: () => pipeline.watchConversationId(),
    dispose: () => pipeline.dispose()
  }
  return { sent, answers, cleaned, signals, pipeline, advance: (ms: number) => (t += ms) }
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

  test('terminal queries are answered at once and taken out before detection', () => {
    // DA1 is `ESC [ c`; as text it would be output. Answered/stripped, it says nothing.
    const { sent, signals, answers, cleaned } = harness('claude-code')
    signals.onOutput('before\x1b[cafter', 1)
    expect(sent).toEqual([])
    expect(answers).toEqual(['\x1b[?62;4;22c'])
    expect(cleaned).toEqual(['beforeafter'])
  })

  test('what is buffered + streamed is the replay-filtered chunk (OSC title out, detected)', () => {
    const { sent, signals, cleaned } = harness('codex')
    signals.onOutput('\x1b]0;Codex busy\x07hello', 1)
    expect(cleaned).toEqual(['hello'])
    expect(sent[0]?.title).toBe('Codex busy')
  })

  test("OSC colour queries are answered with the hub's theme, updated live", () => {
    const { answers, pipeline } = harness('claude-code')
    pipeline.setTheme({ foreground: '#112233', background: '#445566', cursor: '#778899' })
    pipeline.process('\x1b]11;?\x07')
    expect(answers.join('')).toContain('4444/5555/6666')
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
      const signals = createPtySessionSignals({
        params: { mode: 'codex', resuming: false },
        ids,
        emit: (p) => sent.push(ptySignalPayloadSchema.parse(p)),
        respond: () => undefined,
        disk: { cwd: '/work/repo', startedAt: Date.now() }
      })
      signals.report(signals.process('booting').detection, 4)
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

  test('failed resume: a missing transcript on THIS disk is reported before the exit', () => {
    const home = mkdtempSync(join(tmpdir(), 'pty-signals-exit-'))
    const prevHome = process.env.HOME
    process.env.HOME = home
    try {
      const sent: PtySignalPayload[] = []
      const make = () =>
        createPtySessionSignals({
          params: { mode: 'claude-code', resuming: true, resumeConversationId: 'gone-id' },
          ids,
          emit: (p) => sent.push(ptySignalPayloadSchema.parse(p)),
          respond: () => undefined,
          disk: { cwd: '/work/repo', startedAt: Date.now() }
        })
      const failed = make()
      failed.exited(1, '')
      expect(sent.at(-1)?.exitError?.code).toBe('SESSION_NOT_FOUND')
      failed.dispose()

      // A clean exit is not a failed resume; the output scan finds nothing either.
      sent.length = 0
      const clean = make()
      clean.exited(0, 'bye')
      expect(sent).toEqual([])
      clean.dispose()

      // Exit-code-agnostic string scan over the buffered output.
      const scanned = make()
      scanned.exited(0, 'No conversation found with session ID: gone-id')
      expect(sent.at(-1)?.exitError?.code).toBe('SESSION_NOT_FOUND')
      scanned.dispose()
    } finally {
      process.env.HOME = prevHome
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('not a resume: exit says nothing', () => {
    const { sent, pipeline } = harness('claude-code')
    pipeline.exited(1, 'No conversation found with session ID: x')
    expect(sent).toEqual([])
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
