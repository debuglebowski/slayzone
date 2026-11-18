/**
 * T-100, sharing on a REAL hub with login (`startServer()` in this process, its real
 * auth, `/trpc` socket, routers and owner gate; see owner-checks-harness.ts):
 *
 *   A owns a project. B is an edit member, C a view member, D nobody in it — until A
 *   invites D to one task. What each may read and change follows their role; what
 *   lives on a computer (terminals) stays A's; a private task is its creator's and
 *   its grantees' only — the project owner included.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run \
 *   --config packages/shared/test-utils/vitest.harness.config.ts \
 *   packages/apps/hub/src/sharing.test.ts
 */
import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
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
    expect(await codeOf(q(cb, 'taskTerminals.list', { taskId: A.task }))).toBe('NOT_FOUND')
    expect(await codeOf(q(cb, 'pty.getBuffer', { sessionId: A.session }))).toBe('NOT_FOUND')
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

  test('a grant opens one task to an outsider, and nothing else of the project', async () => {
    await m(cb, 'sharing.setTaskGrant', { taskId: 't_b_private', userId: ids.d, role: 'view' })
    expect(await codeOf(q(cd, 'task.get', { id: 't_b_private' }))).toBe('OK')
    expect(await codeOf(q(cd, 'task.get', { id: A.task }))).toBe('NOT_FOUND')
    expect(await codeOf(m(cd, 'task.update', { id: 't_b_private', title: 'by D' }))).toBe(
      'FORBIDDEN'
    )
    const mine = (await q(cd, 'sharing.sharedWithMe')) as { tasks: { id: string }[] }
    expect(mine.tasks.map((t) => t.id)).toEqual(['t_b_private'])
    // Revoked: gone again.
    await m(cb, 'sharing.removeTaskGrant', { taskId: 't_b_private', userId: ids.d })
    expect(await codeOf(q(cd, 'task.get', { id: 't_b_private' }))).toBe('NOT_FOUND')
  })

  test('removing a member closes the project to them', async () => {
    await m(ca, 'sharing.removeProjectMember', { projectId: A.project, userId: ids.c })
    expect(await codeOf(q(cc, 'task.get', { id: A.task }))).toBe('NOT_FOUND')
  })
})
