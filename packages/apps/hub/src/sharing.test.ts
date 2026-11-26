/**
 * T-100, sharing on a REAL hub with login (`startServer()` in this process, its real
 * auth, `/trpc` socket, routers and owner gate; see owner-checks-harness.ts):
 *
 *   A owns a project. B is an edit member, C a view member, D nobody in it. Only
 *   people in the project can be invited to a private task or a file: D never can.
 *   What each may read and change follows their role; what lives on a computer
 *   (terminals) stays A's; a private task is its creator's and its grantees' only —
 *   the project owner included. A file shared on its own opens that file only.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/apps/hub/src/sharing.test.ts
 */
import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { getGitWatcher } from '@slayzone/worktrees/server'
// Same module instance the routers subscribe to (see owner-checks-harness.ts).
import { agentTurnsEvents } from '../../../domains/agent-turns/src/server/index.js'
import {
  bootInProcessHub,
  hubClient,
  ownedBy,
  procedureAt,
  seedOwned,
  signedInUser,
  type Owned
} from './owner-checks-harness.js'

type Client = ReturnType<typeof hubClient>

async function q(c: Client, path: string, input?: unknown): Promise<unknown> {
  return procedureAt(c.client, path).query(input)
}
async function m(c: Client, path: string, input?: unknown): Promise<unknown> {
  return procedureAt(c.client, path).mutate(input)
}
/** The tRPC error code a call ends in, or 'OK'. */
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return 'OK'
  } catch (e) {
    return (e as { data?: { code?: string } }).data?.code ?? String(e)
  }
}

describe('T-100 sharing: members, roles, private tasks and grants on a real hub', () => {
  let hub: Awaited<ReturnType<typeof bootInProcessHub>>
  let A: Owned
  const ids = { b: '', c: '', d: '' }
  let ca: Client
  let cb: Client
  let cc: Client
  let cd: Client
  let raw: Database.Database

  beforeAll(async () => {
    hub = await bootInProcessHub({ login: true })
    const a = await signedInUser(hub, 'a@example.com')
    const b = await signedInUser(hub, 'b@example.com')
    const c = await signedInUser(hub, 'c@example.com')
    const d = await signedInUser(hub, 'd@example.com')
    Object.assign(ids, { b: b.userId, c: c.userId, d: d.userId })
    A = ownedBy('A_PROJ', a.userId, hub.root)
    seedOwned(hub.dbPath, A)
    raw = new Database(hub.dbPath)
    // B's own task in A's project (B created it), private later in the run.
    raw
      .prepare(
        `INSERT INTO tasks (id, project_id, title, created_by_user_id) VALUES ('t_b_private', ?, 'B_PRIVATE', ?)`
      )
      .run(A.project, b.userId)
    ca = hubClient(hub, a.token)
    cb = hubClient(hub, b.token)
    cc = hubClient(hub, c.token)
    cd = hubClient(hub, d.token)
  })

  afterAll(async () => {
    raw?.close()
    for (const c of [ca, cb, cc, cd]) c?.close()
    await hub?.stop()
  })

  test('the directory lists the enabled accounts to any user', async () => {
    const dir = (await q(cd, 'sharing.directory')) as { email: string }[]
    expect(dir.map((u) => u.email)).toEqual(
      expect.arrayContaining(['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com'])
    )
  })

  test('before sharing, nobody but A sees the project', async () => {
    expect(await codeOf(q(cb, 'task.get', { id: A.task }))).toBe('NOT_FOUND')
    expect(await codeOf(q(cb, 'sharing.projectMembers', { projectId: A.project }))).toBe(
      'NOT_FOUND'
    )
  })

  test('the owner adds members; only a manager may', async () => {
    await m(ca, 'sharing.setProjectMember', { projectId: A.project, userId: ids.b, role: 'edit' })
    await m(ca, 'sharing.setProjectMember', { projectId: A.project, userId: ids.c, role: 'view' })
    const members = (await q(cc, 'sharing.projectMembers', { projectId: A.project })) as {
      members: { userId: string; role: string }[]
    }
    expect(members.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: ids.b, role: 'edit' }),
        expect.objectContaining({ userId: ids.c, role: 'view' })
      ])
    )
    // B (edit) can see the project but not manage who is in it.
    expect(
      await codeOf(
        m(cb, 'sharing.setProjectMember', { projectId: A.project, userId: ids.d, role: 'view' })
      )
    ).toBe('FORBIDDEN')
    // D is in nothing: the project does not exist for D.
    expect(
      await codeOf(
        m(cd, 'sharing.setProjectMember', { projectId: A.project, userId: ids.d, role: 'manage' })
      )
    ).toBe('NOT_FOUND')
  })

  test('members read the task; edit changes it, view may not', async () => {
    expect(await codeOf(q(cc, 'task.get', { id: A.task }))).toBe('OK')
    expect(await codeOf(m(cc, 'task.update', { id: A.task, title: 'by C' }))).toBe('FORBIDDEN')
    expect(await codeOf(m(cb, 'task.update', { id: A.task, title: 'by B' }))).toBe('OK')
    const roles = (await q(cc, 'sharing.myRoles', {
      resources: [
        { kind: 'project', id: A.project },
        { kind: 'task', id: A.task }
      ]
    })) as Record<string, string | null>
    expect(roles).toEqual({ [`project:${A.project}`]: 'view', [`task:${A.task}`]: 'view' })
  })

  test("what lives on a computer stays the owner's: members never reach A's terminals", async () => {
    const asked = { resources: [{ kind: 'taskOwner', id: A.task }] }
    expect(await q(cb, 'sharing.myRoles', asked)).toEqual({ [`taskOwner:${A.task}`]: null })
    expect(await q(ca, 'sharing.myRoles', asked)).toEqual({ [`taskOwner:${A.task}`]: 'manage' })
    // B (edit) runs the task on B's own computer: B's tab list holds none of A's tabs.
    const bTabs = (await q(cb, 'taskTerminals.list', { taskId: A.task })) as { id: string }[]
    expect(bTabs.map((t) => t.id)).not.toContain(A.tab)
    expect(JSON.stringify(bTabs)).not.toContain(A.mark)
    expect(await codeOf(q(cb, 'pty.getBuffer', { sessionId: A.session }))).toBe('NOT_FOUND')
    // C (view) may not start anything of its own.
    expect(await codeOf(m(cc, 'taskTerminals.create', { taskId: A.task, mode: 'terminal' }))).toBe(
      'FORBIDDEN'
    )
    expect(await codeOf(q(ca, 'taskTerminals.list', { taskId: A.task }))).toBe('OK')
  })

  test("a private task is its creator's and its grantees' — not the project owner's", async () => {
    // Only a manager of the task may change its visibility: B created it (manage).
    expect(
      await codeOf(
        m(cc, 'sharing.setTaskVisibility', { taskId: 't_b_private', visibility: 'private' })
      )
    ).toBe('FORBIDDEN')
    await m(cb, 'sharing.setTaskVisibility', { taskId: 't_b_private', visibility: 'private' })
    expect(await codeOf(q(ca, 'task.get', { id: 't_b_private' }))).toBe('NOT_FOUND')
    expect(await codeOf(q(cc, 'task.get', { id: 't_b_private' }))).toBe('NOT_FOUND')
    expect(await codeOf(q(cb, 'task.get', { id: 't_b_private' }))).toBe('OK')
    // The owner's board holds no trace of it.
    const board = (await q(ca, 'task.loadBoardData')) as { tasks: { id: string }[] }
    expect(board.tasks.map((t) => t.id)).toContain(A.task)
    expect(JSON.stringify(board)).not.toContain('B_PRIVATE')
  })

  test('only people in the project can be invited — to a task or to a file', async () => {
    // D is on the hub but not in the project: refused, whoever asks.
    expect(
      await codeOf(
        m(cb, 'sharing.setTaskGrant', { taskId: 't_b_private', userId: ids.d, role: 'view' })
      )
    ).toBe('BAD_REQUEST')
    expect(
      await codeOf(
        m(ca, 'sharing.setArtifactGrant', { artifactId: A.artifact, userId: ids.d, role: 'view' })
      )
    ).toBe('BAD_REQUEST')
    expect(
      raw.prepare('SELECT COUNT(*) AS n FROM task_grants WHERE user_id = ?').get(ids.d)
    ).toEqual({ n: 0 })
    // A grant row to an outsider that got in some other way opens nothing.
    raw
      .prepare(`INSERT INTO task_grants (task_id, user_id, role) VALUES ('t_b_private', ?, 'view')`)
      .run(ids.d)
    try {
      expect(await codeOf(q(cd, 'task.get', { id: 't_b_private' }))).toBe('NOT_FOUND')
    } finally {
      raw.prepare(`DELETE FROM task_grants WHERE user_id = ?`).run(ids.d)
    }
    // A member is invited to the private task: C sees it, and only as invited.
    await m(cb, 'sharing.setTaskGrant', { taskId: 't_b_private', userId: ids.c, role: 'view' })
    expect(await codeOf(q(cc, 'task.get', { id: 't_b_private' }))).toBe('OK')
    expect(await codeOf(m(cc, 'task.update', { id: 't_b_private', title: 'by C' }))).toBe(
      'FORBIDDEN'
    )
    await m(cb, 'sharing.removeTaskGrant', { taskId: 't_b_private', userId: ids.c })
    expect(await codeOf(q(cc, 'task.get', { id: 't_b_private' }))).toBe('NOT_FOUND')
  })

  test('a file shared on its own opens that file, not its task, and is listed as shared', async () => {
    raw
      .prepare(
        `INSERT INTO task_artifacts (id, task_id, title) VALUES ('art_b_private', 't_b_private', 'B_FILE')`
      )
      .run()
    await m(cb, 'sharing.setArtifactGrant', {
      artifactId: 'art_b_private',
      userId: ids.c,
      role: 'view'
    })
    expect(await codeOf(q(cc, 'artifacts.get', { id: 'art_b_private' }))).toBe('OK')
    expect(await codeOf(q(cc, 'task.get', { id: 't_b_private' }))).toBe('NOT_FOUND')
    // A file of a task C already sees is not "shared on its own": not listed.
    await m(ca, 'sharing.setArtifactGrant', { artifactId: A.artifact, userId: ids.c, role: 'edit' })
    const listed = (await q(cc, 'sharing.artifactsSharedWithMe')) as unknown[]
    expect(listed).toEqual([
      {
        id: 'art_b_private',
        title: 'B_FILE',
        projectId: A.project,
        sharedByUserId: ids.b,
        role: 'view',
        isNew: true
      }
    ])
    // Nothing of the task travels with it.
    expect(JSON.stringify(listed)).not.toContain('"t_b_private"')
    expect(JSON.stringify(listed)).not.toContain('B_PRIVATE')
    // Opened: no longer new.
    await m(cc, 'sharing.markArtifactOpened', { artifactId: 'art_b_private' })
    expect(
      ((await q(cc, 'sharing.artifactsSharedWithMe')) as { isNew: boolean }[]).map((a) => a.isNew)
    ).toEqual([false])
    // Someone it was not shared with may not mark it, and lists nothing.
    expect(await codeOf(m(cd, 'sharing.markArtifactOpened', { artifactId: 'art_b_private' }))).toBe(
      'NOT_FOUND'
    )
    expect(await q(cd, 'sharing.artifactsSharedWithMe')).toEqual([])
  })

  test('an editor assigns the task to a hub user; the external assignee stays', async () => {
    raw.prepare(`UPDATE tasks SET assignee = 'linear-person' WHERE id = ?`).run(A.task)
    await m(cb, 'task.update', { id: A.task, assigneeUserId: ids.c })
    const task = (await q(cc, 'task.get', { id: A.task })) as {
      assignee_user_id: string | null
      assignee: string | null
    }
    expect(task.assignee_user_id).toBe(ids.c)
    expect(task.assignee).toBe('linear-person')
  })

  test("a member's own agent turns and git diffs reach them live; the creator's stay the creator's", async () => {
    raw
      .prepare(
        `INSERT INTO terminal_tabs (id, task_id, mode, is_main, owner_user_id) VALUES ('tab_b_own', ?, 'claude-code', 0, ?)`
      )
      .run(A.task, ids.b)
    const got: Record<string, unknown[]> = {}
    const subs: { unsubscribe: () => void }[] = []
    const listen = (who: string, c: Client, path: string) =>
      new Promise<void>((resolve, reject) => {
        got[`${who} ${path}`] = []
        subs.push(
          procedureAt(c.client, path).subscribe(undefined, {
            onStarted: () => resolve(),
            onData: (v) => got[`${who} ${path}`]!.push(v),
            onError: (e) => reject(new Error(`${who} ${path}: ${String(e)}`))
          })
        )
      })
    const paths = ['agentTurns.onChanged', 'worktrees.onDiffChanged']
    await Promise.all(paths.flatMap((p) => [listen('A', ca, p), listen('B', cb, p)]))
    try {
      const counts = async (emit: () => void): Promise<Record<string, number>> => {
        for (const k of Object.keys(got)) got[k] = []
        emit()
        await new Promise((r) => setTimeout(r, 400))
        return Object.fromEntries(Object.entries(got).map(([k, v]) => [k, v.length]))
      }
      // B's agent finished a turn in B's own tab: B refreshes, A has nothing to refresh.
      expect(
        await counts(() =>
          agentTurnsEvents.emit('agent-turns:changed', {
            worktreePath: '/b/checkout',
            taskId: A.task,
            tabId: 'tab_b_own'
          })
        )
      ).toMatchObject({ 'B agentTurns.onChanged': 1, 'A agentTurns.onChanged': 0 })
      // A's own tab: A's alone.
      expect(
        await counts(() =>
          agentTurnsEvents.emit('agent-turns:changed', {
            worktreePath: '/a/checkout',
            taskId: A.task,
            tabId: A.tab
          })
        )
      ).toMatchObject({ 'B agentTurns.onChanged': 0, 'A agentTurns.onChanged': 1 })
      // A diff watch is the watcher's: B's checkout to B, A's to A.
      const diff = (userId: string) => () =>
        getGitWatcher().emit('git:diff-changed', {
          worktreePath: '/checkout',
          refsChanged: false,
          taskId: A.task,
          userId
        })
      expect(await counts(diff(ids.b))).toMatchObject({
        'B worktrees.onDiffChanged': 1,
        'A worktrees.onDiffChanged': 0
      })
      expect(await counts(diff(A.userId!))).toMatchObject({
        'B worktrees.onDiffChanged': 0,
        'A worktrees.onDiffChanged': 1
      })
    } finally {
      for (const s of subs) s.unsubscribe()
    }
  })

  test('removing a member closes the project to them, and takes their task and file grants', async () => {
    await m(cb, 'sharing.setTaskGrant', { taskId: 't_b_private', userId: ids.c, role: 'view' })
    await m(ca, 'sharing.removeProjectMember', { projectId: A.project, userId: ids.c })
    expect(await codeOf(q(cc, 'task.get', { id: A.task }))).toBe('NOT_FOUND')
    expect(await codeOf(q(cc, 'task.get', { id: 't_b_private' }))).toBe('NOT_FOUND')
    expect(await codeOf(q(cc, 'artifacts.get', { id: 'art_b_private' }))).toBe('NOT_FOUND')
    expect(await q(cc, 'sharing.artifactsSharedWithMe')).toEqual([])
    const left = (table: string) =>
      raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).get(ids.c)
    expect(left('task_grants')).toEqual({ n: 0 })
    expect(left('artifact_grants')).toEqual({ n: 0 })
    // Added back, they get the project again, but not what they were invited to before.
    await m(ca, 'sharing.setProjectMember', { projectId: A.project, userId: ids.c, role: 'view' })
    expect(await codeOf(q(cc, 'task.get', { id: A.task }))).toBe('OK')
    expect(await codeOf(q(cc, 'task.get', { id: 't_b_private' }))).toBe('NOT_FOUND')
  })
})
