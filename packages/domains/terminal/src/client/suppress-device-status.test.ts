/**
 * Tests for suppressDeviceStatusReplies, driven against a REAL xterm parser via
 * `@xterm/headless` — the whole point is that xterm's own `deviceStatus` handler
 * stops firing, which a stub cannot demonstrate.
 *
 * Run with: pnpm exec tsx packages/domains/terminal/src/client/suppress-device-status.test.ts
 */
// `@xterm/headless` ships CJS only. Under tsx's ESM interop the class can land on
// the namespace object OR under `.default`, so resolve both rather than pinning to
// whichever shape today's loader produces.
import * as headless from '@xterm/headless'
import { suppressDeviceStatusReplies, suppressXtVersionReply } from './suppress-device-status'

type HeadlessNs = { Terminal?: typeof headless.Terminal; default?: { Terminal: typeof headless.Terminal } }
const ns = headless as unknown as HeadlessNs
const Terminal = ns.Terminal ?? ns.default?.Terminal
if (!Terminal) throw new Error('could not resolve Terminal from @xterm/headless')

let passed = 0
let failed = 0

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ✓ ${name}`)
      passed++
    })
    .catch((e: unknown) => {
      console.error(`  ✗ ${name}`)
      console.error(`    ${e instanceof Error ? e.message : String(e)}`)
      failed++
    })
}

function eq<T>(actual: T, expected: T, label?: string): void {
  if (actual !== expected) {
    const show = (v: unknown) =>
      typeof v === 'string' ? JSON.stringify(v.replace(/\x1b/g, 'ESC')) : JSON.stringify(v)
    throw new Error(`${label ? label + ': ' : ''}expected ${show(expected)}, got ${show(actual)}`)
  }
}

/** Feed `data` to a terminal and collect everything it emits on `onData`. */
function emitted(term: Terminal, data: string): Promise<string> {
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

console.log('\nsuppressDeviceStatusReplies')
console.log('─'.repeat(40))

await test('baseline: xterm DOES answer CPR when not suppressed', async () => {
  // Establishes that the test is measuring something real.
  const term = new Terminal({ allowProposedApi: true })
  eq(await emitted(term, '\x1b[6n'), '\x1b[1;1R', 'unsuppressed CPR reply')
  term.dispose()
})

await test('CPR (ESC[6n) produces no reply once suppressed', async () => {
  const term = new Terminal({ allowProposedApi: true })
  suppressDeviceStatusReplies(term)
  eq(await emitted(term, '\x1b[6n'), '', 'no reply generated')
  term.dispose()
})

await test('DECXCPR (ESC[?6n) produces no reply once suppressed', async () => {
  const term = new Terminal({ allowProposedApi: true })
  suppressDeviceStatusReplies(term)
  eq(await emitted(term, '\x1b[?6n'), '', 'no private-DSR reply')
  term.dispose()
})

await test('DSR status (ESC[5n) produces no reply once suppressed', async () => {
  const term = new Terminal({ allowProposedApi: true })
  suppressDeviceStatusReplies(term)
  eq(await emitted(term, '\x1b[5n'), '', 'no status reply')
  term.dispose()
})

await test('a flood of stored queries produces nothing (the replay case)', async () => {
  // The failure this exists for: a replayed buffer holding tens of thousands of
  // `?6n` used to make xterm answer them all at once, and Claude Code reads a
  // row=1 answer as "screen externally wiped" → `/clear` → new session.
  const term = new Terminal({ allowProposedApi: true })
  suppressDeviceStatusReplies(term)
  eq(await emitted(term, '\x1b[?6n'.repeat(5000)), '', 'silent under flood')
  term.dispose()
})

await test('queries the renderer SHOULD answer still work (DECRQM)', async () => {
  // Scope guard: suppression must be limited to the `n` final byte. DECRQM ends
  // in `$p` and programs use its reply for capability detection.
  const term = new Terminal({ allowProposedApi: true })
  suppressDeviceStatusReplies(term)
  const out = await emitted(term, '\x1b[?2026$p')
  eq(out.length > 0, true, `DECRQM still answered, got ${JSON.stringify(out)}`)
  term.dispose()
})

await test('normal output is unaffected', async () => {
  const term = new Terminal({ allowProposedApi: true })
  suppressDeviceStatusReplies(term)
  eq(await emitted(term, 'hello world\r\n'), '', 'plain text emits nothing')
  eq(term.buffer.active.getLine(0)?.translateToString(true), 'hello world', 'text rendered')
  term.dispose()
})

await test('cursor movement adjacent to a query still applies', async () => {
  // Returning true from the handler must not swallow the surrounding stream.
  const term = new Terminal({ allowProposedApi: true, rows: 24, cols: 80 })
  suppressDeviceStatusReplies(term)
  await emitted(term, '\x1b[10;20H\x1b[6nX')
  eq(term.buffer.active.cursorY, 9, 'row moved')
  eq(term.buffer.active.cursorX, 20, 'col moved + X written')
  term.dispose()
})

await test('dispose() restores xterm built-in answering', async () => {
  const term = new Terminal({ allowProposedApi: true })
  const subs = suppressDeviceStatusReplies(term)
  eq(await emitted(term, '\x1b[6n'), '', 'suppressed while registered')
  for (const s of subs) s.dispose()
  eq(await emitted(term, '\x1b[6n'), '\x1b[1;1R', 'answering restored after dispose')
  term.dispose()
})

// ── suppressXtVersionReply ──────────────────────────────────────────────────
// A replayed `ESC[>0q` has no asker left, so xterm's answer is an unsolicited
// DCS written straight into the live program's stdin — which wedges Claude
// Code's key handling (keys arrive, drive nothing; output still renders).

await test('baseline: xterm DOES answer XTVERSION with a DCS when not suppressed', async () => {
  // Establishes the poison is real and this test measures it.
  const term = new Terminal({ allowProposedApi: true })
  const out = await emitted(term, '\x1b[>0q')
  eq(out.startsWith('\x1bP>|xterm.js('), true, `expected DCS version reply, got ${JSON.stringify(out)}`)
  eq(out.endsWith('\x1b\\'), true, 'ST terminated')
  term.dispose()
})

await test('XTVERSION (ESC[>0q) produces no reply once suppressed', async () => {
  const term = new Terminal({ allowProposedApi: true })
  suppressXtVersionReply(term)
  eq(await emitted(term, '\x1b[>0q'), '', 'no DCS injected into stdin')
  term.dispose()
})

await test('bare ESC[>q is suppressed too', async () => {
  const term = new Terminal({ allowProposedApi: true })
  suppressXtVersionReply(term)
  eq(await emitted(term, '\x1b[>q'), '')
  term.dispose()
})

await test('DECSCUSR (ESC[2 SP q) still applies — cursor style is not a query', async () => {
  // The `>` prefix is what scopes the handler; a bare `q` must stay xterm's.
  const term = new Terminal({ allowProposedApi: true })
  suppressXtVersionReply(term)
  eq(await emitted(term, '\x1b[2 qX'), '', 'DECSCUSR never replies anyway')
  eq(term.buffer.active.cursorX, 1, 'X still written — sequence not swallowed as text')
  term.dispose()
})

await test('device-status suppression is unaffected by the XTVERSION handler', async () => {
  const term = new Terminal({ allowProposedApi: true })
  suppressDeviceStatusReplies(term)
  suppressXtVersionReply(term)
  eq(await emitted(term, '\x1b[6n'), '', 'CPR still suppressed')
  eq(await emitted(term, '\x1b[>0q'), '', 'XTVERSION suppressed')
  term.dispose()
})

await test('dispose() restores xterm XTVERSION answering', async () => {
  const term = new Terminal({ allowProposedApi: true })
  const subs = suppressXtVersionReply(term)
  eq(await emitted(term, '\x1b[>0q'), '', 'suppressed while registered')
  for (const s of subs) s.dispose()
  eq((await emitted(term, '\x1b[>0q')).startsWith('\x1bP>|xterm.js('), true, 'restored after dispose')
  term.dispose()
})

console.log('─'.repeat(40))
console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed > 0 ? 1 : 0)
