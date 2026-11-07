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

  it('a continuing spawn (the hub still has the output) restores nothing', async () => {
    const dir = historyDir()
    const before = computer(dir)
    await before.spawn()
    before.child.out('ALREADY_ON_SCREEN')
    before.pty.disposeAll()
    const after = computer(dir)
    await after.spawn({ carryOutput: { preamble: '', afterSeq: 5 } })
    expect(await after.replay()).not.toContain('ALREADY_ON_SCREEN')
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
