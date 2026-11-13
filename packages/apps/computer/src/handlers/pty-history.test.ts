/**
 * A task terminal's output survives a computer restart: the computer saves each
 * task terminal's scrollback under its own state dir, and the next start of the
 * same session shows it first, then a divider, then the new process.
 *
 * Regression (QA 2026-11-06, task 964073b0 row 7a → task 5decc957): after an
 * app/computer restart a shell tab came back with a fresh prompt and none of its
 * history — scrollback lived only in the computer's memory.
 *
 * "Restart" here is the real thing for the computer's handlers: `disposeAll()` (what
 * shutdown runs) and a NEW `createPtyHandlers` over the same history dir. The pty is a
 * scripted fake, so the bytes are exact.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as nodePty from 'node-pty'
import type { ComputerConfig } from '../config'
import { createPtyHandlers } from './pty'
import { createPtyHistory, PTY_HISTORY_DIVIDER_TEXT } from '../pty-history'
import type { DirectBuffer } from '@slayzone/transport/direct'
import { DIRECT_RTC_MAX_MESSAGE_CHARS } from '../../../../shared/transport/src/direct/rtc-channel'
import { DIRECT_BUFFER_PAGE_CHARS } from '../../../../shared/transport/src/client/direct-pty-read'

const TASK = '5decc957-277f-4e1e-82a7-02fd3668df54'
const TAB = '3d5848be-0000-4000-8000-000000000001'
const SESSION = `${TASK}:${TAB}`

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const historyDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'slz-pty-history-'))
  dirs.push(d)
  return d
}

function ctx() {
  const config: ComputerConfig = {
    hubUrl: 'ws://localhost:0/computers',
    name: 'test',
    allowedRoots: [tmpdir(), process.cwd()],
    capabilities: ['pty']
  }
  return { dialer: { notify: () => true }, config, log: () => {} }
}

/** A pty whose output the test writes. */
function scriptedPty() {
  let onData: ((d: string) => void) | undefined
  let onExit: ((e: { exitCode: number; signal: number }) => void) | undefined
  const proc = {
    pid: 4321,
    kill: vi.fn(() => onExit?.({ exitCode: 0, signal: 1 })),
    write: vi.fn(),
    resize: vi.fn(),
    onData: (l: typeof onData) => {
      onData = l
      return { dispose() {} }
    },
    onExit: (l: typeof onExit) => {
      onExit = l
      return { dispose() {} }
    }
  } as unknown as nodePty.IPty
  return { proc, out: (d: string) => onData?.(d), exit: () => onExit?.({ exitCode: 0, signal: 0 }) }
}

function computer(dir: string) {
  const child = scriptedPty()
  const pty = createPtyHandlers(ctx(), undefined, {
    spawnPty: (() => child.proc) as unknown as typeof nodePty.spawn,
    history: createPtyHistory({ dir, flushMs: 20 })
  })
  const replay = async (sessionId = SESSION) => {
    const res = (await pty.handlers['pty.getReplay']({ sessionId, afterSeq: -1 })) as {
      prelude?: string
      chunks: Array<{ data: string }>
    }
    return (res.prelude ?? '') + res.chunks.map((c) => c.data).join('')
  }
  const spawn = (extra: Record<string, unknown> = {}) =>
    pty.handlers['pty.spawn']({
      sessionId: SESSION,
      taskId: TASK,
      command: '/bin/sh',
      cwd: process.cwd(),
      ...extra
    })
  return { pty, child, replay, spawn }
}

const settle = () => new Promise((r) => setTimeout(r, 80))

describe('task terminal history across a computer restart', () => {
  it('the old output comes back first, then a divider, then the new shell', async () => {
    const dir = historyDir()
    const before = computer(dir)
    await before.spawn()
    before.child.out('$ echo QA_RESTART_HISTORY_MARKER\r\nQA_RESTART_HISTORY_MARKER\r\n')
    for (let i = 1; i <= 250; i++) before.child.out(`${i}\r\n`)
    await settle()
    before.pty.disposeAll() // the computer shuts down

    const after = computer(dir) // a new computer process, same state dir
    await after.spawn()
    after.child.out('$ NEW_SHELL_PROMPT')
    const text = await after.replay()
    const marker = text.indexOf('QA_RESTART_HISTORY_MARKER')
    const divider = text.indexOf(PTY_HISTORY_DIVIDER_TEXT)
    const prompt = text.indexOf('NEW_SHELL_PROMPT')
    expect(marker).toBeGreaterThanOrEqual(0)
    expect(text).toContain('\r\n250\r\n')
    expect(divider).toBeGreaterThan(text.indexOf('\r\n250\r\n'))
    expect(prompt).toBeGreaterThan(divider)
    after.pty.disposeAll()
  })

  it('output still pending a write at shutdown is not lost', async () => {
    const dir = historyDir()
    const before = computer(dir)
    await before.spawn()
    before.child.out('WRITTEN_JUST_BEFORE_SHUTDOWN')
    before.pty.disposeAll() // no settle: the throttled write had not run yet
    const after = computer(dir)
    await after.spawn()
    expect(await after.replay()).toContain('WRITTEN_JUST_BEFORE_SHUTDOWN')
    after.pty.disposeAll()
  })

  it("a full-screen program's state is undone before the divider", async () => {
    const dir = historyDir()
    const before = computer(dir)
    await before.spawn()
    // An agent TUI on the alternate screen with mouse reporting and bracketed paste on.
    before.child.out('main screen line\r\n\x1b[?1049h\x1b[?1000h\x1b[?2004hTUI FRAME')
    before.pty.disposeAll()
    const after = computer(dir)
    await after.spawn()
    const text = await after.replay()
    const tail = text.slice(text.indexOf('TUI FRAME'), text.indexOf(PTY_HISTORY_DIVIDER_TEXT))
    expect(tail).toContain('\x1b[?1049l')
    expect(tail).toContain('\x1b[?1000l')
    expect(tail).toContain('\x1b[?2004l')
    after.pty.disposeAll()
  })

  it('a resuming agent reprints its own conversation: no restored output', async () => {
    const dir = historyDir()
    const before = computer(dir)
    await before.spawn({ detection: { mode: 'claude-code', resuming: false } })
    before.child.out('AGENT_TRANSCRIPT_LINE')
    before.pty.disposeAll()
    const after = computer(dir)
    await after.spawn({ detection: { mode: 'claude-code', resuming: true } })
    const text = await after.replay()
    expect(text).not.toContain('AGENT_TRANSCRIPT_LINE')
    expect(text).not.toContain(PTY_HISTORY_DIVIDER_TEXT)
    after.pty.disposeAll()
  })

  it('an agent starting fresh (nothing to resume) shows its previous output', async () => {
    const dir = historyDir()
    const before = computer(dir)
    await before.spawn({ detection: { mode: 'codex', resuming: false } })
    before.child.out('PREVIOUS_AGENT_OUTPUT')
    before.pty.disposeAll()
    const after = computer(dir)
    await after.spawn({ detection: { mode: 'codex', resuming: false } })
    expect(await after.replay()).toContain('PREVIOUS_AGENT_OUTPUT')
    after.pty.disposeAll()
  })

  it('a continuing spawn with its old buffer at hand adds nothing from disk', async () => {
    const dir = historyDir()
    const c = computer(dir)
    await c.spawn({ spawnId: 'agent-1', detection: { mode: 'codex', resuming: false } })
    c.child.out('AGENT_OUTPUT_ONCE\r\n')
    await settle()
    // A piped agent exits: its tombstone keeps the buffer for the recovery shell.
    c.child.exit()
    const reply = (await c.spawn({
      spawnId: 'shell-1',
      carryOutput: { fromSpawnId: 'agent-1', preamble: '[recovered]\r\n' }
    })) as { seq?: number }
    const text = await c.replay()
    expect(text.split('AGENT_OUTPUT_ONCE').length - 1).toBe(1)
    expect(text).not.toContain(PTY_HISTORY_DIVIDER_TEXT)
    expect(reply.seq).toBeGreaterThanOrEqual(0)
    c.pty.disposeAll()
  })

  // Regression vs v0.38.0 (82e4c7737 made the computer's ring buffer the only copy):
  // the computer restarted, the hub ended the agent (`computer-restarted`) and started
  // a recovery shell continuing the session (`carryOutput`). The NEW computer has no
  // tombstone, so the carried buffer held only the hub's preamble, the saved history
  // was skipped (a continuing spawn), and the new session's tracker overwrote the file
  // with that near-empty buffer — the agent's whole scrollback gone at the next reload.
  it('a recovery shell after a computer restart keeps the earlier output, under the seqs the hub already has', async () => {
    const dir = historyDir()
    const before = computer(dir)
    await before.spawn({ spawnId: 'agent-1' })
    before.child.out('$ claude\r\nAGENT_SCROLLBACK_MARKER\r\n')
    for (let i = 1; i <= 40; i++) before.child.out(`agent line ${i}\r\n`)
    await settle()
    before.pty.disposeAll() // the computer restarts; its tombstones go with it

    const after = computer(dir)
    const reply = (await after.spawn({
      spawnId: 'shell-1',
      carryOutput: {
        fromSpawnId: 'agent-1',
        preamble: '[SlayZone] claude exited. Switched to interactive shell for recovery.\r\n',
        afterSeq: 41
      }
    })) as { seq?: number }
    after.child.out('$ RECOVERY_SHELL_PROMPT')
    const res = (await after.pty.handlers['pty.getReplay']({
      sessionId: SESSION,
      afterSeq: -1
    })) as { prelude?: string; chunks: Array<{ seq: number; data: string }> }
    const text = (res.prelude ?? '') + res.chunks.map((c) => c.data).join('')
    const marker = text.indexOf('AGENT_SCROLLBACK_MARKER')
    expect(marker).toBeGreaterThanOrEqual(0)
    expect(text.split('AGENT_SCROLLBACK_MARKER').length - 1).toBe(1)
    expect(text.indexOf('Switched to interactive shell')).toBeGreaterThan(
      text.indexOf('agent line 40')
    )
    expect(text.indexOf('RECOVERY_SHELL_PROMPT')).toBeGreaterThan(
      text.indexOf('Switched to interactive shell')
    )
    // The restored output sits at or below the seq the hub already reached: never
    // streamed to a terminal that still shows it, never in a backfill after it.
    const restoredSeq = res.chunks.find((c) => c.data.includes('AGENT_SCROLLBACK_MARKER'))?.seq
    expect(restoredSeq).toBeLessThanOrEqual(41)
    expect(reply.seq).toBeGreaterThanOrEqual(42)
    const since = (await after.pty.handlers['pty.getBufferSince']({
      sessionId: SESSION,
      seq: 41
    })) as { frames: Array<{ data: string }> }
    expect(since.frames.map((f) => f.data).join('')).not.toContain('AGENT_SCROLLBACK_MARKER')

    // And the file keeps it: the next start (app reload, another restart) shows it too.
    await settle()
    after.pty.disposeAll()
    const third = computer(dir)
    await third.spawn()
    expect(await third.replay()).toContain('AGENT_SCROLLBACK_MARKER')
    third.pty.disposeAll()
  })

  it('a restored recovery shell numbers on even when the history outnumbers the seqs the hub names', async () => {
    const dir = historyDir()
    const before = computer(dir)
    await before.spawn()
    before.child.out(`BIG_HISTORY_HEAD${'x'.repeat(100 * 1024)}BIG_HISTORY_TAIL\r\n`)
    await settle()
    before.pty.disposeAll()
    const after = computer(dir)
    const reply = (await after.spawn({
      carryOutput: { preamble: '[recovered]\r\n', afterSeq: 0 }
    })) as { seq?: number }
    after.child.out('NEXT')
    const text = await after.replay()
    expect(text).toContain('BIG_HISTORY_TAIL')
    expect(text.indexOf('[recovered]')).toBeGreaterThan(text.indexOf('BIG_HISTORY_TAIL'))
    expect(text.indexOf('NEXT')).toBeGreaterThan(text.indexOf('[recovered]'))
    expect(reply.seq).toBeGreaterThan(0)
    after.pty.disposeAll()
  })

  // A replacement spawn (the hub restarted and starts the session again) stops the old
  // process, whose final write is still in flight: the file is up to a flush behind.
  // The old session's buffer is right here — it is what comes back, not the file.
  it('a replacement spawn restores the old session up to its last byte', async () => {
    const dir = historyDir()
    const c = computer(dir)
    await c.spawn()
    c.child.out('FLUSHED_OUTPUT\r\n')
    await settle()
    c.child.out('NOT_YET_FLUSHED_OUTPUT\r\n')
    await c.spawn() // same session, a new process: the old one is stopped first
    c.child.out('$ NEW_PROCESS')
    const text = await c.replay()
    expect(text).toContain('FLUSHED_OUTPUT')
    expect(text).toContain('NOT_YET_FLUSHED_OUTPUT')
    expect(text.split('NOT_YET_FLUSHED_OUTPUT').length - 1).toBe(1)
    expect(text.indexOf('NEW_PROCESS')).toBeGreaterThan(text.indexOf(PTY_HISTORY_DIVIDER_TEXT))
    c.pty.disposeAll()
  })

  it('a cleared terminal saves the cleared buffer, not the output before the clear', async () => {
    const dir = historyDir()
    const before = computer(dir)
    await before.spawn()
    before.child.out('BEFORE_CLEAR\r\n')
    await settle()
    await before.pty.handlers['pty.clearBuffer']({ sessionId: SESSION })
    before.child.out('AFTER_CLEAR\r\n')
    await settle()
    before.child.out('AFTER_CLEAR_UNFLUSHED\r\n')
    before.pty.disposeAll()
    const after = computer(dir)
    await after.spawn()
    const text = await after.replay()
    expect(text).not.toContain('BEFORE_CLEAR')
    expect(text).toContain('AFTER_CLEAR\r\nAFTER_CLEAR_UNFLUSHED')
    after.pty.disposeAll()
  })

  it('the hub killing the session (close, restart) forgets its output', async () => {
    const dir = historyDir()
    const before = computer(dir)
    await before.spawn()
    before.child.out('KILLED_SESSION_OUTPUT')
    await settle()
    await before.pty.handlers['pty.kill']({ sessionId: SESSION })
    await settle()
    before.pty.disposeAll()
    const after = computer(dir)
    await after.spawn()
    expect(await after.replay()).not.toContain('KILLED_SESSION_OUTPUT')
    after.pty.disposeAll()
  })

  it('a deleted tab (pty.forget) and a purged task (stopTask deleted) leave no file', async () => {
    const dir = historyDir()
    const c = computer(dir)
    await c.spawn()
    c.child.out('x')
    await settle()
    c.pty.disposeAll()
    expect(readdirSync(join(dir, TASK))).toHaveLength(1)
    const d = computer(dir)
    await d.pty.handlers['pty.forget']({ sessionId: SESSION, taskId: TASK })
    expect(existsSync(join(dir, TASK)) ? readdirSync(join(dir, TASK)) : []).toHaveLength(0)

    await d.spawn()
    d.child.out('y')
    await settle()
    await d.pty.stopTask(TASK, 'paused')
    expect(readdirSync(join(dir, TASK))).toHaveLength(1) // trashed: kept for a restore
    await d.pty.stopTask(TASK, 'deleted')
    expect(existsSync(join(dir, TASK))).toBe(false)
    d.pty.disposeAll()
  })

  it('history files are private to the user, and stale ones are swept at start', async () => {
    const dir = historyDir()
    const c = computer(dir)
    await c.spawn()
    c.child.out('private')
    await settle()
    c.pty.disposeAll()
    const [file] = readdirSync(join(dir, TASK))
    expect(statSync(join(dir, TASK, file)).mode & 0o777).toBe(0o600)
    const old = new Date(Date.now() - 31 * 24 * 3600 * 1000)
    utimesSync(join(dir, TASK, file), old, old)
    await createPtyHistory({ dir, flushMs: 20 }).sweep()
    expect(existsSync(join(dir, TASK))).toBe(false)
  })
})

describe('a restored terminal over the direct link (docs/direct-link.md)', () => {
  it('attached directly after a restart: restored output first, once, then live output once, every page within the message cap', async () => {
    const dir = historyDir()
    const before = computer(dir)
    await before.spawn()
    // A big scrollback full of escapes: its serialised size is several times its length.
    const line = (i: number) =>
      `\x1b[32m${String(i).padStart(6, '0')}${'\x1b[1m\x1b[0m'.repeat(8)}\r\n`
    for (let i = 0; i < 9_000; i++) before.child.out(line(i))
    await settle()
    before.pty.disposeAll()

    const after = computer(dir)
    await after.spawn()
    after.child.out('$ LIVE_BEFORE_ATTACH\r\n')
    const attach = async (afterSeq: number) => {
      const pages: DirectBuffer[] = []
      let page = after.pty.direct.attach(SESSION, afterSeq, DIRECT_BUFFER_PAGE_CHARS).buffer
      pages.push(page)
      while (page.more) {
        page = after.pty.direct.getBufferSince(
          SESSION,
          page.chunks.at(-1)?.seq ?? afterSeq,
          DIRECT_BUFFER_PAGE_CHARS
        )
        pages.push(page)
      }
      return pages
    }
    const pages = await attach(-1)
    // Each page fits one direct message (WebRTC caps a message at 1 MiB).
    for (const p of pages)
      expect(JSON.stringify(p).length).toBeLessThan(DIRECT_RTC_MAX_MESSAGE_CHARS)
    const chunks = pages.flatMap((p) => p.chunks)
    chunks.forEach((c, i) => expect(c.seq).toBe(i === 0 ? chunks[0]!.seq : chunks[i - 1]!.seq + 1))
    const text = (pages[0]?.prelude ?? '') + chunks.map((c) => c.data).join('')
    const last = line(8_999)
    expect(text.split(last).length - 1).toBe(1)
    expect(text.split(PTY_HISTORY_DIVIDER_TEXT).length - 1).toBe(1)
    expect(text.indexOf(PTY_HISTORY_DIVIDER_TEXT)).toBeGreaterThan(text.indexOf(last))
    expect(text.indexOf('LIVE_BEFORE_ATTACH')).toBeGreaterThan(
      text.indexOf(PTY_HISTORY_DIVIDER_TEXT)
    )

    // Live output after the attach reaches the direct watcher once, after it.
    const live: Array<{ seq: number; data: string }> = []
    const stop = after.pty.direct.watch(
      SESSION,
      (c) => live.push(c),
      () => undefined
    )
    after.child.out('LIVE_AFTER_ATTACH\r\n')
    expect(live.map((c) => c.data)).toEqual(['LIVE_AFTER_ATTACH\r\n'])
    expect(live[0]?.seq).toBe((chunks.at(-1)?.seq ?? -1) + 1)
    // A backfill from the last seq read finds only that.
    const since = after.pty.direct.getBufferSince(SESSION, chunks.at(-1)!.seq)
    expect(since.chunks.map((c) => c.data)).toEqual(['LIVE_AFTER_ATTACH\r\n'])
    stop?.()
    after.pty.disposeAll()
  })
})
