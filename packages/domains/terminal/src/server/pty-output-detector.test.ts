/**
 * PtyOutputDetector: everything derived from a pty's raw output, as data. One
 * implementation that the hub runs today and the computer runs next (it lives in the
 * lean `@slayzone/terminal/pty-detection` entry). It decides nothing about terminal
 * state — the hub's state machine does that from these detections.
 */
import { describe, expect, test } from 'vitest'
import { PtyOutputDetector, getAdapter } from './pty-detection'

const detector = (mode: string, opts: { resuming?: boolean; patterns?: unknown } = {}) =>
  new PtyOutputDetector({
    adapter: getAdapter({ mode, patterns: opts.patterns as never }),
    mode,
    resuming: opts.resuming ?? false
  })

describe('PtyOutputDetector', () => {
  test('gemini: a long chunk is working activity and refreshes the idle clock', () => {
    const d = detector('gemini')
    const r = d.detect(`${'x'.repeat(80)}`)
    expect(r.activity).toBe('working')
    expect(r.refreshIdleClock).toBe(true)
    expect(r.preview.length).toBeGreaterThan(0)
  })

  test('claude is hook-driven: no output activity, no idle-clock refresh', () => {
    const r = detector('claude-code').detect('some output\r\n')
    expect(r.activity).toBeNull()
    expect(r.refreshIdleClock).toBe(false)
  })

  test('plain terminal refreshes the idle clock on every chunk and ignores OSC titles', () => {
    const r = detector('terminal').detect('\x1b]0;user@host:~\x07$ ')
    expect(r.refreshIdleClock).toBe(true)
    expect(r.title).toBeNull()
  })

  test('agent modes take the OSC title', () => {
    expect(detector('codex').detect('\x1b]0;Working on it\x07').title).toBe('Working on it')
  })

  test('dev-server URLs: normalized 0.0.0.0 → localhost, reported once per URL', () => {
    const d = detector('terminal')
    expect(
      d.detect('ready on http://0.0.0.0:5173 and http://127.0.0.1:3000').devServerUrls
    ).toEqual(['http://localhost:5173', 'http://127.0.0.1:3000'])
    expect(d.detect('again http://localhost:5173').devServerUrls).toEqual([])
  })

  test('stale-resume error: honored only inside the startup window; suppresses output', () => {
    const msg = 'No conversation found with session ID: 0000'
    const late = detector('claude-code', { resuming: true })
    late.checkingForSessionError = false
    expect(late.detect(msg).error).toBeNull()

    const d = detector('claude-code', { resuming: true })
    const r = d.detect(msg)
    expect(r.error?.code).toBe('SESSION_NOT_FOUND')
    expect(r.suppressOutput).toBe(true)
    // Honoring closes the window.
    expect(d.checkingForSessionError).toBe(false)
  })

  test('conversation id from /status output only while watching', () => {
    const d = detector('gemini')
    const id = '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b'
    expect(d.detect(`session: ${id}`).conversationId).toBeNull()
    d.watchConversationId()
    expect(d.detect('Session ID:').conversationId).toBeNull()
    expect(d.detect(` ${id}\r\n`).conversationId).toBe(id)
    // Found → watching stops.
    expect(d.watchingConversationId).toBe(false)
  })
})
