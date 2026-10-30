/**
 * Chat A (plan 3.10): never two processes on one Claude conversation. The
 * terminal side: a terminal agent does not resume a conversation a chat process
 * of the same task runs, it says why; it reports the conversations it runs; and
 * releasing one kills its session and waits for the exit. Fake pty + stub db —
 * no real shell spawns.
 */
import { afterEach, expect, test } from 'vitest'
import type { SlayzoneDb } from '@slayzone/platform'
import type { PtySessionWindow } from '../pty-host'
import { createPty, killPty, setConversationResolver, setDatabase } from './pty-manager'
import { setPtyBackend, type PtyBackend } from './pty-backend'
import { createFakeTaskSessionStore } from './fake-task-session-store'
import {
  isConversationLive,
  registerConversationHolder,
  releaseConversation
} from './live-conversations'

interface FakePty {
  pid: number
  process: string
  written: string[]
  killed: number
  onData: (cb: (d: string) => void) => { dispose: () => void }
  onExit: (cb: (e: { exitCode: number }) => void) => { dispose: () => void }
  write: (s: string) => void
  kill: (sig?: string) => void
  resize: (c: number, r: number) => void
}

/** A pty that exits (asynchronously) when killed, like the real one. */
function makeFakePty(): FakePty {
  const exits: Array<(e: { exitCode: number }) => void> = []
  return {
    pid: 4343,
    process: 'zsh',
    written: [],
    killed: 0,
    onData() {
      return { dispose() {} }
    },
    onExit(cb) {
      exits.push(cb)
      return { dispose() {} }
    },
    write(s) {
      this.written.push(s)
    },
    kill() {
      this.killed++
      setTimeout(() => exits.forEach((cb) => cb({ exitCode: 137 })), 20)
    },
    resize() {}
  }
}

const fakeWin = {
  isDestroyed: () => false,
  webContents: { send: () => {} }
} as unknown as PtySessionWindow

setDatabase(
  {
    get: async () => ({ project_id: 'proj-1' }),
    all: async () => [],
    run: async () => ({ changes: 0, lastInsertRowid: 0 }),
    batchTxn: async (ops: unknown[]) => ops.map(() => undefined)
  } as unknown as SlayzoneDb,
  createFakeTaskSessionStore()
)

function installBackend(fake: FakePty): void {
  setPtyBackend({
    spawn() {
      throw new Error('adoption must not cold-spawn')
    },
    async adopt() {
      return fake as never
    }
  } as unknown as PtyBackend)
}

const CONV = '11111111-2222-4333-8444-555555555555'

function startTerminal(sessionId: string, fake: FakePty) {
  installBackend(fake)
  return createPty({
    win: fakeWin,
    sessionId,
    cwd: '/tmp',
    mode: 'claude-code',
    type: 'claude-code',
    existingConversationId: CONV,
    conversationId: undefined,
    initialCommand: 'claude --session-id {id} {flags}',
    resumeCommand: 'claude --resume {id} {flags}',
    defaultFlags: '',
    adoptPty: { warmId: 'warm-1', computerId: 'computer-1' }
  })
}

afterEach(() => {
  registerConversationHolder('chat', { isLive: () => false, release: async () => {} })
  setConversationResolver(null)
})

test('a terminal agent does not resume a conversation a chat of the same task runs', async () => {
  registerConversationHolder('chat', {
    isLive: (taskId, conv) => taskId === 'guardA' && conv === CONV,
    release: async () => {}
  })
  const fake = makeFakePty()
  const res = await startTerminal('guardA:guardA', fake)
  expect(res.success).toBe(false)
  expect(res.error).toMatch(/running in the chat/)
  expect(fake.written.join('')).toBe('')

  // Another task's chat is not in the way.
  const other = makeFakePty()
  expect((await startTerminal('guardB:guardB', other)).success).toBe(true)
  expect(other.written.join('')).toMatch(/--resume\W+11111111-2222-4333-8444-555555555555/)
  killPty('guardB:guardB')
})

test('the terminal reports the conversations it runs; releasing one kills it and waits for the exit', async () => {
  const fake = makeFakePty()
  expect((await startTerminal('relA:relA', fake)).success).toBe(true)
  expect(isConversationLive('terminal', 'relA', CONV)).toBe(true)
  expect(isConversationLive('terminal', 'relA', 'other-conv')).toBe(false)
  expect(isConversationLive('terminal', 'otherTask', CONV)).toBe(false)

  await releaseConversation('terminal', 'relA', CONV)
  expect(fake.killed).toBeGreaterThanOrEqual(1)
  expect(isConversationLive('terminal', 'relA', CONV)).toBe(false)
})
