/**
 * Tests for suppressDeviceStatusReplies, driven against a REAL xterm parser via
 * `@xterm/headless` — the whole point is that xterm's own `deviceStatus` handler
 * stops firing, which a stub cannot demonstrate.
 */
// `@xterm/headless` ships CJS only. Under tsx's ESM interop the class can land on
// the namespace object OR under `.default`, so resolve both rather than pinning to
// whichever shape today's loader produces.
import { describe, expect, test } from 'vitest'
import * as headless from '@xterm/headless'
import { suppressDeviceStatusReplies, suppressXtVersionReply } from './suppress-device-status'

type HeadlessNs = {
  Terminal?: typeof headless.Terminal
  default?: { Terminal: typeof headless.Terminal }
}
const ns = headless as unknown as HeadlessNs
const Terminal = ns.Terminal ?? ns.default?.Terminal
if (!Terminal) throw new Error('could not resolve Terminal from @xterm/headless')

/** Feed `data` to a terminal and collect everything it emits on `onData`. */
function emitted(term: headless.Terminal, data: string): Promise<string> {
  return new Promise((resolve) => {
    let out = ''
    const sub = term.onData((d) => {
      out += d
    })
    term.write(data, () => {
      sub.dispose()
      resolve(out)
    })
  })
}

describe('suppressDeviceStatusReplies', () => {
  test('baseline: xterm DOES answer CPR when not suppressed', async () => {
    // Establishes that the test is measuring something real.
    const term = new Terminal({ allowProposedApi: true })
    expect(await emitted(term, '\x1b[6n'), 'unsuppressed CPR reply').toBe('\x1b[1;1R')
    term.dispose()
  })

  test('CPR (ESC[6n) produces no reply once suppressed', async () => {
    const term = new Terminal({ allowProposedApi: true })
    suppressDeviceStatusReplies(term)
    expect(await emitted(term, '\x1b[6n'), 'no reply generated').toBe('')
    term.dispose()
  })

  test('DECXCPR (ESC[?6n) produces no reply once suppressed', async () => {
    const term = new Terminal({ allowProposedApi: true })
    suppressDeviceStatusReplies(term)
    expect(await emitted(term, '\x1b[?6n'), 'no private-DSR reply').toBe('')
    term.dispose()
  })

  test('DSR status (ESC[5n) produces no reply once suppressed', async () => {
    const term = new Terminal({ allowProposedApi: true })
    suppressDeviceStatusReplies(term)
    expect(await emitted(term, '\x1b[5n'), 'no status reply').toBe('')
    term.dispose()
  })

  test('a flood of stored queries produces nothing (the replay case)', async () => {
    // The failure this exists for: a replayed buffer holding tens of thousands of
    // `?6n` used to make xterm answer them all at once, and Claude Code reads a
    // row=1 answer as "screen externally wiped" → `/clear` → new session.
    const term = new Terminal({ allowProposedApi: true })
    suppressDeviceStatusReplies(term)
    expect(await emitted(term, '\x1b[?6n'.repeat(5000)), 'silent under flood').toBe('')
    term.dispose()
  })

  test('queries the renderer SHOULD answer still work (DECRQM)', async () => {
    // Scope guard: suppression must be limited to the `n` final byte. DECRQM ends
    // in `$p` and programs use its reply for capability detection.
    const term = new Terminal({ allowProposedApi: true })
    suppressDeviceStatusReplies(term)
    const out = await emitted(term, '\x1b[?2026$p')
    expect(out.length, `DECRQM still answered, got ${JSON.stringify(out)}`).toBeGreaterThan(0)
    term.dispose()
  })

  test('normal output is unaffected', async () => {
    const term = new Terminal({ allowProposedApi: true })
    suppressDeviceStatusReplies(term)
    expect(await emitted(term, 'hello world\r\n'), 'plain text emits nothing').toBe('')
    expect(term.buffer.active.getLine(0)?.translateToString(true), 'text rendered').toBe('hello world')
    term.dispose()
  })

  test('cursor movement adjacent to a query still applies', async () => {
    // Returning true from the handler must not swallow the surrounding stream.
    const term = new Terminal({ allowProposedApi: true, rows: 24, cols: 80 })
    suppressDeviceStatusReplies(term)
    await emitted(term, '\x1b[10;20H\x1b[6nX')
    expect(term.buffer.active.cursorY, 'row moved').toBe(9)
    expect(term.buffer.active.cursorX, 'col moved + X written').toBe(20)
    term.dispose()
  })

  test('dispose() restores xterm built-in answering', async () => {
    const term = new Terminal({ allowProposedApi: true })
    const subs = suppressDeviceStatusReplies(term)
    expect(await emitted(term, '\x1b[6n'), 'suppressed while registered').toBe('')
    for (const s of subs) s.dispose()
    expect(await emitted(term, '\x1b[6n'), 'answering restored after dispose').toBe('\x1b[1;1R')
    term.dispose()
  })
})

// ── suppressXtVersionReply ──────────────────────────────────────────────────
// A replayed `ESC[>0q` has no asker left, so xterm's answer is an unsolicited
// DCS written straight into the live program's stdin — which wedges Claude
// Code's key handling (keys arrive, drive nothing; output still renders).

describe('suppressXtVersionReply', () => {
  test('baseline: xterm DOES answer XTVERSION with a DCS when not suppressed', async () => {
    // Establishes the poison is real and this test measures it.
    const term = new Terminal({ allowProposedApi: true })
    const out = await emitted(term, '\x1b[>0q')
    expect(out.startsWith('\x1bP>|xterm.js('), `expected DCS version reply, got ${JSON.stringify(out)}`).toBe(true)
    expect(out.endsWith('\x1b\\'), 'ST terminated').toBe(true)
    term.dispose()
  })

  test('XTVERSION (ESC[>0q) produces no reply once suppressed', async () => {
    const term = new Terminal({ allowProposedApi: true })
    suppressXtVersionReply(term)
    expect(await emitted(term, '\x1b[>0q'), 'no DCS injected into stdin').toBe('')
    term.dispose()
  })

  test('bare ESC[>q is suppressed too', async () => {
    const term = new Terminal({ allowProposedApi: true })
    suppressXtVersionReply(term)
    expect(await emitted(term, '\x1b[>q')).toBe('')
    term.dispose()
  })

  test('DECSCUSR (ESC[2 SP q) still applies — cursor style is not a query', async () => {
    // The `>` prefix is what scopes the handler; a bare `q` must stay xterm's.
    const term = new Terminal({ allowProposedApi: true })
    suppressXtVersionReply(term)
    expect(await emitted(term, '\x1b[2 qX'), 'DECSCUSR never replies anyway').toBe('')
    expect(term.buffer.active.cursorX, 'X still written — sequence not swallowed as text').toBe(1)
    term.dispose()
  })

  test('device-status suppression is unaffected by the XTVERSION handler', async () => {
    const term = new Terminal({ allowProposedApi: true })
    suppressDeviceStatusReplies(term)
    suppressXtVersionReply(term)
    expect(await emitted(term, '\x1b[6n'), 'CPR still suppressed').toBe('')
    expect(await emitted(term, '\x1b[>0q'), 'XTVERSION suppressed').toBe('')
    term.dispose()
  })

  test('dispose() restores xterm XTVERSION answering', async () => {
    const term = new Terminal({ allowProposedApi: true })
    const subs = suppressXtVersionReply(term)
    expect(await emitted(term, '\x1b[>0q'), 'suppressed while registered').toBe('')
    for (const s of subs) s.dispose()
    expect((await emitted(term, '\x1b[>0q')).startsWith('\x1bP>|xterm.js('), 'restored after dispose').toBe(true)
    term.dispose()
  })
})
