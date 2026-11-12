/**
 * A move between two hubs (slice 3b), end to end through each hub's real router and
 * the app's step engine: the task, its subtree and their tabs, tags, blockers,
 * artifacts (rows), activity and usage arrive on the target with their ids; the
 * target hides and locks them until it commits; the source then lets them go
 * (rows removed — never erased — and redirects left). A move back works.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/apps/api/src/routers/task-moves-two-hubs.test.ts
 */
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'
import { describe, expect, test } from 'vitest'
import type { CreateTaskInput, Task, TaskMove, UpdateTaskInput } from '@slayzone/task-contracts'
import {
  configureTaskRuntimeAdapters,
  setTaskDeps,
  setTaskMoveSessionsDelegate,
  taskOps,
  type TaskMoveSessionsDelegate
} from '@slayzone/task/server'
import { createTaskMoveSteps, runTaskMove } from '@slayzone/task/client'
import {
  defaultWorktreeExecAdapters,
  defaultWorktreePolicyAdapters
} from '@slayzone/worktrees/server'
import { createTestHarness } from '../../../../shared/test-utils/ipc-harness.js'
import { appRouter } from '../router'

const A = await createTestHarness()
const B = await createTestHarness()
// Each hub its own storage: artifact files really travel.
const rootA = mkdtempSync(join(tmpdir(), 'task-moves-hub-a-'))
const rootB = mkdtempSync(join(tmpdir(), 'task-moves-hub-b-'))
setTaskDeps({ ops: taskOps })
configureTaskRuntimeAdapters({
  getDataRoot: () => rootA,
  worktrees: defaultWorktreeExecAdapters,
  worktreePolicy: defaultWorktreePolicyAdapters
})
const hubA = appRouter.createCaller({ db: A.slayDb, dataRoot: rootA } as never)
const hubB = appRouter.createCaller({ db: B.slayDb, dataRoot: rootB } as never)

/**
 * The two hubs' computers, in memory: what the source's computer would export and what the
 * target's computer received. One object serves both sides (the source-side calls and the
 * target-side calls are disjoint), standing in for each hub's real delegate.
 */
const computers = {
  /** taskId → the chats the source computer holds. */
  holds: new Map<
    string,
    Array<{ id: string; tabId: string; mode: string; epoch: number; bytes: Buffer }>
  >(),
  /** transferId → what the target computer received of it. */
  staged: new Map<string, { id: string; epoch: number; chunks: Buffer[] }>(),
  /** taskId → the files beside the chats the source computer holds (a transcript each). */
  fileHolds: new Map<string, Array<{ sessionId: string; bytes: Buffer }>>(),
  /** What the target computer received of each file, by session id. */
  fileChunks: new Map<string, Buffer[]>(),
  activated: [] as string[],
  ledgers: [] as Array<{ taskId: string; ledger: unknown }>,
  discarded: [] as string[],
  /** Each `forget` call: the tasks a computer was told to let go of. */
  forgotten: [] as string[][],
  settled: [] as string[]
}
const TARGET_COMPUTER = 'computer-b'
const fakeDelegate: TaskMoveSessionsDelegate = {
  exportTask: async (moveId, taskId) => ({
    transfers: (computers.holds.get(taskId) ?? []).map((c) => ({
      computerId: 'computer-a',
      manifest: {
        header: {
          migrationId: `move:${moveId}`,
          identity: { id: c.id, taskId, tabId: c.tabId, mode: c.mode, epoch: c.epoch }
        },
        hash: crypto.createHash('sha256').update(c.bytes).digest('hex'),
        bytes: c.bytes.length
      }
    })),
    ledger: { sessions: (computers.holds.get(taskId) ?? []).length }
  }),
  read: async (i) => {
    const chat = [...computers.holds.values()].flat().find((c) => c.id === i.conversationId)!
    return chat.bytes.subarray(i.offset, i.offset + i.length).toString('base64')
  },
  readAttachment: async () => '',
  files: async (_moveId, taskId) =>
    (computers.fileHolds.get(taskId) ?? []).map((f) => ({
      ref: { kind: 'claude-transcript' as const, sessionId: f.sessionId },
      size: f.bytes.length,
      hash: crypto.createHash('sha256').update(f.bytes).digest('hex'),
      computerId: 'computer-a'
    })),
  readFile: async (i) => {
    const file = [...computers.fileHolds.values()]
      .flat()
      .find((f) => f.sessionId === (i.ref as { sessionId: string }).sessionId)!
    const part = file.bytes.subarray(i.offset, i.offset + i.length)
    return { data: part.toString('base64'), eof: i.offset + part.length >= file.bytes.length }
  },
  missingFiles: async (_taskId, entries) => entries.map((e) => ({ ...e, offset: 0 })),
  writeFile: async (i) => {
    const id = (i.ref as { sessionId: string }).sessionId
    computers.fileChunks.set(id, [
      ...(computers.fileChunks.get(id) ?? []),
      Buffer.from(i.data, 'base64')
    ])
  },
  discard: async (moveId) => {
    computers.discarded.push(moveId)
  },
  forget: async (taskIds) => {
    computers.forgotten.push([...taskIds])
  },
  holders: async () => [],
  forgetOn: async () => undefined,
  computerOf: async () => TARGET_COMPUTER,
  begin: async (_taskId, manifest) => {
    const id = manifest.header.identity.id
    computers.staged.set(`t-${id}`, { id, epoch: manifest.header.identity.epoch + 1, chunks: [] })
    return { transferId: `t-${id}`, offset: 0 }
  },
  chunk: async (_taskId, transferId, offset, data) => {
    const staged = computers.staged.get(transferId)!
    const received = staged.chunks.reduce((n, c) => n + c.length, 0)
    if (offset !== received) throw new Error(`chunk at ${offset}, expected ${received}`)
    staged.chunks.push(Buffer.from(data, 'base64'))
  },
  finish: async (_taskId, transferId) => {
    const staged = computers.staged.get(transferId)!
    return { conversationId: staged.id, epoch: staged.epoch, missing: [] }
  },
  putAttachment: async () => undefined,
  activate: async (i) => {
    computers.activated.push(i.conversationId)
  },
  importLedger: async (taskId, ledger) => {
    computers.ledgers.push({ taskId, ledger })
  },
  settle: async (computerId) => {
    computers.settled.push(computerId)
  }
}
setTaskMoveSessionsDelegate(fakeDelegate)

const COLUMNS_A = [
  { id: 'queued', label: 'Queued', color: 'gray', position: 0, category: 'unstarted' },
  { id: 'doing', label: 'Doing', color: 'blue', position: 1, category: 'started' },
  { id: 'done', label: 'Done', color: 'green', position: 2, category: 'completed' }
]
const COLUMNS_B = [
  { id: 'triage', label: 'Triage', color: 'gray', position: 0, category: 'triage' },
  { id: 'done', label: 'Done', color: 'green', position: 1, category: 'completed' }
]
function project(h: typeof A, name: string, columns: unknown[]): string {
  const id = crypto.randomUUID()
  h.db
    .prepare('INSERT INTO projects (id, name, color, columns_config) VALUES (?, ?, ?, ?)')
    .run(id, name, '#000', JSON.stringify(columns))
  return id
}
const projectA = project(A, 'On A', COLUMNS_A)
const projectB = project(B, 'On B', COLUMNS_B)

const createOn = (hub: typeof hubA, projectId: string, title: string, extra = {}) =>
  hub.task.create({ projectId, title, ...extra } as unknown as CreateTaskInput) as Promise<Task>

/** The app's side: begin on the source, then the step engine against both hubs. */
async function move(
  from: { hub: typeof hubA; id: string },
  to: { hub: typeof hubA; id: string; projectId: string },
  taskIds: string[],
  opts: { pauseAfter?: TaskMove['step']; includeSessions?: boolean } = {}
): Promise<TaskMove> {
  const begun = await from.hub.taskMoves.begin({
    taskIds,
    targetHubId: to.id,
    targetProjectId: to.projectId,
    includeSessions: opts.includeSessions ?? true
  })
  let lastStep: TaskMove['step'] = begun.step
  return runTaskMove(begun.id, {
    journal: {
      get: (id) => from.hub.taskMoves.get({ id }),
      advance: (id, completed) => from.hub.taskMoves.advance({ id, completed }),
      progress: (id, step, done, total) => from.hub.taskMoves.progress({ id, step, done, total }),
      pause: (id) => from.hub.taskMoves.pause({ id }),
      fail: (id, error) => from.hub.taskMoves.fail({ id, error }),
      release: (id) => from.hub.taskMoves.release({ id })
    },
    steps: createTaskMoveSteps({
      sourceHubId: from.id,
      source: {
        exportBundle: (id) => from.hub.taskMoves.export({ id }),
        addRemoteBlockers: (moveId, links) =>
          from.hub.taskMoves.addRemoteBlockers({ moveId, links }).then(() => undefined),
        fileManifest: (moveId) => from.hub.artifacts.moveManifest({ moveId }),
        readFile: (moveId, ref, offset, length) =>
          from.hub.artifacts.moveRead({ moveId, ref, offset, length }),
        sessionsExport: (moveId, taskId) => from.hub.taskMoves.sessionsExport({ moveId, taskId }),
        sessionsRead: (input) => from.hub.taskMoves.sessionsRead(input),
        sessionsReadAttachment: (input) => from.hub.taskMoves.sessionsReadAttachment(input),
        sessionsFiles: (moveId, taskId) => from.hub.taskMoves.sessionsFiles({ moveId, taskId }),
        sessionsFileRead: (input) => from.hub.taskMoves.sessionsFileRead(input),
        sessionsDiscard: (moveId) => from.hub.taskMoves.sessionsDiscard({ moveId })
      },
      target: {
        importBundle: (input) => to.hub.taskMoves.import(input).then(() => undefined),
        addRemoteBlockers: (moveId, links) =>
          to.hub.taskMoves.addRemoteBlockers({ moveId, links }).then(() => undefined),
        missingFiles: (moveId, entries) => to.hub.artifacts.moveMissing({ moveId, entries }),
        writeFile: (input) => to.hub.artifacts.moveWrite(input).then(() => undefined),
        clearStaging: (moveId) => to.hub.artifacts.moveClearStaging({ moveId }),
        sessionsBegin: (moveId, taskId, manifest) =>
          to.hub.taskMoves.sessionsBegin({ moveId, taskId, manifest }),
        sessionsChunk: (input) => to.hub.taskMoves.sessionsChunk(input),
        sessionsFinish: (moveId, taskId, transferId) =>
          to.hub.taskMoves.sessionsFinish({ moveId, taskId, transferId }),
        sessionsPutAttachment: (input) => to.hub.taskMoves.sessionsPutAttachment(input),
        sessionsActivate: (input) => to.hub.taskMoves.sessionsActivate(input),
        sessionsFilesMissing: (moveId, taskId, entries) =>
          to.hub.taskMoves.sessionsFilesMissing({ moveId, taskId, entries }),
        sessionsFileWrite: (input) => to.hub.taskMoves.sessionsFileWrite(input),
        sessionsImportLedger: (moveId, taskId, ledger) =>
          to.hub.taskMoves.sessionsImportLedger({ moveId, taskId, ledger }),
        sessionsRegister: (moveId, taskId, chats) =>
          to.hub.taskMoves.sessionsRegister({ moveId, taskId, chats }),
        commit: (id) => to.hub.taskMoves.commit({ id }).then(() => undefined)
      }
    }),
    pauseRequested: () => lastStep === opts.pauseAfter,
    onUpdate: (m) => {
      lastStep = m.step
    }
  })
}

const row = (h: typeof A, id: string) =>
  h.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined
const count = (h: typeof A, sql: string, ...params: unknown[]) =>
  (h.db.prepare(sql).get(...params) as { n: number }).n
const errOf = async (fn: () => Promise<unknown>): Promise<{ code?: string; message: string }> => {
  try {
    await fn()
    return { message: '' }
  } catch (e) {
    return { code: (e as { code?: string }).code, message: (e as Error).message }
  }
}

describe('a move from hub A to hub B', () => {
  test('everything arrives with its ids; A keeps redirects, no rows', async () => {
    const parent = await createOn(hubA, projectA, 'Mover', { status: 'doing' })
    const child = await createOn(hubA, projectA, 'Mover child', {
      parentId: parent.id,
      status: 'done'
    })
    const stays = await createOn(hubA, projectA, 'Stays on A')
    // A tab, a tag, a blocker inside the subtree and one to a task staying on A.
    A.db
      .prepare(
        `INSERT INTO terminal_tabs (id, task_id, label, mode, is_main, position) VALUES (?, ?, 'Review', 'codex', 0, 1)`
      )
      .run(`tab-${parent.id}`, parent.id)
    const tag = crypto.randomUUID()
    A.db
      .prepare(
        `INSERT INTO tags (id, project_id, name, color, text_color) VALUES (?, ?, 'bug', '#ef4444', '#ffffff')`
      )
      .run(tag, projectA)
    A.db.prepare('INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)').run(parent.id, tag)
    A.db
      .prepare('INSERT INTO task_dependencies (task_id, blocks_task_id) VALUES (?, ?)')
      .run(child.id, parent.id)
    A.db
      .prepare('INSERT INTO task_dependencies (task_id, blocks_task_id) VALUES (?, ?)')
      .run(stays.id, parent.id)
    // A real artifact: a blob and a working copy on A's disk, more than two chunks.
    const big = 'x'.repeat(1_300_000)
    const created = await hubA.artifacts.create({
      taskId: parent.id,
      title: 'notes.md',
      content: `final ${big}`
    })
    const artifact = created!.id
    A.db
      .prepare(`INSERT INTO usage_records (id, provider, model, task_id, input_tokens, output_tokens, timestamp, source_file)
                VALUES (?, 'claude', 'm', ?, 1, 2, '2026-11-12T00:00:00Z', 'f.jsonl')`)
      .run(crypto.randomUUID(), parent.id)

    // A chat of the task, owned by A's computer.
    const conversation = crypto.randomUUID()
    A.db
      .prepare(
        `INSERT INTO chat_ownership (id, task_id, tab_id, mode, computer_id, epoch, state)
         VALUES (?, ?, ?, 'claude-chat', 'computer-a', 1, 'active')`
      )
      .run(conversation, parent.id, parent.id)
    A.db
      .prepare(`INSERT OR REPLACE INTO chat_task_lifecycle (task_id, state) VALUES (?, 'active')`)
      .run(parent.id)

    const done = await move(
      { hub: hubA, id: 'hub-a' },
      { hub: hubB, id: 'hub-b', projectId: projectB },
      [parent.id]
    )
    expect(done.status).toBe('done')
    // Released, not deleted: A never tells its computer to erase the task's chats (a
    // tombstone there would refuse the task for good, so it could never move back).
    expect(
      count(
        A,
        'SELECT COUNT(*) AS n FROM chat_deletion_targets WHERE conversation_id = ?',
        conversation
      )
    ).toBe(0)
    expect(
      count(
        A,
        "SELECT COUNT(*) AS n FROM chat_task_lifecycle WHERE task_id = ? AND state = 'deleted'",
        parent.id
      )
    ).toBe(0)

    // On B, with the same ids, in B's project, statuses re-homed, hierarchy kept.
    expect(row(B, parent.id)).toMatchObject({
      project_id: projectB,
      status: 'triage',
      parent_id: null
    })
    expect(row(B, child.id)).toMatchObject({
      project_id: projectB,
      status: 'done',
      parent_id: parent.id
    })
    expect(
      count(B, 'SELECT COUNT(*) AS n FROM terminal_tabs WHERE id = ?', `tab-${parent.id}`)
    ).toBe(1)
    expect(
      B.db
        .prepare(
          `SELECT tg.project_id, tg.name FROM task_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.task_id = ?`
        )
        .all(parent.id)
    ).toEqual([{ project_id: projectB, name: 'bug' }])
    expect(
      count(B, 'SELECT COUNT(*) AS n FROM task_dependencies WHERE task_id = ?', child.id)
    ).toBe(1)
    // The blocker left on A is no local row on B: a cross-hub link on both hubs, and
    // the moved task still counts as blocked.
    expect(
      count(B, 'SELECT COUNT(*) AS n FROM task_dependencies WHERE task_id = ?', stays.id)
    ).toBe(0)
    expect(await hubB.taskMoves.remoteBlockers({ taskId: parent.id })).toEqual([
      expect.objectContaining({
        role: 'blocked_by',
        remoteHubId: 'hub-a',
        remoteTaskId: stays.id,
        remoteTitle: 'Stays on A'
      })
    ])
    expect((await hubB.task.loadBoardData()).blockedTaskIds).toContain(parent.id)
    expect(await hubA.taskMoves.remoteBlockers({ taskId: stays.id })).toEqual([
      expect.objectContaining({
        role: 'blocks',
        remoteHubId: 'hub-b',
        remoteTaskId: parent.id,
        remoteTitle: 'Mover'
      })
    ])
    // A link is removed on its own hub.
    await hubA.taskMoves.removeRemoteBlocker({
      taskId: stays.id,
      role: 'blocks',
      remoteHubId: 'hub-b',
      remoteTaskId: parent.id
    })
    expect(await hubA.taskMoves.remoteBlockers({ taskId: stays.id })).toEqual([])
    expect(count(B, 'SELECT COUNT(*) AS n FROM task_artifacts WHERE id = ?', artifact)).toBe(1)
    // Its bytes came along, checked by hash: the content and every version's blob.
    expect(await hubB.artifacts.readContent({ id: artifact })).toBe(`final ${big}`)
    const versions = await hubB.artifacts.versionsList({ artifactId: artifact })
    expect(versions.length).toBeGreaterThanOrEqual(1)
    expect(existsSync(join(rootA, 'artifacts', parent.id))).toBe(false)
    expect(count(B, 'SELECT COUNT(*) AS n FROM usage_records WHERE task_id = ?', parent.id)).toBe(1)
    // Its history came along, plus the move itself.
    expect(
      count(
        B,
        "SELECT COUNT(*) AS n FROM activity_events WHERE task_id = ? AND kind = 'task.created'",
        parent.id
      )
    ).toBe(1)
    expect(
      count(
        B,
        "SELECT COUNT(*) AS n FROM activity_events WHERE task_id = ? AND kind = 'task.project_changed'",
        parent.id
      )
    ).toBe(1)
    // Unlocked on B once committed.
    await hubB.task.update({ id: parent.id, title: 'Renamed on B' } as unknown as UpdateTaskInput)

    // Gone from A — not erased — and redirected.
    expect(row(A, parent.id)).toBeUndefined()
    expect(row(A, child.id)).toBeUndefined()
    expect(row(A, stays.id)).toBeDefined()
    expect(
      count(A, 'SELECT COUNT(*) AS n FROM content_erasure_tasks WHERE task_id = ?', parent.id)
    ).toBe(0)
    expect(await hubA.taskMoves.redirects({ taskIds: [parent.id, child.id] })).toEqual({
      [parent.id]: { hubId: 'hub-b', moveId: done.id },
      [child.id]: { hubId: 'hub-b', moveId: done.id }
    })
  })

  test('before the target commits, its copy is hidden from its board and locked', async () => {
    const t = await createOn(hubA, projectA, 'Half way')
    const paused = await move(
      { hub: hubA, id: 'hub-a' },
      { hub: hubB, id: 'hub-b', projectId: projectB },
      [t.id],
      { pauseAfter: 'commit' }
    )
    expect(paused).toMatchObject({ status: 'paused', step: 'commit' })
    expect(row(B, t.id)).toBeDefined()
    const board = await hubB.task.loadBoardData()
    expect(board.tasks.map((x: { id: string }) => x.id)).not.toContain(t.id)
    const write = await errOf(() =>
      hubB.task.update({ id: t.id, title: 'too early' } as unknown as UpdateTaskInput)
    )
    expect(write.code).toBe('PRECONDITION_FAILED')
    // Still A's: on its board, locked.
    expect((await hubA.task.loadBoardData()).tasks.map((x: { id: string }) => x.id)).toContain(t.id)
  })

  test('import is idempotent: a retried import changes nothing', async () => {
    const t = await createOn(hubA, projectA, 'Twice')
    const begun = await hubA.taskMoves.begin({
      taskIds: [t.id],
      targetHubId: 'hub-b',
      targetProjectId: projectB
    })
    const bundle = await hubA.taskMoves.export({ id: begun.id })
    const input = { sourceHubId: 'hub-a', targetProjectId: projectB, bundle }
    await hubB.taskMoves.import(input)
    await hubB.taskMoves.import(input)
    expect(count(B, 'SELECT COUNT(*) AS n FROM tasks WHERE id = ?', t.id)).toBe(1)
    // Canceled: the target's copy goes away, the source's lock lifts.
    await hubB.taskMoves.abort({ id: begun.id })
    expect(row(B, t.id)).toBeUndefined()
    // Dropped, not deleted: no tombstone on B's side either.
    expect(
      count(
        B,
        "SELECT COUNT(*) AS n FROM chat_task_lifecycle WHERE task_id = ? AND state = 'deleted'",
        t.id
      )
    ).toBe(0)
    await hubA.taskMoves.cancel({ id: begun.id })
    await hubA.task.update({ id: t.id, title: 'still on A' } as unknown as UpdateTaskInput)
  })

  test('a target project the target hub does not have is refused before anything is written', async () => {
    const t = await createOn(hubA, projectA, 'Nowhere')
    const begun = await hubA.taskMoves.begin({
      taskIds: [t.id],
      targetHubId: 'hub-b',
      targetProjectId: 'missing'
    })
    const bundle = await hubA.taskMoves.export({ id: begun.id })
    const err = await errOf(() =>
      hubB.taskMoves.import({ sourceHubId: 'hub-a', targetProjectId: 'missing', bundle })
    )
    expect(err.code).toBe('BAD_REQUEST')
    expect(row(B, t.id)).toBeUndefined()
    await hubA.taskMoves.cancel({ id: begun.id })
  })

  test('and back again: B to A', async () => {
    const t = await createOn(hubA, projectA, 'Round trip')
    await move({ hub: hubA, id: 'hub-a' }, { hub: hubB, id: 'hub-b', projectId: projectB }, [t.id])
    const back = await move(
      { hub: hubB, id: 'hub-b' },
      { hub: hubA, id: 'hub-a', projectId: projectA },
      [t.id]
    )
    expect(back.status).toBe('done')
    expect(row(A, t.id)).toMatchObject({ project_id: projectA })
    expect(row(B, t.id)).toBeUndefined()
  })

  test('and back again: the chat A kept on its computer is A’s again, as it was', async () => {
    const t = await createOn(hubA, projectA, 'Round trip with a chat')
    const conversation = crypto.randomUUID()
    A.db
      .prepare(
        `INSERT INTO chat_ownership (id, task_id, tab_id, mode, computer_id, epoch, state)
         VALUES (?, ?, ?, 'claude-chat', 'computer-a', 3, 'active')`
      )
      .run(conversation, t.id, t.id)
    const owner = () =>
      A.db
        .prepare('SELECT state, epoch, cleanup_pending FROM chat_ownership WHERE id = ?')
        .get(conversation)
    const parked = () =>
      count(A, 'SELECT COUNT(*) AS n FROM task_move_parked_chats WHERE task_id = ?', t.id)

    const stay = { includeSessions: false }
    await move(
      { hub: hubA, id: 'hub-a' },
      { hub: hubB, id: 'hub-b', projectId: projectB },
      [t.id],
      stay
    )
    // Away: not A's (the delete trigger marked it), parked as it was.
    expect(owner()).toMatchObject({ state: 'deleted' })
    expect(parked()).toBe(1)

    await move(
      { hub: hubB, id: 'hub-b' },
      { hub: hubA, id: 'hub-a', projectId: projectA },
      [t.id],
      stay
    )
    // Back: the same ownership its computer still holds (same epoch), nothing parked.
    expect(owner()).toEqual({ state: 'active', epoch: 3, cleanup_pending: 0 })
    expect(parked()).toBe(0)
  })

  test('a chat deleted before the move stays deleted when the task comes back', async () => {
    const t = await createOn(hubA, projectA, 'Round trip, chat deleted first')
    const conversation = crypto.randomUUID()
    A.db
      .prepare(
        `INSERT INTO chat_ownership (id, task_id, tab_id, mode, computer_id, epoch, state)
         VALUES (?, ?, ?, 'claude-chat', 'computer-a', 2, 'deleted')`
      )
      .run(conversation, t.id, `gone-${t.id}`)
    const stay = { includeSessions: false }
    await move(
      { hub: hubA, id: 'hub-a' },
      { hub: hubB, id: 'hub-b', projectId: projectB },
      [t.id],
      stay
    )
    await move(
      { hub: hubB, id: 'hub-b' },
      { hub: hubA, id: 'hub-a', projectId: projectA },
      [t.id],
      stay
    )
    expect(
      A.db.prepare('SELECT state, epoch FROM chat_ownership WHERE id = ?').get(conversation)
    ).toEqual({ state: 'deleted', epoch: 2 })
  })

  test('the agent sessions arrive owned by the target hub, and the bytes are the same', async () => {
    const t = await createOn(hubA, projectA, 'With sessions')
    const tab = crypto.randomUUID()
    A.db
      .prepare(
        "INSERT INTO terminal_tabs (id, task_id, label, mode, position) VALUES (?, ?, 'Chat', 'claude-chat', 0)"
      )
      .run(tab, t.id)
    const conversation = crypto.randomUUID()
    // 600 KB: over two 256 KB chunks.
    const bytes = crypto.randomBytes(600_000)
    computers.holds.set(t.id, [
      { id: conversation, tabId: tab, mode: 'claude-chat', epoch: 3, bytes }
    ])
    // A Claude transcript beside it: 300 KB, two chunks.
    const transcript = crypto.randomBytes(300_000)
    computers.fileHolds.set(t.id, [{ sessionId: 'cli-1', bytes: transcript }])

    const done = await move(
      { hub: hubA, id: 'hub-a' },
      { hub: hubB, id: 'hub-b', projectId: projectB },
      [t.id]
    )
    expect(done.status).toBe('done')

    // The computer received every byte, in order, and staged the chat one epoch up.
    const staged = computers.staged.get(`t-${conversation}`)!
    expect(Buffer.concat(staged.chunks).equals(bytes)).toBe(true)
    expect(computers.activated).toContain(conversation)
    expect(Buffer.concat(computers.fileChunks.get('cli-1')!).equals(transcript)).toBe(true)
    expect(computers.ledgers.find((l) => l.taskId === t.id)?.ledger).toEqual({ sessions: 1 })
    expect(computers.discarded).toContain(done.id)
    expect(computers.settled).toContain(TARGET_COMPUTER)
    // Hub B owns it: active on that computer at the staged epoch, bound to the tab.
    expect(
      B.db
        .prepare('SELECT computer_id, epoch, state, tab_id, mode FROM chat_ownership WHERE id = ?')
        .get(conversation)
    ).toEqual({
      computer_id: TARGET_COMPUTER,
      epoch: 4,
      state: 'active',
      tab_id: tab,
      mode: 'claude-chat'
    })
    expect(
      B.db.prepare('SELECT conversation_id FROM chat_tab_bindings WHERE tab_id = ?').get(tab)
    ).toEqual({ conversation_id: conversation })
    expect(
      B.db.prepare('SELECT state FROM chat_task_lifecycle WHERE task_id = ?').get(t.id)
    ).toEqual({ state: 'active' })
  })

  test('a task that comes back finds its chat owned again at the newer epoch', async () => {
    const t = await createOn(hubA, projectA, 'Sessions back and forth')
    const tab = crypto.randomUUID()
    A.db
      .prepare(
        "INSERT INTO terminal_tabs (id, task_id, label, mode, position) VALUES (?, ?, 'Chat', 'claude-chat', 0)"
      )
      .run(tab, t.id)
    const conversation = crypto.randomUUID()
    A.db
      .prepare(
        `INSERT INTO chat_ownership (id, task_id, tab_id, mode, computer_id, epoch, state)
         VALUES (?, ?, ?, 'claude-chat', 'computer-a', 3, 'active')`
      )
      .run(conversation, t.id, tab)
    A.db
      .prepare('INSERT INTO chat_tab_bindings (tab_id, conversation_id) VALUES (?, ?)')
      .run(tab, conversation)
    computers.holds.set(t.id, [
      { id: conversation, tabId: tab, mode: 'claude-chat', epoch: 3, bytes: Buffer.from('one') }
    ])
    await move({ hub: hubA, id: 'hub-a' }, { hub: hubB, id: 'hub-b', projectId: projectB }, [t.id])

    // On B the chat grew (the computer there is at epoch 4 -> the next export says 4).
    computers.holds.set(t.id, [
      { id: conversation, tabId: tab, mode: 'claude-chat', epoch: 4, bytes: Buffer.from('one two') }
    ])
    await move({ hub: hubB, id: 'hub-b' }, { hub: hubA, id: 'hub-a', projectId: projectA }, [t.id])

    expect(
      A.db
        .prepare('SELECT computer_id, epoch, state FROM chat_ownership WHERE id = ?')
        .get(conversation)
    ).toEqual({ computer_id: TARGET_COMPUTER, epoch: 5, state: 'active' })
    expect(
      count(
        A,
        'SELECT COUNT(*) AS n FROM chat_deletion_targets WHERE conversation_id = ?',
        conversation
      )
    ).toBe(0)
  })

  test('a move that leaves the sessions behind copies none and registers none', async () => {
    const t = await createOn(hubA, projectA, 'Fresh sessions')
    const conversation = crypto.randomUUID()
    computers.holds.set(t.id, [
      { id: conversation, tabId: 'x', mode: 'claude-chat', epoch: 1, bytes: Buffer.from('private') }
    ])
    const done = await move(
      { hub: hubA, id: 'hub-a' },
      { hub: hubB, id: 'hub-b', projectId: projectB },
      [t.id],
      { includeSessions: false }
    )
    expect(done.status).toBe('done')
    expect(computers.staged.has(`t-${conversation}`)).toBe(false)
    expect(count(B, 'SELECT COUNT(*) AS n FROM chat_ownership WHERE id = ?', conversation)).toBe(0)
  })

  test('once the sessions went with the task, the source forgets them and owns nothing of them', async () => {
    const t = await createOn(hubA, projectA, 'Sessions leave the source')
    const tab = crypto.randomUUID()
    A.db
      .prepare(
        "INSERT INTO terminal_tabs (id, task_id, label, mode, position) VALUES (?, ?, 'Chat', 'claude-chat', 0)"
      )
      .run(tab, t.id)
    const conversation = crypto.randomUUID()
    A.db
      .prepare(
        `INSERT INTO chat_ownership (id, task_id, tab_id, mode, computer_id, epoch, state)
         VALUES (?, ?, ?, 'claude-chat', 'computer-a', 3, 'active')`
      )
      .run(conversation, t.id, tab)
    A.db
      .prepare('INSERT INTO chat_tab_bindings (tab_id, conversation_id) VALUES (?, ?)')
      .run(tab, conversation)
    computers.holds.set(t.id, [
      { id: conversation, tabId: tab, mode: 'claude-chat', epoch: 3, bytes: Buffer.from('x') }
    ])
    computers.forgotten.length = 0

    const done = await move(
      { hub: hubA, id: 'hub-a' },
      { hub: hubB, id: 'hub-b', projectId: projectB },
      [t.id]
    )
    expect(done.status).toBe('done')

    // The computers were told once, for these tasks; the hub keeps no trace of the chat.
    expect(computers.forgotten).toEqual([[t.id]])
    expect(count(A, 'SELECT COUNT(*) AS n FROM chat_ownership WHERE task_id = ?', t.id)).toBe(0)
    expect(count(A, 'SELECT COUNT(*) AS n FROM chat_tab_bindings WHERE tab_id = ?', tab)).toBe(0)
    expect(
      count(A, 'SELECT COUNT(*) AS n FROM task_move_parked_chats WHERE task_id = ?', t.id)
    ).toBe(0)
    // Never a deletion: nothing queued for the computers, no tombstone.
    expect(
      count(
        A,
        'SELECT COUNT(*) AS n FROM chat_deletion_targets WHERE conversation_id = ?',
        conversation
      )
    ).toBe(0)
    expect(
      count(
        A,
        "SELECT COUNT(*) AS n FROM chat_task_lifecycle WHERE task_id = ? AND state = 'deleted'",
        t.id
      )
    ).toBe(0)
    // The target owns it.
    expect(
      count(
        B,
        'SELECT COUNT(*) AS n FROM chat_ownership WHERE id = ? AND state = ?',
        conversation,
        'active'
      )
    ).toBe(1)
  })

  test('a canceled move forgets what it copied to the target and leaves the source as it was', async () => {
    const t = await createOn(hubA, projectA, 'Canceled after the sessions')
    const tab = crypto.randomUUID()
    A.db
      .prepare(
        "INSERT INTO terminal_tabs (id, task_id, label, mode, position) VALUES (?, ?, 'Chat', 'claude-chat', 0)"
      )
      .run(tab, t.id)
    const conversation = crypto.randomUUID()
    A.db
      .prepare(
        `INSERT INTO chat_ownership (id, task_id, tab_id, mode, computer_id, epoch, state)
         VALUES (?, ?, ?, 'claude-chat', 'computer-a', 3, 'active')`
      )
      .run(conversation, t.id, tab)
    computers.holds.set(t.id, [
      { id: conversation, tabId: tab, mode: 'claude-chat', epoch: 3, bytes: Buffer.from('x') }
    ])
    computers.forgotten.length = 0
    computers.discarded.length = 0

    // Stopped right before the target would take the task: the chat is copied and registered there.
    const paused = await move(
      { hub: hubA, id: 'hub-a' },
      { hub: hubB, id: 'hub-b', projectId: projectB },
      [t.id],
      { pauseAfter: 'commit' }
    )
    expect(paused.status).toBe('paused')
    expect(count(B, 'SELECT COUNT(*) AS n FROM chat_ownership WHERE id = ?', conversation)).toBe(1)

    await hubB.taskMoves.abort({ id: paused.id })
    await hubA.taskMoves.cancel({ id: paused.id })

    // The target let go of it and owns nothing; the source kept everything.
    expect(computers.forgotten).toEqual([[t.id]])
    expect(count(B, 'SELECT COUNT(*) AS n FROM chat_ownership WHERE id = ?', conversation)).toBe(0)
    expect(
      count(B, 'SELECT COUNT(*) AS n FROM task_move_parked_chats WHERE task_id = ?', t.id)
    ).toBe(0)
    expect(
      A.db.prepare('SELECT state, epoch FROM chat_ownership WHERE id = ?').get(conversation)
    ).toEqual({
      state: 'active',
      epoch: 3
    })
    // The source's exports are discarded.
    expect(computers.discarded).toContain(paused.id)
  })
})
