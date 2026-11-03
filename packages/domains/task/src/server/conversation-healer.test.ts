/**
 * The registered conversation healer, against the real transcript locator.
 *
 * Regression (2026-11-03, task 5c34ebb9): a session that used EnterWorktree keeps
 * its transcript ONLY under the worktree's project dir. The healer looked in the
 * task folder alone, read "never written", answered `fresh`, and createPty
 * started `claude --session-id <same id>` over a 10 MB live conversation. The
 * lookup must find it wherever it moved, on the disk of the computer the agent
 * runs on, and an unknown answer must never become `fresh`.
 *
 * DB ops are stubbed (the decision inputs); the locator is real (hub-local disk)
 * or the wired computer locator.
 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import type { SlayzoneDb } from '@slayzone/platform'
import type { ConversationHealer } from '@slayzone/terminal/server'

const state = vi.hoisted(() => ({
  healer: null as unknown as ConversationHealer,
  owned: [] as string[],
  firstSeenAtMs: null as number | null,
  recorded: [] as Array<{ conversationId: string }>
}))

vi.mock('@slayzone/terminal/server', async (importOriginal) => {
  const real = await importOriginal<typeof import('@slayzone/terminal/server')>()
  return {
    ...real,
    setConversationHealer: (fn: ConversationHealer) => {
      state.healer = fn
    }
  }
})
vi.mock('@slayzone/diagnostics/server', () => ({ recordDiagnosticEvent: () => undefined }))
vi.mock('./ops/index.js', () => ({
  // Created after the legacy cutoff → history-only path (no orphan disk scan).
  getTaskOp: async () => ({ id: 't1', created_at: '2026-10-01 00:00:00', provider_config: {} }),
  collectReferencedConversationIds: async () => new Set<string>(),
  recordConversation: async (_db: unknown, row: { conversationId: string }) => {
    state.recorded.push(row)
  },
  getCurrentConversationId: async () => null,
  getConversationFirstSeenAt: async () => state.firstSeenAtMs,
  listResumeCandidates: async () => state.owned
}))

const { registerConversationHealer } = await import('./conversation-healer')
const { encodeClaudeProjectDir, setClaudeTranscriptLocator } = await import(
  '@slayzone/terminal/server'
)

const configDir = mkdtempSync(join(tmpdir(), 'healer-config-'))
const work = realpathSync(mkdtempSync(join(tmpdir(), 'healer-work-')))
const repo = join(work, 'repo')
const worktree = join(repo, '.claude', 'worktrees', 'move-to-computer')
const prevConfig = process.env.CLAUDE_CONFIG_DIR
const MOVED = 'f8326ae8-3b82-4e5a-b7b8-ecd17ec26c19'
const MISSING = '0b5e0d9a-0000-4000-8000-000000000001'
const SIBLING = '0b5e0d9a-0000-4000-8000-000000000002'

function writeTranscript(cwd: string, id: string, records: object[], name = `${id}.jsonl`): void {
  const dir = join(configDir, 'projects', encodeClaudeProjectDir(cwd))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`)
}

beforeAll(() => {
  process.env.CLAUDE_CONFIG_DIR = configDir
  // A 90-day retention, like the user's settings.json at the time.
  writeFileSync(join(configDir, 'settings.json'), '{"cleanupPeriodDays": 90}')
  mkdirSync(worktree, { recursive: true })
  writeTranscript(worktree, MOVED, [
    { type: 'user', cwd: repo, message: { content: 'enter a worktree' } },
    { type: 'relocated', relocatedCwd: worktree },
    { type: 'assistant', cwd: worktree, message: { content: [] } }
  ])
  // What the CLI left behind after the clobber: only a superseded copy counts as gone.
  writeTranscript(
    worktree,
    MISSING,
    [{ type: 'user', cwd: worktree }],
    `${MISSING}.jsonl.superseded-1`
  )
  writeTranscript(repo, SIBLING, [{ type: 'user', cwd: repo, message: { content: 'hi' } }])
  registerConversationHealer({} as SlayzoneDb, () => undefined, {
    getCurrentBranch: async () => 'main'
  })
})
afterAll(() => {
  if (prevConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = prevConfig
})
beforeEach(() => {
  state.owned = []
  state.recorded = []
  // First seen 2.6h ago: inside one retention period, so a truly missing
  // transcript reads as "never written" (→ fresh).
  state.firstSeenAtMs = Date.now() - 9_258_849
})
afterEach(() => setClaudeTranscriptLocator(null))

const heal = (storedId: string, over: Record<string, unknown> = {}) =>
  state.healer({ taskId: 't1', mode: 'claude-code', cwd: repo, storedId, ...over })

describe('conversation healer: transcript that moved folders', () => {
  test('moved into a worktree (hub-local disk): keep and resume, never fresh', async () => {
    const res = await heal(MOVED)
    expect(res).toEqual({ id: MOVED, healed: false })
  })

  test('on a computer: asks the computer, which finds it → keep', async () => {
    setClaudeTranscriptLocator(async (req) =>
      req.sessionIds.map((sessionId) => ({
        sessionId,
        found: sessionId === 'remote-only',
        resumeCwd: null
      }))
    )
    const res = await heal('remote-only', { computerId: 'pc', projectId: 'p1' })
    expect(res).toEqual({ id: 'remote-only', healed: false })
  })

  test('on a computer that cannot answer (old computer, dropped socket): keep, never fresh', async () => {
    setClaudeTranscriptLocator(async () => {
      throw new Error('method not found')
    })
    const res = await heal(MISSING, { computerId: 'pc', projectId: 'p1' })
    expect(res).toEqual({ id: MISSING, healed: false })
  })

  test('on a computer, the hub disk is never consulted', async () => {
    // MOVED exists on THIS disk, but the computer says it has no such file.
    setClaudeTranscriptLocator(async (req) =>
      req.sessionIds.map((sessionId) => ({ sessionId, found: false, resumeCwd: null }))
    )
    const res = await heal(MOVED, { computerId: 'pc', projectId: 'p1' })
    expect(res).toEqual({ id: MOVED, healed: false, fresh: true })
  })
})

describe('conversation healer: behaviour kept', () => {
  test('truly missing (only a superseded copy), first seen recently: fresh', async () => {
    expect(await heal(MISSING)).toEqual({ id: MISSING, healed: false, fresh: true })
  })

  test('truly missing, first seen beyond retention: overlay (unchanged id, not fresh)', async () => {
    state.firstSeenAtMs = Date.now() - 200 * 24 * 60 * 60 * 1000
    expect(await heal(MISSING)).toEqual({ id: MISSING, healed: false })
  })

  test('missing, but a recorded sibling survives: repoint to it', async () => {
    state.owned = [SIBLING, MISSING]
    expect(await heal(MISSING)).toEqual({ id: SIBLING, healed: true })
    expect(state.recorded.map((r) => r.conversationId)).toEqual([SIBLING])
  })
})
