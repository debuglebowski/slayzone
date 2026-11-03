/**
 * createPty resumes a Claude conversation where its transcript IS, as reported
 * by the agent's computer, and never starts a known id fresh over an existing
 * transcript.
 *
 * Regression (2026-11-03, task 5c34ebb9): after EnterWorktree the transcript
 * lives only under the worktree's project dir. The spawn must resume (not
 * `--session-id`) and start in the worktree. Cold spawn through a capturing
 * backend on a computer; healer + locator are stubs. No real shell spawns.
 */
import { afterEach, expect, test } from 'vitest'
import type { SlayzoneDb } from '@slayzone/platform'
import type { PtySessionWindow } from '../pty-host'
import {
  createPty,
  killPty,
  setConversationHealer,
  setConversationResolver,
  setDatabase,
  type ConversationHealRequest
} from './pty-manager'
import { setPtyBackend, type PtyBackend, type PtySpawnSpec } from './pty-backend'
import { createFakeTaskSessionStore } from './fake-task-session-store'
import {
  setClaudeTranscriptLocator,
  type ClaudeTranscriptLocateRequest
} from './claude-transcript-locator'

const fakeWin = {
  isDestroyed: () => false,
  webContents: { send: () => undefined }
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

const ID = 'f8326ae8-3b82-4e5a-b7b8-ecd17ec26c19'
const REPO = '/work/repo'
const WORKTREE = '/work/repo/.claude/worktrees/move-to-computer'

interface Captured {
  specs: PtySpawnSpec[]
  written: string[]
}
function captureBackend(): Captured {
  const cap: Captured = { specs: [], written: [] }
  setPtyBackend({
    spawn: async (spec: PtySpawnSpec) => {
      cap.specs.push(spec)
      return {
        pid: 4242,
        process: 'zsh',
        onData: () => ({ dispose: () => undefined }),
        onExit: () => ({ dispose: () => undefined }),
        write: (s: string) => cap.written.push(s),
        kill: () => undefined,
        resize: () => undefined
      } as never
    }
  } as unknown as PtyBackend)
  return cap
}
const commandOf = (cap: Captured): string => JSON.stringify(cap.specs) + cap.written.join('')

let n = 0
async function spawn(over: Record<string, unknown> = {}): Promise<Captured> {
  const cap = captureBackend()
  const sid = `locTask${++n}:locTask${n}`
  await createPty({
    win: fakeWin,
    sessionId: sid,
    computerId: 'pc',
    projectId: 'proj-1',
    cwd: REPO,
    mode: 'claude-code',
    type: 'claude-code',
    existingConversationId: ID,
    initialCommand: 'claude --session-id {id} {flags}',
    resumeCommand: 'claude --resume {id} {flags}',
    defaultFlags: '--allow-dangerously-skip-permissions',
    ...over
  } as never)
  killPty(sid)
  return cap
}

afterEach(() => {
  setConversationHealer(null)
  setConversationResolver(null)
  setClaudeTranscriptLocator(null)
  setPtyBackend(null)
})

test('moved into a worktree: resumes, starting in the worktree', async () => {
  const heals: ConversationHealRequest[] = []
  setConversationHealer(async (req) => {
    heals.push(req)
    return { id: req.storedId, healed: false }
  })
  const asked: ClaudeTranscriptLocateRequest[] = []
  setClaudeTranscriptLocator(async (req) => {
    asked.push(req)
    return [{ sessionId: ID, found: true, resumeCwd: WORKTREE }]
  })
  const cap = await spawn()
  const cmd = commandOf(cap)
  expect(cmd).toContain(`--resume' '${ID}`)
  expect(cmd).not.toContain('--session-id')
  expect(cap.specs[0].options.cwd).toBe(WORKTREE)
  // The healer and the locator know which computer's disk to look at.
  expect(heals[0]).toMatchObject({ computerId: 'pc', projectId: 'proj-1', cwd: REPO })
  expect(asked.at(-1)).toMatchObject({ computerId: 'pc', projectId: 'proj-1', cwd: REPO })
})

test('transcript in the task folder: resumes in the task folder', async () => {
  setConversationHealer(async (req) => ({ id: req.storedId, healed: false }))
  setClaudeTranscriptLocator(async () => [{ sessionId: ID, found: true, resumeCwd: null }])
  const cap = await spawn()
  expect(commandOf(cap)).toContain(`--resume' '${ID}`)
  expect(cap.specs[0].options.cwd).toBe(REPO)
})

test('healer says fresh but the transcript exists: resume, never --session-id over it', async () => {
  setConversationHealer(async (req) => ({ id: req.storedId, healed: false, fresh: true }))
  setClaudeTranscriptLocator(async () => [{ sessionId: ID, found: true, resumeCwd: WORKTREE }])
  const cap = await spawn()
  const cmd = commandOf(cap)
  expect(cmd).toContain(`--resume' '${ID}`)
  expect(cmd).not.toContain('--session-id')
  expect(cap.specs[0].options.cwd).toBe(WORKTREE)
})

test('healer says fresh and the computer cannot answer: resume (overlay at worst)', async () => {
  setConversationHealer(async (req) => ({ id: req.storedId, healed: false, fresh: true }))
  setClaudeTranscriptLocator(async () => {
    throw new Error('method not found')
  })
  const cmd = commandOf(await spawn())
  expect(cmd).toContain(`--resume' '${ID}`)
  expect(cmd).not.toContain('--session-id')
})

test('healer says fresh and it is truly nowhere: fresh under the same id (kept)', async () => {
  setConversationHealer(async (req) => ({ id: req.storedId, healed: false, fresh: true }))
  setClaudeTranscriptLocator(async () => [{ sessionId: ID, found: false, resumeCwd: null }])
  const cap = await spawn()
  const cmd = commandOf(cap)
  expect(cmd).toContain(`--session-id' '${ID}`)
  expect(cmd).not.toContain('--resume')
  expect(cap.specs[0].options.cwd).toBe(REPO)
})

test('caller-supplied fresh id whose transcript exists: resume it', async () => {
  setConversationResolver(async () => null)
  setClaudeTranscriptLocator(async () => [{ sessionId: ID, found: true, resumeCwd: null }])
  const cmd = commandOf(await spawn({ existingConversationId: null, conversationId: ID }))
  expect(cmd).toContain(`--resume' '${ID}`)
  expect(cmd).not.toContain('--session-id')
})

test('caller-supplied fresh id, computer cannot answer: fresh (kept)', async () => {
  setConversationResolver(async () => null)
  setClaudeTranscriptLocator(async () => {
    throw new Error('method not found')
  })
  const cmd = commandOf(await spawn({ existingConversationId: null, conversationId: ID }))
  expect(cmd).toContain(`--session-id' '${ID}`)
})
