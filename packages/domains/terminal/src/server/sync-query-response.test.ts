/**
 * Tests for computeSyncQueryResponse — the pure logic behind interceptSyncQueries.
 */
import { expect, test } from 'vitest'
import { createRequire } from 'node:module'
import { computeSyncQueryResponse, XTVERSION_RESPONSE } from './sync-query-response'

const theme = { foreground: '#abcdef', background: '#123456', cursor: '#fedcba' }

test('DA1 — primary device attributes', () => {
  const r = computeSyncQueryResponse('\x1b[c', theme)
  expect(r.response).toBe('\x1b[?62;4;22c')
  expect(r.forwarded).toBe('')
})

test('DA2 — secondary device attributes', () => {
  const r = computeSyncQueryResponse('\x1b[>c', theme)
  expect(r.response).toBe('\x1b[>0;10;1c')
  expect(r.forwarded).toBe('')
})

test('DSR — device status report', () => {
  const r = computeSyncQueryResponse('\x1b[5n', theme)
  expect(r.response).toBe('\x1b[0n')
  expect(r.forwarded).toBe('')
})

test('CPR — cursor position report', () => {
  const r = computeSyncQueryResponse('\x1b[6n', theme)
  expect(r.response).toBe('\x1b[1;1R')
  expect(r.forwarded).toBe('')
})

test('OSC 10 fg color query answered from theme', () => {
  const r = computeSyncQueryResponse('\x1b]10;?\x07', theme)
  expect(r.response).toBe('\x1b]10;rgb:abab/cdcd/efef\x07')
  expect(r.forwarded).toBe('')
})

test('OSC 11 bg color query answered from theme', () => {
  const r = computeSyncQueryResponse('\x1b]11;?\x07', theme)
  expect(r.response).toBe('\x1b]11;rgb:1212/3434/5656\x07')
  expect(r.forwarded).toBe('')
})

test('OSC 12 cursor color query answered from theme', () => {
  const r = computeSyncQueryResponse('\x1b]12;?\x07', theme)
  expect(r.response).toBe('\x1b]12;rgb:fefe/dcdc/baba\x07')
  expect(r.forwarded).toBe('')
})

test('OSC 4 palette query — index 0 (black) from xterm defaults', () => {
  const r = computeSyncQueryResponse('\x1b]4;0;?\x07', theme)
  expect(r.response).toBe('\x1b]4;0;rgb:0000/0000/0000\x07')
  expect(r.forwarded).toBe('')
})

test('OSC 4 palette query — index 9 (bright red)', () => {
  const r = computeSyncQueryResponse('\x1b]4;9;?\x07', theme)
  expect(r.response).toBe('\x1b]4;9;rgb:ffff/0000/0000\x07')
  expect(r.forwarded).toBe('')
})

test('OSC 4 palette query — index 42 (out of 0-15 range) falls through to catch-all', () => {
  const r = computeSyncQueryResponse('\x1b]4;42;?\x07', theme)
  // Catch-all reply is empty of the form ESC ] 4 ; ST — note the body is stripped.
  expect(r.response).toBe('\x1b]4;\x07')
  expect(r.forwarded).toBe('')
})

test('OSC 4 uses theme.ansi when provided (overrides xterm defaults)', () => {
  const ansi = [
    '#111111',
    '#222222',
    '#333333',
    '#444444',
    '#555555',
    '#666666',
    '#777777',
    '#888888',
    '#999999',
    '#aaaaaa',
    '#bbbbbb',
    '#cccccc',
    '#dddddd',
    '#eeeeee',
    '#ff0000',
    '#00ff00'
  ]
  const themed = { ...theme, ansi }
  const r = computeSyncQueryResponse('\x1b]4;0;?\x07\x1b]4;14;?\x07', themed)
  expect(r.response).toBe('\x1b]4;0;rgb:1111/1111/1111\x07\x1b]4;14;rgb:ffff/0000/0000\x07')
  expect(r.forwarded).toBe('')
})

test('OSC 4 falls back to xterm defaults when theme.ansi is undefined', () => {
  const r = computeSyncQueryResponse('\x1b]4;0;?\x07', theme)
  expect(r.response).toBe('\x1b]4;0;rgb:0000/0000/0000\x07')
})

test('OSC 4 falls back to xterm defaults when theme.ansi is a short array', () => {
  const themed = { ...theme, ansi: ['#112233'] } // only index 0 provided
  const r = computeSyncQueryResponse('\x1b]4;5;?\x07', themed)
  // Index 5 not in ansi → falls back to XTERM_ANSI_PALETTE[5] = magenta #cd00cd
  expect(r.response).toBe('\x1b]4;5;rgb:cdcd/0000/cdcd\x07')
})

test('catch-all — unknown OSC 52 (clipboard) gets empty reply', () => {
  const r = computeSyncQueryResponse('\x1b]52;c;?\x07', theme)
  expect(r.response).toBe('\x1b]52;\x07')
  expect(r.forwarded).toBe('')
})

test('catch-all — OSC 7 cwd query gets empty reply', () => {
  const r = computeSyncQueryResponse('\x1b]7;?\x07', theme)
  expect(r.response).toBe('\x1b]7;\x07')
  expect(r.forwarded).toBe('')
})

test('catch-all — OSC with ST terminator (ESC \\)', () => {
  const r = computeSyncQueryResponse('\x1b]99;?\x1b\\', theme)
  expect(r.response).toBe('\x1b]99;\x07')
  expect(r.forwarded).toBe('')
})

test('non-query OSC sequences are passed through unchanged', () => {
  // OSC 0 title set (no trailing ?) must NOT be consumed.
  const input = '\x1b]0;my-title\x07hello'
  const r = computeSyncQueryResponse(input, theme)
  expect(r.response).toBe('')
  expect(r.forwarded).toBe(input)
})

test('plain output passed through unchanged', () => {
  const r = computeSyncQueryResponse('hello world\n', theme)
  expect(r.response).toBe('')
  expect(r.forwarded).toBe('hello world\n')
})

test('mixed — DA1 + OSC 11 + plain text — all answered, text preserved', () => {
  const r = computeSyncQueryResponse('before\x1b[cmiddle\x1b]11;?\x07after', theme)
  expect(r.response).toBe('\x1b[?62;4;22c\x1b]11;rgb:1212/3434/5656\x07')
  expect(r.forwarded).toBe('beforemiddleafter')
})

test('trailing partial OSC held for next chunk', () => {
  const r = computeSyncQueryResponse('done\x1b]4;0;?', theme)
  // The OSC lacks a terminator so it must be held, not consumed.
  expect(r.response).toBe('')
  expect(r.forwarded).toBe('done')
  expect(r.pendingPartial).toBe('\x1b]4;0;?')
})

test('trailing partial CSI held for next chunk', () => {
  const r = computeSyncQueryResponse('data\x1b[0', theme)
  expect(r.response).toBe('')
  expect(r.forwarded).toBe('data')
  expect(r.pendingPartial).toBe('\x1b[0')
})

test('lone trailing ESC held (possible ST start)', () => {
  const r = computeSyncQueryResponse('data\x1b', theme)
  expect(r.response).toBe('')
  expect(r.forwarded).toBe('data')
  expect(r.pendingPartial).toBe('\x1b')
})

// DEC PRIVATE sequences split across a chunk boundary. The `?` intermediate must
// be part of the held prefix, or a chunk ending `ESC [ ? 6` is forwarded verbatim
// and its `n` arrives orphaned in the next chunk — the query then slips past both
// the answerer here AND the per-chunk strip in filterBufferData, landing in the
// replay buffer where xterm.js later answers it (the /clear-loop trigger).
test('trailing partial DEC private CSI held for next chunk', () => {
  const r = computeSyncQueryResponse('data\x1b[?6', theme)
  expect(r.response).toBe('')
  expect(r.forwarded).toBe('data')
  expect(r.pendingPartial).toBe('\x1b[?6')
})

test('lone trailing ESC [ ? held (private-mode introducer)', () => {
  const r = computeSyncQueryResponse('data\x1b[?', theme)
  expect(r.forwarded).toBe('data')
  expect(r.pendingPartial).toBe('\x1b[?')
})

test('DECXCPR split across two chunks reassembles into one whole sequence', () => {
  const r1 = computeSyncQueryResponse('pre\x1b[?6', theme)
  expect(r1.forwarded).toBe('pre')
  expect(r1.pendingPartial).toBe('\x1b[?6')
  const r2 = computeSyncQueryResponse(r1.pendingPartial + 'npost', theme)
  // Unanswered by design (strip-only), but it MUST emerge intact so the
  // downstream per-chunk filter can recognise and drop it.
  expect(r2.forwarded).toBe('\x1b[?6npost')
})

test('answers query assembled across two chunks', () => {
  const r1 = computeSyncQueryResponse('pre\x1b]4;0;?', theme)
  expect(r1.pendingPartial).toBe('\x1b]4;0;?')
  expect(r1.forwarded).toBe('pre')
  const r2 = computeSyncQueryResponse(r1.pendingPartial + '\x07post', theme)
  expect(r2.response).toBe('\x1b]4;0;rgb:0000/0000/0000\x07')
  expect(r2.forwarded).toBe('post')
})

// ---------------------------------------------------------------------------
// Bounded OSC hold
//
// The CSI branch of the partial-hold pattern self-bounds: its param class
// [?<>0-9;:] breaks on any text byte, so the hold releases. The OSC branch's
// [^\x07\x1b]* matches everything that is not BEL or ESC — so once a chunk ends
// inside an OSC body, the hold grows without limit and NOTHING is forwarded.
// Symptom is a FROZEN terminal, not a scrambled one: output stops appearing
// until some ESC finally arrives (which a resize supplies via SIGWINCH redraw —
// the same "resize fixes it" signature as the atlas scramble, different cause).
//
// Every query we answer is <= ~14 bytes (`ESC]4;255;?BEL`), so a 32-byte cap
// covers the hold's entire purpose. Past the cap we forward verbatim: bytes stay
// contiguous, the terminal's own parser reassembles them, and the only thing
// given up is answering a query torn past 32 bytes — which cannot happen.
// ---------------------------------------------------------------------------

test('does not hold an unbounded OSC body — output keeps flowing', () => {
  // A title-ish OSC that never terminates in this chunk. Pre-fix this returned
  // forwarded:'' and held the whole thing, so three plain lines produced ZERO
  // output.
  const long = '\x1b]0;' + 'a'.repeat(200)
  const r = computeSyncQueryResponse(long, theme)
  expect(r.pendingPartial, 'nothing held past the cap').toBe('')
  expect(r.forwarded, 'forwarded verbatim instead of swallowed').toBe(long)
})

test('plain text after an OSC-open chunk is emitted, not swallowed', () => {
  const r1 = computeSyncQueryResponse('\x1b]0;some title text that runs on and on and on', theme)
  const r2 = computeSyncQueryResponse('line one\nline two\nline three\n', theme)
  // The second chunk contains no ESC at all — it must never be held.
  expect(r2.pendingPartial).toBe('')
  expect(r2.forwarded).toBe('line one\nline two\nline three\n')
  // And the first chunk was not silently eaten either.
  expect(r1.forwarded + r2.forwarded !== '', 'output was produced').toBe(true)
})

test('a SHORT partial OSC is still held (the split-query case the hold exists for)', () => {
  // Regression guard on the fix: capping must not break answering a genuine
  // query torn across chunks.
  const r1 = computeSyncQueryResponse('pre\x1b]11;?', theme)
  expect(r1.pendingPartial, 'short partial still held').toBe('\x1b]11;?')
  expect(r1.forwarded).toBe('pre')
  const r2 = computeSyncQueryResponse(r1.pendingPartial + '\x07post', theme)
  expect(r2.response, 'reassembled query still answered').toBe('\x1b]11;rgb:1212/3434/5656\x07')
  expect(r2.forwarded).toBe('post')
})

test('an OSC body exactly at the cap is held; one byte over is forwarded', () => {
  // Boundary check so the cap cannot silently drift.
  const atCap = '\x1b]0;' + 'x'.repeat(32 - 4)
  expect(atCap.length).toBe(32)
  expect(computeSyncQueryResponse(atCap, theme).pendingPartial, 'exactly 32 held').toBe(atCap)
  const overCap = atCap + 'y'
  expect(computeSyncQueryResponse(overCap, theme).pendingPartial, '33 forwarded').toBe('')
})

test('nothing is lost across the cap boundary', () => {
  // The module-wide invariant: forwarded + pendingPartial must reconstruct the
  // input minus whatever was answered.
  for (const body of ['', 'a', 'a'.repeat(28), 'a'.repeat(29), 'a'.repeat(100)]) {
    const input = '\x1b]0;' + body
    const r = computeSyncQueryResponse(input, theme)
    expect(r.forwarded + r.pendingPartial, `body length ${body.length}`).toBe(input)
  }
})

// ---------------------------------------------------------------------------
// The OSC catch-all must not eat titles
//
// The catch-all answers "any remaining OSC query" so Bun-compiled CLIs don't hang
// waiting on a reply. But it keys off the body merely ENDING in `?`, and a window
// title is free text — `ESC]0;build ok?BEL` matches. Two things then go wrong at
// once: the title sequence is deleted from the output, AND a bogus `ESC]0;BEL`
// reply is injected into the program's stdin as if the user typed it.
//
// OSC 0/1/2 are title-setting and are never queries, so they are excluded. OSC 52
// stays in: `ESC]52;c;?BEL` is a genuine clipboard READ and the empty reply is a
// valid "clipboard unavailable" answer.
// ---------------------------------------------------------------------------

test('a window title ending in ? is neither deleted nor answered', () => {
  const title = '\x1b]0;build ok?\x07'
  const r = computeSyncQueryResponse(title, theme)
  expect(r.forwarded, 'title forwarded intact').toBe(title)
  expect(r.response, 'no reply injected into stdin').toBe('')
})

test('OSC 1 and OSC 2 titles ending in ? are left alone too', () => {
  for (const n of ['1', '2']) {
    const title = `\x1b]${n};done?\x07`
    const r = computeSyncQueryResponse(title, theme)
    expect(r.forwarded, `OSC ${n} forwarded`).toBe(title)
    expect(r.response, `OSC ${n} unanswered`).toBe('')
  }
})

test('OSC 2 title with a ? mid-string is untouched', () => {
  const title = '\x1b]2;what? now\x07'
  const r = computeSyncQueryResponse(title, theme)
  expect(r.forwarded).toBe(title)
  expect(r.response).toBe('')
})

test('OSC 52 clipboard read is still answered (catch-all keeps its purpose)', () => {
  const r = computeSyncQueryResponse('\x1b]52;c;?\x07', theme)
  expect(r.response, 'empty clipboard reply so the program does not hang').toBe('\x1b]52;\x07')
  expect(r.forwarded).toBe('')
})

test('an unknown OSC query still gets an empty reply', () => {
  // The reason the catch-all exists — do not regress it while fixing titles.
  const r = computeSyncQueryResponse('\x1b]777;something;?\x07', theme)
  expect(r.response).toBe('\x1b]777;\x07')
  expect(r.forwarded).toBe('')
})

// ── XTVERSION ───────────────────────────────────────────────────────────────
// Regression: leaving `CSI > Ps q` to the renderer let xterm.js answer it with a
// DCS (`ESC P >|xterm.js(...) ESC \`) over the async onData path. That reply is
// stale by construction, AND the query survived into the replayable ring buffer,
// so every mount/reattach replayed it and xterm answered again — unsolicited,
// straight into the live program's stdin. Claude Code's key handling wedges on
// that DCS: keystrokes still arrive but drive nothing, while output keeps
// rendering. Reproduced by injecting the reply into a healthy session.

test('XTVERSION — CSI > 0 q answered synchronously and stripped', () => {
  const r = computeSyncQueryResponse('\x1b[>0q', theme)
  expect(r.response).toBe(XTVERSION_RESPONSE)
  expect(r.forwarded, 'must not reach the renderer or the replay buffer').toBe('')
})

test('XTVERSION — bare CSI > q (no param) is the same query', () => {
  const r = computeSyncQueryResponse('\x1b[>q', theme)
  expect(r.response).toBe(XTVERSION_RESPONSE)
  expect(r.forwarded).toBe('')
})

test('XTVERSION reply is byte-identical to what xterm.js would have sent', () => {
  // Only the timing and the authority change — never the bytes the program reads.
  const require_ = createRequire(import.meta.url)
  const { version } = require_('@xterm/xterm/package.json') as { version: string }
  expect(
    XTVERSION_RESPONSE,
    'drifted from the installed @xterm/xterm — update XTERM_JS_VERSION'
  ).toBe(`\x1bP>|xterm.js(${version})\x1b\\`)
})

test('CSI > Ps q with Ps > 0 is not a version request — left alone', () => {
  // xterm.js only answers when params[0] <= 0; mirror that or we invent replies.
  const r = computeSyncQueryResponse('\x1b[>1q', theme)
  expect(r.response).toBe('')
  expect(r.forwarded).toBe('\x1b[>1q')
})

test('DECSCUSR (CSI Ps SP q) is untouched — no > prefix, not a query', () => {
  const r = computeSyncQueryResponse('\x1b[2 q', theme)
  expect(r.response).toBe('')
  expect(r.forwarded).toBe('\x1b[2 q')
})

test('XTVERSION torn across chunks is held, not forwarded half-answered', () => {
  const a = computeSyncQueryResponse('text\x1b[>0', theme)
  expect(a.forwarded, 'complete prefix released').toBe('text')
  expect(a.pendingPartial, 'incomplete query held for the next chunk').toBe('\x1b[>0')
  expect(a.response, 'nothing answered yet').toBe('')
  const b = computeSyncQueryResponse(a.pendingPartial + 'q', theme)
  expect(b.response, 'answered once reassembled').toBe(XTVERSION_RESPONSE)
  expect(b.forwarded).toBe('')
})
