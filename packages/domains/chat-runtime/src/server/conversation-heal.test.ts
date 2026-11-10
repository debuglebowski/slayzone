/**
 * The conversation heal on the computer (robustness plan §9, P0), against the real
 * session ledger in the computer's chat store and real transcript files. Ported
 * from the hub healer suite (task/server/conversation-healer.test.ts), which now
 * only forwards.
 *
 * Regression (2026-11-03, task 5c34ebb9): a session that used EnterWorktree keeps
 * its transcript ONLY under the worktree's project dir. A lookup in the task
 * folder alone read "never written" and started a fresh session over a live
 * conversation. An unknown answer must never become `fresh`.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { encodeClaudeProjectDir } from '@slayzone/terminal/claude-transcripts'
import {
  type ConversationHealIo,
  healConversation,
  localConversationHealIo
} from './conversation-heal'
import * as L from './session-ledger'
import { createSessionLedgerService } from './session-ledger-service'
import { openChatStorage } from './storage'

const configDir = mkdtempSync(join(tmpdir(), 'heal-config-'))
const work = realpathSync(mkdtempSync(join(tmpdir(), 'heal-work-')))
const repo = join(work, 'repo')
const worktree = join(repo, '.claude', 'worktrees', 'move-to-computer')
const prevConfig = process.env.CLAUDE_CONFIG_DIR
const MOVED = 'f8326ae8-3b82-4e5a-b7b8-ecd17ec26c19'
const MISSING = '0b5e0d9a-0000-4000-8000-000000000001'
const SIBLING = '0b5e0d9a-0000-4000-8000-000000000002'
const T = 't1'
const M = 'claude-code'
/** Created after the legacy cutoff → history-only path (no orphan disk scan). */
const CREATED = Date.parse('2026-10-01T00:00:00Z')

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
})
afterAll(() => {
  if (prevConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = prevConfig
  rmSync(configDir, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
})

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const c of cleanup.splice(0)) c()
})

function ledger() {
  const dir = mkdtempSync(join(tmpdir(), 'slz-heal-'))
  const storage = openChatStorage({ stateDir: dir, hubScope: 'hub' })
  cleanup.push(() => {
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return createSessionLedgerService(storage, { healIo: localConversationHealIo }).db
}

/** A session of the main tab, recorded `agoMs` ago (proven unless fresh-origin). */
async function session(
  db: Awaited<ReturnType<typeof ledger>>,
  id: string,
  agoMs: number,
  task = T
): Promise<void> {
  await L.recordConversation(db, {
    taskId: task,
    mode: M,
    conversationId: id,
    origin: 'slay-spawned-resume',
    createdAt: Date.now() - agoMs
  })
}

const heal = (
  db: Awaited<ReturnType<typeof ledger>>,
  storedId: string,
  io: ConversationHealIo = localConversationHealIo
) =>
  healConversation(db, io, {
    taskId: T,
    mode: M,
    tabId: T,
    cwd: repo,
    projectId: 'p1',
    storedId,
    taskCreatedAtMs: CREATED
  })

/** First seen 2.6h ago: inside one retention period. */
const RECENT = 9_258_849

describe('conversation heal: transcript that moved folders', () => {
  test('moved into a worktree: keep and resume, never fresh', async () => {
    const db = ledger()
    await session(db, MOVED, RECENT)
    expect(await heal(db, MOVED)).toEqual({ id: MOVED, healed: false })
  })

  test('the locator cannot answer: keep, never fresh', async () => {
    const db = ledger()
    await session(db, MISSING, RECENT)
    const res = await heal(db, MISSING, { ...localConversationHealIo, locate: async () => null })
    expect(res).toEqual({ id: MISSING, healed: false })
  })

  test('an id the locator did not answer for: keep', async () => {
    const db = ledger()
    await session(db, MISSING, RECENT)
    const res = await heal(db, MISSING, {
      ...localConversationHealIo,
      locate: async () => new Map()
    })
    expect(res).toEqual({ id: MISSING, healed: false })
  })
})

describe('conversation heal: decisions', () => {
  test('truly missing (only a superseded copy), first seen recently: fresh', async () => {
    const db = ledger()
    await session(db, MISSING, RECENT)
    expect(await heal(db, MISSING)).toMatchObject({
      id: MISSING,
      healed: false,
      fresh: true,
      diagnostic: { event: 'conv_id.heal_fresh' }
    })
  })

  test('truly missing, first seen beyond retention: overlay (unchanged id, not fresh)', async () => {
    const db = ledger()
    await session(db, MISSING, 200 * 24 * 60 * 60 * 1000)
    const res = await heal(db, MISSING)
    expect(res).toMatchObject({ id: MISSING, healed: false })
    expect(res.fresh).toBeUndefined()
    expect(res.diagnostic?.event).toBe('conv_id.heal_skipped')
  })

  test('missing, but a recorded sibling survives: repoint to it, on the ledger', async () => {
    const db = ledger()
    await session(db, SIBLING, RECENT + 1000)
    await session(db, MISSING, RECENT)
    const res = await heal(db, MISSING)
    expect(res).toMatchObject({ id: SIBLING, healed: true, diagnostic: { event: 'conv_id.heal' } })
    expect(await L.getCurrentConversationId(db, T, M)).toBe(SIBLING)
  })

  test('only claude-code is healed', async () => {
    const db = ledger()
    const res = await healConversation(db, localConversationHealIo, {
      taskId: T,
      mode: 'codex',
      tabId: T,
      cwd: repo,
      projectId: null,
      storedId: MISSING,
      taskCreatedAtMs: CREATED
    })
    expect(res).toEqual({ id: MISSING, healed: false })
  })
})

describe('conversation heal: one task per provider session (#172 follow-up #4)', () => {
  /** The main tab's pre-ledger `conversationHistory` (handed over from the hub). */
  const legacyHistory = (db: Awaited<ReturnType<typeof ledger>>, ids: string[]) =>
    db.run('INSERT INTO legacy_conversation_history(task_id,mode,ids) VALUES(?,?,?)', [
      T,
      M,
      JSON.stringify(ids)
    ])

  test('a pre-ledger history id another task owns is never a repoint target', async () => {
    const db = ledger()
    await session(db, SIBLING, RECENT + 2000, 'other-task')
    await session(db, MISSING, RECENT)
    await legacyHistory(db, [SIBLING])
    const res = await heal(db, MISSING)
    expect(res.id).toBe(MISSING)
    expect(res.healed).toBe(false)
  })

  test('a pre-ledger history id nobody else owns still repoints', async () => {
    const db = ledger()
    await session(db, MISSING, RECENT)
    await legacyHistory(db, [SIBLING])
    expect(await heal(db, MISSING)).toMatchObject({ id: SIBLING, healed: true })
  })
})

describe('service', () => {
  test('without a wired disk the op refuses (the hub keeps the id)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slz-heal-noio-'))
    const storage = openChatStorage({ stateDir: dir, hubScope: 'hub' })
    cleanup.push(() => {
      storage.close()
      rmSync(dir, { recursive: true, force: true })
    })
    await expect(
      createSessionLedgerService(storage).handle({
        op: 'healConversation',
        args: {
          taskId: T,
          mode: M,
          tabId: T,
          cwd: repo,
          projectId: null,
          storedId: MISSING,
          taskCreatedAtMs: null
        }
      })
    ).rejects.toThrow(/unavailable/)
  })
})
