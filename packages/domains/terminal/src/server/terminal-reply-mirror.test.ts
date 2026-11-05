/**
 * TerminalReplyMirror — answers state-dependent terminal queries from a headless
 * copy of the session's screen, in stream order with the stateless replies.
 */
import { afterEach, expect, test } from 'vitest'
import { computeSyncQueryResponse } from './sync-query-response'
import { TerminalReplyMirror } from './terminal-reply-mirror'

const theme = { foreground: '#abcdef', background: '#123456', cursor: '#fedcba' }
const mirrors: TerminalReplyMirror[] = []
afterEach(() => {
  for (const m of mirrors.splice(0)) m.dispose()
})

function setup(cols = 80, rows = 24) {
  const replies: string[] = []
  const mirror = new TerminalReplyMirror(cols, rows, (d) => replies.push(d))
  mirrors.push(mirror)
  const feed = (chunk: string) => mirror.apply(computeSyncQueryResponse(chunk, theme).parts)
  return { mirror, replies, feed }
}

test('CPR answers the real cursor position', async () => {
  const { mirror, replies, feed } = setup()
  feed('hello\r\nab\x1b[6n')
  await mirror.drained()
  expect(replies).toEqual(['\x1b[2;3R'])
})

test('wide glyphs advance the cursor like the client terminal (unicode graphemes)', async () => {
  const { mirror, replies, feed } = setup()
  feed('😀👍🏽\x1b[6n')
  await mirror.drained()
  expect(replies).toEqual(['\x1b[1;5R'])
})

test('termenv probe: OSC 11 reply precedes the CPR reply', async () => {
  const { mirror, replies, feed } = setup()
  feed('\x1b]11;?\x1b\\\x1b[6n')
  await mirror.drained()
  expect(replies).toEqual(['\x1b]11;rgb:1212/3434/5656\x07', '\x1b[1;1R'])
})

test('a stateless reply after a pending mirror query waits its turn', async () => {
  const { mirror, replies, feed } = setup()
  feed('x\x1b[6n\x1b]11;?\x07')
  await mirror.drained()
  expect(replies).toEqual(['\x1b[1;2R', '\x1b]11;rgb:1212/3434/5656\x07'])
})

test('order holds across chunks', async () => {
  const { mirror, replies, feed } = setup()
  feed('ab\x1b[6n')
  feed('\x1b[c')
  await mirror.drained()
  expect(replies).toEqual(['\x1b[1;3R', '\x1b[?62;4;22c'])
})

test('a stateless reply with nothing pending is sent synchronously', () => {
  const { replies, feed } = setup()
  feed('\x1b[c')
  expect(replies).toEqual(['\x1b[?62;4;22c'])
})

test('DECRQM reports modes the program actually set', async () => {
  const { mirror, replies, feed } = setup()
  feed('\x1b[?2004$p\x1b[?2004h\x1b[?2004$p')
  await mirror.drained()
  expect(replies).toEqual(['\x1b[?2004;2$y', '\x1b[?2004;1$y'])
})

test('DECRQSS answered exactly as xterm.js answers it (its SGR report is always 0m)', async () => {
  const { mirror, replies, feed } = setup()
  feed('\x1b[1m\x1bP$qm\x1b\\')
  await mirror.drained()
  expect(replies).toEqual(['\x1bP1$r0m\x1b\\'])
})

test('DECXCPR stays unanswered (Claude Code reads a mis-timed answer as a wiped screen)', async () => {
  const { mirror, replies, feed } = setup()
  feed('ab\x1b[?6n')
  await mirror.drained()
  expect(replies).toEqual([])
})

test('resize is tracked', async () => {
  const { mirror, replies, feed } = setup(80, 24)
  feed('\x1b[24;80H')
  mirror.resize(40, 10)
  feed('\x1b[6n')
  await mirror.drained()
  expect(replies).toEqual(['\x1b[10;40R'])
})

test('nothing is sent after dispose', async () => {
  const { mirror, replies, feed } = setup()
  feed('\x1b[6n')
  mirror.dispose()
  await new Promise((r) => setTimeout(r, 20))
  expect(replies).toEqual([])
})
