/**
 * The agent-session ledger on the computer (robustness plan §9, P0) — the rules
 * that moved from the hub's task domain, run against the computer's own store
 * (`chat.sqlite`, schema v7). Ported from task's agent-sessions / lifecycle /
 * shared-session-claims / per-tab suites.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createSessionLedgerService } from './session-ledger-service'
import * as L from './session-ledger'
import { openChatStorage } from './storage'

const dirs: string[] = []
const stores: Array<ReturnType<typeof openChatStorage>> = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function ledger() {
  const dir = mkdtempSync(join(tmpdir(), 'slz-ledger-'))
  dirs.push(dir)
  const storage = openChatStorage({ stateDir: dir, hubScope: 'hub' })
  stores.push(storage)
  const service = createSessionLedgerService(storage)
  return { storage, service, db: service.db }
}

const M = 'claude-code'
const T = 'task'
const DEPLOY = 'deploy'

/** A confirmed, proven session of `tab` owned at `at`. */
async function session(
  db: ReturnType<typeof ledger>['db'],
  args: {
    task?: string
    tab?: string
    id: string
    at: number
    origin?: L.RecordConversationInput['origin']
    mode?: string
  }
) {
  await L.recordConversation(db, {
    taskId: args.task ?? T,
    mode: args.mode ?? M,
    tabId: args.tab ?? args.task ?? T,
    conversationId: args.id,
    origin: args.origin ?? 'slay-spawned-resume',
    createdAt: args.at
  })
}

const reset = (
  db: ReturnType<typeof ledger>['db'],
  r: Partial<L.SessionResetIntent> & { id: string; createdAt: number }
) =>
  L.applySessionIntents(db, {
    resets: [{ taskId: T, mode: M, tabId: T, exceptChat: false, ...r }],
    deletions: []
  })

describe('resume resolution', () => {
  test('latest honored wins; foreign-observed and pending never resume', async () => {
    const { db } = ledger()
    await session(db, { id: 'A', at: 10 })
    await session(db, { id: 'F', at: 20, origin: 'foreign-observed' })
    await L.recordConversation(db, {
      taskId: T,
      mode: M,
      conversationId: 'P',
      origin: 'pending-spawn',
      createdAt: 30,
      pendingMeta: { usedResume: false, spawnedAt: 30 }
    })
    expect(await L.getCurrentConversationId(db, T, M)).toBe('A')
  })

  test('a reset cuts every earlier session of its tab; a later one becomes current', async () => {
    const { db } = ledger()
    await session(db, { id: 'A', at: 10 })
    await reset(db, { id: 'r', createdAt: 15 })
    expect(await L.getCurrentConversationId(db, T, M)).toBeNull()
    await session(db, { id: 'B', at: 20 })
    expect(await L.getCurrentConversationId(db, T, M)).toBe('B')
  })

  test('a wildcard reset (every mode) cuts every mode; except_chat leaves chat modes', async () => {
    const { db } = ledger()
    await session(db, { id: 'T1', at: 10 })
    await session(db, { id: 'C1', at: 10, mode: 'claude-chat' })
    await reset(db, { id: 'all', mode: '*', exceptChat: true, createdAt: 15 })
    expect(await L.getCurrentConversationId(db, T, M)).toBeNull()
    expect(await L.getCurrentConversationId(db, T, 'claude-chat')).toBe('C1')
    await reset(db, { id: 'all2', mode: '*', exceptChat: false, createdAt: 16 })
    expect(await L.getCurrentConversationId(db, T, 'claude-chat')).toBeNull()
  })

  test('a fresh turn-tracked session is unproven until its first turn', async () => {
    const { db } = ledger()
    await session(db, { id: 'OLD', at: 5 })
    await session(db, { id: 'NEW', at: 10, origin: 'slay-spawned-fresh' })
    expect(await L.getCurrentConversationId(db, T, M)).toBe('OLD')
    expect(await L.markSessionFirstTurn(db, 'NEW')).toBe(true)
    expect(await L.markSessionFirstTurn(db, 'NEW')).toBe(false)
    expect(await L.getCurrentConversationId(db, T, M)).toBe('NEW')
  })

  test('a user-defined mode wrapping claude-code stays unproven until its first turn', async () => {
    const { db } = ledger()
    await L.noteModeAgents(db, { mine: 'claude-code' })
    await session(db, { id: 'X', at: 10, origin: 'slay-spawned-fresh', mode: 'mine' })
    expect(await L.getCurrentConversationId(db, T, 'mine')).toBeNull()
    await L.noteModeAgents(db, { other: 'codex' })
    await session(db, { id: 'Y', at: 10, origin: 'slay-spawned-fresh', mode: 'other' })
    expect(await L.getCurrentConversationId(db, T, 'other')).toBe('Y')
  })
})

describe('per-tab scope (main tab id = task id)', () => {
  test('two same-mode tabs are independent; a new tab resolves nothing', async () => {
    const { db } = ledger()
    await session(db, { tab: T, id: 'MAIN-1', at: 10 })
    await session(db, { tab: DEPLOY, id: 'DEP-1', at: 20 })
    expect(await L.getCurrentConversationId(db, T, M)).toBe('MAIN-1')
    expect(await L.getCurrentConversationId(db, T, M, DEPLOY)).toBe('DEP-1')
    expect(await L.getCurrentConversationId(db, T, M, 'new-tab')).toBeNull()
    expect(await L.listResumeCandidates(db, T, M, DEPLOY)).toEqual(['DEP-1'])
  })

  test('the incident: a main-tab reset never cuts the deploy tab', async () => {
    const { db } = ledger()
    await session(db, { tab: T, id: 'MAIN-1', at: 10 })
    await session(db, { tab: DEPLOY, id: 'bf71421e', at: 20 })
    await reset(db, { id: 'main-switch', tabId: T, mode: '*', exceptChat: true, createdAt: 30 })
    expect(await L.getCurrentConversationId(db, T, M)).toBeNull()
    expect(await L.getCurrentConversationId(db, T, M, DEPLOY)).toBe('bf71421e')
  })

  test('a whole-task reset (no tab) cuts every tab', async () => {
    const { db } = ledger()
    await session(db, { tab: T, id: 'MAIN-1', at: 10 })
    await session(db, { tab: DEPLOY, id: 'DEP-1', at: 20 })
    await reset(db, { id: 'wt', tabId: null, createdAt: 30 })
    expect(await L.getCurrentConversationId(db, T, M)).toBeNull()
    expect(await L.getCurrentConversationId(db, T, M, DEPLOY)).toBeNull()
  })

  test('a session picked in another tab moves there (one owner tab)', async () => {
    const { db } = ledger()
    await session(db, { tab: T, id: 'MAIN-1', at: 10 })
    await session(db, { tab: DEPLOY, id: 'DEP-1', at: 20 })
    await session(db, { tab: DEPLOY, id: 'MAIN-1', at: 30, origin: 'user-selected' })
    expect(await L.getCurrentConversationId(db, T, M, DEPLOY)).toBe('MAIN-1')
    expect(await L.getCurrentConversationId(db, T, M)).toBeNull()
    expect(await L.currentTabsOf(db, T, M, 'MAIN-1')).toEqual([DEPLOY])
    const rows = await L.listTaskSessionRows(db, T, M, T)
    expect(rows.find((r) => r.conversationId === 'MAIN-1')).toMatchObject({
      ownerTabId: DEPLOY,
      currentInOtherTab: true,
      isCurrent: false
    })
  })
})

describe('deletions (hub intent as delivered)', () => {
  test('a deleted session never resolves, lists or counts as honored; the current one is not deletable', async () => {
    const { db } = ledger()
    await session(db, { id: 'A', at: 10 })
    await session(db, { id: 'B', at: 20 })
    expect(await L.deletableSession(db, T, M, 'B')).toBe('current')
    expect(await L.deletableSession(db, T, M, 'A')).toBe('ok')
    expect(await L.deletableSession(db, T, M, 'nope')).toBe('not-honored')
    await L.applySessionIntents(db, {
      resets: [],
      deletions: [{ id: 'd', taskId: T, mode: M, conversationId: 'A', createdAt: 25 }]
    })
    // Idempotent delivery.
    await L.applySessionIntents(db, {
      resets: [],
      deletions: [{ id: 'd', taskId: T, mode: M, conversationId: 'A', createdAt: 25 }]
    })
    expect(await L.isHonoredConversation(db, T, M, 'A')).toBe(false)
    expect((await L.listTaskSessionRows(db, T, M)).map((r) => r.conversationId)).toEqual(['B'])
    // A deletion is per mode.
    expect(await L.isHonoredConversation(db, T, 'claude-chat', 'A')).toBe(false)
  })
})

describe('one task per provider session', () => {
  test('the earliest claimant wins; the loser falls back to its own; listed as shared', async () => {
    const { db } = ledger()
    await session(db, { task: 'b', id: 'own-b', at: 1 })
    await session(db, { task: 'a', id: 'shared', at: 2 })
    await session(db, { task: 'b', id: 'shared', at: 3 })
    expect(await L.getCurrentConversationId(db, 'a', M)).toBe('shared')
    expect(await L.getCurrentConversationId(db, 'b', M)).toBe('own-b')
    expect(await L.isHonoredConversation(db, 'b', M, 'shared')).toBe(false)
    expect([...(await L.claimedByOtherTasks(db, 'b', ['shared', 'own-b', 'x']))]).toEqual([
      'shared'
    ])
    expect(await L.listSharedSessionClaims(db)).toEqual([
      {
        conversationId: 'shared',
        claims: [
          { taskId: 'a', mode: M, firstClaimAt: 2 },
          { taskId: 'b', mode: M, firstClaimAt: 3 }
        ]
      }
    ])
  })
})

describe('spawn lifecycle', () => {
  test('pending spawn → hook confirm by launch token names its tab; mismatch is foreign', async () => {
    const { db } = ledger()
    await L.recordPendingSpawn(db, {
      taskId: T,
      mode: M,
      tabId: DEPLOY,
      expectedSessionId: 'E1',
      usedResume: false,
      spawnToken: 'tok'
    })
    expect(
      await L.recordHookConversation(db, { taskId: T, mode: M, sessionId: 'E1', spawnToken: 'tok' })
    ).toEqual({ origin: 'slay-spawned-fresh', tabId: DEPLOY })
    expect(
      await L.recordHookConversation(db, { taskId: T, mode: M, sessionId: 'other' })
    ).toMatchObject({ origin: 'foreign-observed' })
    await L.markSessionFirstTurn(db, 'E1')
    expect(await L.getCurrentConversationId(db, T, M, DEPLOY)).toBe('E1')
    expect(await L.getCurrentConversationId(db, T, M)).toBeNull()
  })

  test('/clear rotation from a slay-owned session is in-band-clear', async () => {
    const { db } = ledger()
    await session(db, { id: 'BEFORE', at: 10 })
    expect(
      await L.recordHookConversation(db, {
        taskId: T,
        mode: M,
        sessionId: 'AFTER',
        source: 'clear'
      })
    ).toEqual({ origin: 'in-band-clear', tabId: T })
    expect(await L.getCurrentConversationId(db, T, M)).toBe('AFTER')
  })

  test('warm pool: pooled row binds once, confirms write-once, and dies with a restart', async () => {
    const { db } = ledger()
    await L.recordSessionSpawn(db, {
      id: 'pool',
      taskId: null,
      tabId: null,
      mode: M,
      cwd: '/p',
      expectedConversationId: 'W',
      usedResume: false,
      status: 'pooled'
    })
    expect(
      await L.confirmSessionConversation(db, { sessionId: 'pool', observedConversationId: 'W' })
    ).toBe('slay-spawned-fresh')
    expect(
      await L.confirmSessionConversation(db, { sessionId: 'pool', observedConversationId: 'X' })
    ).toBeNull()
    expect(await L.bindSessionToTask(db, { sessionId: 'pool', taskId: T, tabId: T })).toBe(true)
    expect(await L.bindSessionToTask(db, { sessionId: 'pool', taskId: 'x', tabId: 'x' })).toBe(
      false
    )
    await L.markSessionFirstTurn(db, 'W')
    expect(await L.getCurrentConversationId(db, T, M)).toBe('W')
    await L.recordSessionSpawn(db, {
      id: 'pool2',
      taskId: null,
      tabId: null,
      mode: M,
      cwd: '/p',
      expectedConversationId: null,
      usedResume: false,
      status: 'pooled'
    })
    expect(await L.retireDeadPool(db)).toBe(1)
  })

  test('pruning by id removes only that launch’s pending row', async () => {
    const { db } = ledger()
    const a = await L.recordPendingSpawn(db, {
      taskId: T,
      mode: M,
      expectedSessionId: null,
      usedResume: false,
      spawnToken: 'a'
    })
    await L.recordPendingSpawn(db, {
      taskId: T,
      mode: M,
      tabId: DEPLOY,
      expectedSessionId: null,
      usedResume: false,
      spawnToken: 'b'
    })
    expect(await L.prunePendingSpawns(db, { ids: [a] })).toBe(1)
    expect(await L.findPendingSpawn(db, T, M, { spawnToken: 'a' })).toBeNull()
    expect(await L.findPendingSpawn(db, T, M, { spawnToken: 'b' })).toMatchObject({
      tabId: DEPLOY
    })
  })
})

describe('SessionStart provenance gate (the hook route asks the computer)', () => {
  const hook = (db: ReturnType<typeof ledger>['db'], sessionId: string, extra = {}) =>
    L.recordHookConversation(db, { taskId: T, mode: M, sessionId, ...extra })
  const fresh = (db: ReturnType<typeof ledger>['db'], extra = {}) =>
    L.recordPendingSpawn(db, {
      taskId: T,
      mode: M,
      expectedSessionId: null,
      usedResume: false,
      ...extra
    })

  test('no spawn intent: a manual `--resume <foreign>` is audit-only, never current', async () => {
    const { db } = ledger()
    await session(db, { id: 'OURS', at: 10 })
    expect(await hook(db, 'FOREIGN')).toEqual({ origin: 'foreign-observed', tabId: T })
    expect(await L.getCurrentConversationId(db, T, M)).toBe('OURS')
  })

  test('a minted id: exact match is the resume, a different id is foreign', async () => {
    const { db } = ledger()
    await L.recordPendingSpawn(db, { taskId: T, mode: M, expectedSessionId: 'R', usedResume: true })
    expect(await hook(db, 'OTHER')).toMatchObject({ origin: 'foreign-observed' })
    expect(await hook(db, 'R')).toMatchObject({ origin: 'slay-spawned-resume' })
  })

  test('delayed first id (codex): claimed once; a later different id stays foreign', async () => {
    const { db } = ledger()
    await fresh(db)
    expect(await hook(db, 'FIRST')).toMatchObject({ origin: 'slay-spawned-fresh' })
    await L.markSessionFirstTurn(db, 'FIRST')
    expect(await hook(db, 'SECOND')).toMatchObject({ origin: 'foreign-observed' })
    expect(await hook(db, 'FIRST'), 're-reporting the current id writes nothing').toBeNull()
  })

  test('delayed first id must come from the launch the token names', async () => {
    const { db } = ledger()
    await fresh(db, { spawnToken: 'launch-A' })
    expect(await hook(db, 'X', { spawnToken: 'launch-B' })).toMatchObject({
      origin: 'foreign-observed'
    })
    expect(await hook(db, 'X', { spawnToken: 'launch-A' })).toMatchObject({
      origin: 'slay-spawned-fresh'
    })
  })

  test("only source 'clear' rotates a slay-held session; 'resume'/'startup' never do", async () => {
    for (const source of ['resume', 'startup']) {
      const { db } = ledger()
      await session(db, { id: 'HELD', at: 10 })
      expect(await hook(db, 'NEW', { source }), source).toMatchObject({
        origin: 'foreign-observed'
      })
      expect(await L.getCurrentConversationId(db, T, M)).toBe('HELD')
    }
  })

  test("a repeated 'clear' for the id already recorded writes nothing", async () => {
    const { db } = ledger()
    await session(db, { id: 'HELD', at: 10 })
    expect(await hook(db, 'NEW', { source: 'clear' })).toMatchObject({ origin: 'in-band-clear' })
    expect(await hook(db, 'NEW', { source: 'clear' })).toBeNull()
  })

  test("'clear' with nothing slay holds falls through to the spawn gate", async () => {
    const unspawned = ledger()
    expect(await hook(unspawned.db, 'NEW', { source: 'clear' })).toMatchObject({
      origin: 'foreign-observed'
    })
    const spawned = ledger()
    await fresh(spawned.db)
    expect(await hook(spawned.db, 'NEW', { source: 'clear' })).toMatchObject({
      origin: 'slay-spawned-fresh'
    })
  })

  test('two tabs of one mode: the token names the launch, the launch names the tab', async () => {
    const { db } = ledger()
    await L.recordPendingSpawn(db, {
      taskId: T,
      mode: M,
      tabId: DEPLOY,
      expectedSessionId: 'dep',
      usedResume: false,
      spawnToken: 'tok-deploy'
    })
    await L.recordPendingSpawn(db, {
      taskId: T,
      mode: M,
      expectedSessionId: 'main',
      usedResume: false,
      spawnToken: 'tok-main'
    })
    expect(await hook(db, 'dep', { spawnToken: 'tok-deploy', ctxTabId: T })).toEqual({
      origin: 'slay-spawned-fresh',
      tabId: DEPLOY
    })
  })
})

describe('service', () => {
  test('usage attribution names the first task of each session; intents are reported held', async () => {
    const { service, db } = ledger()
    await session(db, { task: 'a', id: 'S', at: 1 })
    await session(db, { task: 'b', id: 'S', at: 2 })
    await session(db, { task: 'b', id: 'F', at: 3, origin: 'foreign-observed' })
    expect(service.sessionTasks(['S', 'F', 'none'])).toEqual({ S: 'a' })
    await reset(db, { id: 'r1', createdAt: 5 })
    expect(await service.handle({ op: 'heldIntents', args: { ids: ['r1', 'r2'] } })).toEqual(['r1'])
  })

  test('ledger rows are readable for diagnostics: conversations in order, sessions by status/id', async () => {
    const { service, db } = ledger()
    await session(db, { id: 'A', at: 1, origin: 'slay-spawned-fresh' })
    await session(db, { id: 'B', at: 2, tab: DEPLOY })
    await session(db, { task: 'other', id: 'C', at: 3 })
    await L.recordSessionSpawn(db, {
      id: 'warm-1',
      taskId: null,
      tabId: null,
      mode: M,
      cwd: '/repo',
      expectedConversationId: null,
      usedResume: false,
      status: 'pooled'
    })
    expect(await service.handle({ op: 'listConversations', args: { taskId: T, mode: M } })).toEqual(
      [
        expect.objectContaining({ conversationId: 'A', origin: 'slay-spawned-fresh', tabId: T }),
        expect.objectContaining({
          conversationId: 'B',
          origin: 'slay-spawned-resume',
          tabId: DEPLOY
        })
      ]
    )
    expect(
      await service.handle({ op: 'listConversations', args: { taskId: T, mode: M, tabId: DEPLOY } })
    ).toEqual([expect.objectContaining({ conversationId: 'B' })])
    expect(await service.handle({ op: 'listAgentSessions', args: { status: 'pooled' } })).toEqual([
      { id: 'warm-1', taskId: null, tabId: null, mode: M, status: 'pooled', conversationId: null }
    ])
    expect(await service.handle({ op: 'listAgentSessions', args: { id: 'warm-1' } })).toHaveLength(
      1
    )
    expect(service.isWrite('listConversations')).toBe(false)
    expect(service.isWrite('listAgentSessions')).toBe(false)
  })

  test('an unknown operation is refused', async () => {
    const { service } = ledger()
    await expect(service.handle({ op: 'dropTables', args: {} })).rejects.toThrow(/Unknown/)
  })
})

describe('chatSessionOwner: which chat on this computer holds a provider session (v208)', () => {
  test('the chat whose session record names it, for either side of the provider', async () => {
    const { storage, service } = ledger()
    for (const [id, task, tab] of [
      ['conv-a', 'task-a', 'tab-a'],
      ['conv-b', 'task-b', 'tab-b']
    ] as const) {
      storage.createConversation({ id, taskId: task, tabId: tab, mode: 'claude-chat', epoch: 1 })
    }
    storage.putRecord('conv-b', 1, {
      kind: 'settings',
      id: `session:${JSON.stringify(['claude-chat', 'native-1'])}`,
      value: { mode: 'claude-chat', conversationId: 'native-1', origin: 'chat' },
      at: 1
    })
    const owner = (sessionId: string, mode: string) =>
      service.handle({ op: 'chatSessionOwner', args: { sessionId, mode } })
    expect(await owner('native-1', 'claude-code')).toEqual({
      conversationId: 'conv-b',
      taskId: 'task-b',
      tabId: 'tab-b',
      mode: 'claude-chat'
    })
    expect(await owner('native-1', 'claude-chat')).toMatchObject({ conversationId: 'conv-b' })
    // Another provider's session id space, an unknown session, a deleted chat: none.
    expect(await owner('native-1', 'codex')).toBeNull()
    expect(await owner('missing', 'claude-code')).toBeNull()
    storage.deleteConversation('conv-b', 1)
    expect(await owner('native-1', 'claude-code')).toBeNull()
  })
})

// Ported from task's shared-session-claims suite (removed in 7d25d823c; review 2,
// Area 6): a provider session is the task's that claimed it FIRST (honored, not
// deleted, across every mode). Every other task's claim is invisible to every reader
// that answers "which sessions does this task have / resume?" — else two tasks resume
// one transcript and clobber it.
describe('one task per provider session: claim rules', () => {
  const Ccode = M
  const Cchat = 'claude-chat'

  test('the later claimant does not resume it, list it, or honor it', async () => {
    const { db } = ledger()
    await session(db, { task: 'a', id: 'shared', at: 1, origin: 'legacy-migration' })
    await session(db, { task: 'b', id: 'shared', at: 2, origin: 'legacy-migration' })
    expect(await L.getCurrentConversationId(db, 'a', Ccode)).toBe('shared')
    expect(await L.getCurrentConversationId(db, 'b', Ccode)).toBeNull()
    expect(await L.isHonoredConversation(db, 'a', Ccode, 'shared')).toBe(true)
    expect(await L.isHonoredConversation(db, 'b', Ccode, 'shared')).toBe(false)
    expect(await L.listResumeCandidates(db, 'b', Ccode)).toEqual([])
    expect(await L.listResumeCandidates(db, 'a', Ccode)).toEqual(['shared'])
    expect((await L.listTaskSessionRows(db, 'b', Ccode)).map((r) => r.conversationId)).toEqual([])
    expect((await L.listTaskSessionRows(db, 'a', Ccode)).map((r) => r.conversationId)).toEqual([
      'shared'
    ])
  })

  test("the winner is decided by each task's FIRST claim, not its newest row", async () => {
    const { db } = ledger()
    await session(db, { task: 'a', id: 'shared', at: 1, origin: 'legacy-migration' })
    await session(db, { task: 'b', id: 'shared', at: 2, origin: 'legacy-migration' })
    // A later resume in A must not hand the session to B (whose first claim is
    // earlier than A's newest row).
    await session(db, { task: 'a', id: 'shared', at: 5, origin: 'slay-spawned-resume' })
    expect(await L.getCurrentConversationId(db, 'a', Ccode)).toBe('shared')
    expect(await L.getCurrentConversationId(db, 'b', Ccode)).toBeNull()
  })

  test('a tie on claim time is broken by task id, deterministically', async () => {
    const { db } = ledger()
    await session(db, { task: 'b', id: 'shared', at: 7 })
    await session(db, { task: 'a', id: 'shared', at: 7 })
    expect(await L.getCurrentConversationId(db, 'a', Ccode)).toBe('shared')
    expect(await L.getCurrentConversationId(db, 'b', Ccode)).toBeNull()
    expect([...(await L.claimedByOtherTasks(db, 'b', ['shared']))]).toEqual(['shared'])
    expect([...(await L.claimedByOtherTasks(db, 'a', ['shared']))]).toEqual([])
  })

  test('a claim under another mode contests too (chat and terminal share session files)', async () => {
    const { db } = ledger()
    await session(db, { task: 'a', id: 'shared', at: 1, mode: Cchat, origin: 'legacy-migration' })
    await session(db, { task: 'b', id: 'shared', at: 2 })
    expect(await L.getCurrentConversationId(db, 'b', Ccode)).toBeNull()
    expect(await L.isHonoredConversation(db, 'b', Ccode, 'shared')).toBe(false)
  })

  test('one task holding the session under two modes is not a conflict', async () => {
    const { db } = ledger()
    await session(db, { task: 'a', id: 'shared', at: 1, mode: Cchat, origin: 'legacy-migration' })
    await session(db, { task: 'a', id: 'shared', at: 2, origin: 'handoff' })
    expect(await L.getCurrentConversationId(db, 'a', Ccode)).toBe('shared')
    expect(await L.getCurrentConversationId(db, 'a', Cchat)).toBe('shared')
    expect(await L.listSharedSessionClaims(db)).toEqual([])
  })

  test('a foreign-observed (audit-only) row never contests', async () => {
    const { db } = ledger()
    await session(db, { task: 'a', id: 'shared', at: 1, origin: 'foreign-observed' })
    await session(db, { task: 'b', id: 'shared', at: 2 })
    expect(await L.getCurrentConversationId(db, 'b', Ccode)).toBe('shared')
    expect(await L.isHonoredConversation(db, 'b', Ccode, 'shared')).toBe(true)
    expect(await L.listSharedSessionClaims(db)).toEqual([])
  })

  test('a relinquished claim (deletion tombstone) no longer contests: the other task gets it', async () => {
    const { db } = ledger()
    await session(db, { task: 'a', id: 'shared', at: 1 })
    await session(db, { task: 'b', id: 'shared', at: 2 })
    // The shared-session repair relinquishes the winner's CURRENT session: a
    // tombstone delivered as a deletion intent, without deleteSession's guard.
    await L.applySessionIntents(db, {
      resets: [],
      deletions: [{ id: 'rel', taskId: 'a', mode: Ccode, conversationId: 'shared', createdAt: 3 }]
    })
    expect(await L.getCurrentConversationId(db, 'a', Ccode)).toBeNull()
    expect(await L.getCurrentConversationId(db, 'b', Ccode)).toBe('shared')
    expect(await L.listSharedSessionClaims(db)).toEqual([])
  })

  test('claimedByOtherTasks names ids another task wins, keeps own and unclaimed ids', async () => {
    const { db } = ledger()
    await session(db, { task: 'a', id: 'a-wins', at: 1 })
    await session(db, { task: 'b', id: 'a-wins', at: 2 })
    await session(db, { task: 'b', id: 'b-wins', at: 1 })
    await session(db, { task: 'a', id: 'b-wins', at: 2 })
    await session(db, { task: 'a', id: 'only-b', at: 1, origin: 'foreign-observed' })
    await session(db, { task: 'b', id: 'only-b', at: 2 })
    expect([
      ...(await L.claimedByOtherTasks(db, 'b', ['a-wins', 'b-wins', 'only-b', 'unknown']))
    ]).toEqual(['a-wins'])
    // An id this task never claimed but another task holds is foreign (a parent's
    // session `/resume`d in a subtask, listed in pre-ledger history).
    await session(db, { task: 'a', id: 'parents', at: 1 })
    expect([...(await L.claimedByOtherTasks(db, 'c', ['parents']))]).toEqual(['parents'])
  })

  test('listSharedSessionClaims lists every task holding a shared session, earliest claim first', async () => {
    const { db } = ledger()
    await session(db, { task: 'b', id: 'shared', at: 2 })
    await session(db, { task: 'a', id: 'shared', at: 1 })
    await session(db, { task: 'a', id: 'shared', at: 4, origin: 'slay-spawned-resume' })
    await session(db, { task: 'c', id: 'shared', at: 3, mode: Cchat, origin: 'legacy-migration' })
    await session(db, { task: 'a', id: 'solo', at: 1 })
    expect(await L.listSharedSessionClaims(db)).toEqual([
      {
        conversationId: 'shared',
        claims: [
          { taskId: 'a', mode: Ccode, firstClaimAt: 1 },
          { taskId: 'b', mode: Ccode, firstClaimAt: 2 },
          { taskId: 'c', mode: Cchat, firstClaimAt: 3 }
        ]
      }
    ])
  })
})

// Review 2, Area 6: the pending-spawn time windows (10 min with an expected id, 30 s
// without) and the unscoped sweep. A stale pending row must never claim a LATER
// session (wrong resume, wrong tab); the sweep must never delete a live launch.
describe('pending-spawn windows and the sweep', () => {
  const MIN = 60_000
  /** A pending row of `tab` written `ageMs` ago (as recordPendingSpawn would have). */
  const pendingAged = (
    db: ReturnType<typeof ledger>['db'],
    args: { id: string; ageMs: number; expected: string | null; tab?: string; token?: string }
  ) => {
    const at = Date.now() - args.ageMs
    return L.recordConversation(db, {
      id: args.id,
      taskId: T,
      mode: M,
      tabId: args.tab ?? T,
      conversationId: args.expected,
      origin: 'pending-spawn',
      createdAt: at,
      pendingMeta: {
        usedResume: false,
        spawnedAt: at,
        ...(args.token ? { spawnToken: args.token } : {})
      }
    })
  }
  const hook = (db: ReturnType<typeof ledger>['db'], sessionId: string) =>
    L.recordHookConversation(db, { taskId: T, mode: M, sessionId })

  test('a launch with an expected id is found for 10 minutes, then never again', async () => {
    const { db } = ledger()
    await pendingAged(db, { id: 'young', ageMs: 9 * MIN, expected: 'E1', tab: DEPLOY })
    expect(await L.findPendingSpawn(db, T, M)).toMatchObject({ expectedSessionId: 'E1' })
    expect(await hook(db, 'E1')).toEqual({ origin: 'slay-spawned-fresh', tabId: DEPLOY })

    const { db: db2 } = ledger()
    await pendingAged(db2, { id: 'stale', ageMs: 11 * MIN, expected: 'E2', tab: DEPLOY })
    expect(await L.findPendingSpawn(db2, T, M)).toBeNull()
    // The same id reported later is no launch of slay's, and lands on no tab of the stale row.
    expect(await hook(db2, 'E2')).toEqual({ origin: 'foreign-observed', tabId: T })
  })

  test('a launch without an expected id is found for 30 seconds, then never claims a later session', async () => {
    const { db } = ledger()
    await pendingAged(db, { id: 'young', ageMs: 10_000, expected: null, tab: DEPLOY })
    expect(await hook(db, 'S1')).toEqual({ origin: 'slay-spawned-fresh', tabId: DEPLOY })

    const { db: db2 } = ledger()
    await pendingAged(db2, { id: 'stale', ageMs: 60_000, expected: null, tab: DEPLOY })
    expect(await L.findPendingSpawn(db2, T, M)).toBeNull()
    expect(await hook(db2, 'LATER')).toEqual({ origin: 'foreign-observed', tabId: T })
    await L.markSessionFirstTurn(db2, 'LATER')
    expect(await L.getCurrentConversationId(db2, T, M, DEPLOY)).toBeNull()
    expect(await L.getCurrentConversationId(db2, T, M)).toBeNull()
  })

  test('a token-carrying launch without an expected id stays findable past 30 seconds', async () => {
    const { db } = ledger()
    await pendingAged(db, { id: 'tok', ageMs: 5 * MIN, expected: null, token: 'live' })
    expect(await L.findPendingSpawn(db, T, M)).toMatchObject({ spawnToken: 'live' })
    expect(await L.findPendingSpawn(db, T, M, { spawnToken: 'live' })).toMatchObject({
      spawnToken: 'live'
    })
  })

  test('the newest launch in its window wins over an older one', async () => {
    const { db } = ledger()
    await pendingAged(db, { id: 'older', ageMs: 5 * MIN, expected: 'OLD', tab: DEPLOY })
    await pendingAged(db, { id: 'newer', ageMs: 1 * MIN, expected: 'NEW' })
    expect(await L.findPendingSpawn(db, T, M)).toMatchObject({
      expectedSessionId: 'NEW',
      tabId: T
    })
  })

  test('the unscoped sweep drops only stale token-less pending rows; a live launch survives', async () => {
    const { db } = ledger()
    await pendingAged(db, { id: 'stale', ageMs: 11 * MIN, expected: 'X' })
    await pendingAged(db, { id: 'young', ageMs: 9 * MIN, expected: 'Y' })
    await pendingAged(db, { id: 'live', ageMs: 60 * MIN, expected: null, token: 'tok' })
    // A confirmed session as old as the stale row: never a pending row, never swept.
    await session(db, { id: 'kept', at: Date.now() - 60 * MIN })
    expect(await L.prunePendingSpawns(db)).toBe(1)
    const ids = async (table: string) =>
      (await db.all<{ id: string }>(`SELECT id FROM ${table} ORDER BY id`)).map((r) => r.id)
    expect(await ids('agent_sessions')).toEqual(expect.arrayContaining(['live', 'young']))
    expect(await ids('agent_sessions')).not.toContain('stale')
    expect(await ids('task_conversations')).toEqual(expect.arrayContaining(['live', 'young']))
    expect(await ids('task_conversations')).not.toContain('stale')
    expect(await L.findPendingSpawn(db, T, M, { spawnToken: 'tok' })).toMatchObject({
      sessionId: 'live'
    })
    expect(await L.getCurrentConversationId(db, T, M)).toBe('kept')
  })
})
