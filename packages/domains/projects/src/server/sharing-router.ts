import { EventEmitter } from 'node:events'
import { observable } from '@trpc/server/observable'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { getAuthGate, publicProcedure, router, type TrpcContext } from '@slayzone/trpc-server'
import { getHubAdminDeps } from '@slayzone/content-erasure/router'
import { ACCESS_ROLES, type AccessRole } from './project-access'
import { getSharingRouterDeps } from './sharing-router-deps'

/**
 * Sharing on a hub with login (T-100): who else may reach a project, a task or an
 * artifact, and with which role. The DECISION is never made here — the owner gate
 * (`api/owner-policy.ts`, `sharing.*`) checks every id each procedure names, at
 * `view` for reads and `manage` for every change. This router only reads and writes
 * the facts (`project_members`, `tasks.visibility`, `task_grants`, `artifact_grants`).
 *
 * Only hub-resident content is shared. Terminals, chats, worktrees and everything
 * else that lives on a computer stays with its one owner (`taskOwner` /
 * `projectOwner` in access.ts).
 */

const role = z.enum(ACCESS_ROLES as [AccessRole, ...AccessRole[]])
const artifactRole = z.enum(['view', 'edit'])
const userId = z.string().min(1).max(200)

/** Who a change concerns: they (and the actor) refetch what they can see. */
export interface SharingChangedEvent {
  readonly userIds: readonly string[]
}

const events = new EventEmitter()
events.setMaxListeners(0)

/** Tell `sharing.onChanged` subscribers (the owner gate delivers it to `userIds` only). */
export function emitSharingChanged(event: SharingChangedEvent): void {
  events.emit('changed', event)
}

function changed(ctx: TrpcContext, userIds: readonly (string | null | undefined)[]): void {
  getSharingRouterDeps().invalidate()
  const who = new Set<string>()
  for (const u of userIds) if (u) who.add(u)
  if (ctx.principal) who.add(ctx.principal.userId)
  events.emit('changed', { userIds: [...who] } satisfies SharingChangedEvent)
  getSharingRouterDeps().accessChanged([...who])
}

/** The enabled accounts of this hub, as a member picker lists them. */
async function directory(): Promise<{ id: string; name: string; email: string }[]> {
  const admin = getHubAdminDeps()
  if (!admin?.users.ready()) return []
  return (await admin.users.list())
    .filter((u) => u.disabledAt === null)
    .map((u) => ({ id: u.id, name: u.name, email: u.email }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.email.localeCompare(b.email))
}

/** A user granted something must be an enabled account of this hub. */
async function assertKnownUser(id: string): Promise<void> {
  // No directory (a hub without login, a pre-init boot): nothing to share with.
  if (!(await directory()).some((u) => u.id === id)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'No such user on this hub' })
  }
}

/**
 * Sharing never reaches past a project's people: a task or an artifact can be shared
 * with its project's owner or one of its members, nobody else on the hub. (`access.ts`
 * ignores any other grant all the same; this tells the caller.)
 */
async function assertInProject(ctx: TrpcContext, projectId: string, userId: string): Promise<void> {
  const row = await ctx.db.get<{ ok: number }>(
    `SELECT 1 AS ok FROM projects p WHERE p.id = ? AND (p.owner_user_id = ?
       OR EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = p.id AND m.user_id = ?))`,
    [projectId, userId, userId]
  )
  if (!row) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Only people in the project can be invited. Add them to the project first.'
    })
  }
}

async function projectOfTask(ctx: TrpcContext, taskId: string): Promise<string> {
  const row = await ctx.db.get<{ project_id: string }>(
    'SELECT project_id FROM tasks WHERE id = ?',
    [taskId]
  )
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Not found' })
  return row.project_id
}

async function projectOfArtifact(ctx: TrpcContext, artifactId: string): Promise<string> {
  const row = await ctx.db.get<{ project_id: string }>(
    'SELECT t.project_id FROM task_artifacts a JOIN tasks t ON t.id = a.task_id WHERE a.id = ?',
    [artifactId]
  )
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Not found' })
  return row.project_id
}

/** The task's ancestors, nearest first (the task itself first). */
async function chainOf(ctx: TrpcContext, taskId: string) {
  return ctx.db.all<{
    id: string
    parent_id: string | null
    project_id: string
    visibility: 'project' | 'private'
    created_by_user_id: string | null
  }>(
    `WITH RECURSIVE chain(id, depth) AS (
       SELECT ?, 0
       UNION ALL
       SELECT t.parent_id, c.depth + 1 FROM chain c JOIN tasks t ON t.id = c.id
        WHERE t.parent_id IS NOT NULL AND c.depth < 64)
     SELECT t.id, t.parent_id, t.project_id, t.visibility, t.created_by_user_id
       FROM chain c JOIN tasks t ON t.id = c.id ORDER BY c.depth`,
    [taskId]
  )
}

async function subtreeOf(ctx: TrpcContext, taskId: string): Promise<string[]> {
  const rows = await ctx.db.all<{ id: string }>(
    `WITH RECURSIVE sub(id, depth) AS (
       SELECT ?, 0
       UNION ALL
       SELECT t.id, s.depth + 1 FROM tasks t JOIN sub s ON t.parent_id = s.id WHERE s.depth < 64)
     SELECT id FROM sub`,
    [taskId]
  )
  return rows.map((r) => r.id)
}

export const sharingRouter = router({
  /**
   * Whether sharing applies on this hub — only one with login has users to share
   * with (without it, everything is the one operator's) — and who the caller is.
   */
  status: publicProcedure.query(({ ctx }) => ({
    enabled: getAuthGate() && !!ctx.principal,
    userId: ctx.principal?.userId ?? null
  })),
  /** Every enabled account of the hub (id, name, email): whom one can share with. */
  directory: publicProcedure.query(async () => directory()),

  /**
   * The caller's own role on each resource named; null where it has none (or it does
   * not exist — the two are not told apart). Drives read-only rendering.
   */
  myRoles: publicProcedure
    .input(
      z.object({
        resources: z
          .array(
            z.object({ kind: z.enum(['project', 'task', 'artifact', 'taskOwner']), id: z.string() })
          )
          .max(500)
      })
    )
    .query(async ({ ctx, input }) => {
      const out: Record<string, AccessRole | null> = {}
      for (const r of input.resources) {
        out[`${r.kind}:${r.id}`] = await getSharingRouterDeps().roleOf(ctx, r)
      }
      return out
    }),

  // ── projects ──
  projectMembers: publicProcedure
    .input(z.object({ projectId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const project = await ctx.db.get<{ owner_user_id: string | null }>(
        'SELECT owner_user_id FROM projects WHERE id = ?',
        [input.projectId]
      )
      const members = await ctx.db.all<{ user_id: string; role: AccessRole; created_at: string }>(
        'SELECT user_id, role, created_at FROM project_members WHERE project_id = ? ORDER BY created_at',
        [input.projectId]
      )
      return {
        ownerUserId: project?.owner_user_id ?? null,
        members: members.map((m) => ({ userId: m.user_id, role: m.role, addedAt: m.created_at }))
      }
    }),
  setProjectMember: publicProcedure
    .input(z.object({ projectId: z.string().min(1), userId, role }))
    .mutation(async ({ ctx, input }) => {
      await assertKnownUser(input.userId)
      const project = await ctx.db.get<{ owner_user_id: string | null }>(
        'SELECT owner_user_id FROM projects WHERE id = ?',
        [input.projectId]
      )
      if (project?.owner_user_id === input.userId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'The owner is already in the project' })
      }
      await ctx.db.run(
        `INSERT INTO project_members (project_id, user_id, role, added_by) VALUES (?, ?, ?, ?)
         ON CONFLICT (project_id, user_id) DO UPDATE SET role = excluded.role`,
        [input.projectId, input.userId, input.role, ctx.principal?.userId ?? null]
      )
      changed(ctx, [input.userId])
      getSharingRouterDeps().onProjectShared(input.projectId)
      return { ok: true as const }
    }),
  /**
   * Take someone out of the project — and with it every task and artifact of the
   * project they were invited to: sharing never reaches past the project's people,
   * and adding them back later must not bring old invitations back with it.
   */
  removeProjectMember: publicProcedure
    .input(z.object({ projectId: z.string().min(1), userId }))
    .mutation(async ({ ctx, input }) => {
      // One transaction: no moment where they are out of the project yet still invited.
      // The owner stays in the project whatever its member rows say: theirs are kept.
      const notOwner = `NOT EXISTS (SELECT 1 FROM projects WHERE id = ? AND owner_user_id = ?)`
      await ctx.db.batchTxn([
        {
          type: 'run',
          sql: 'DELETE FROM project_members WHERE project_id = ? AND user_id = ?',
          params: [input.projectId, input.userId]
        },
        {
          type: 'run',
          sql: `DELETE FROM task_grants WHERE user_id = ? AND ${notOwner}
                  AND task_id IN (SELECT id FROM tasks WHERE project_id = ?)`,
          params: [input.userId, input.projectId, input.userId, input.projectId]
        },
        {
          type: 'run',
          sql: `DELETE FROM artifact_grants WHERE user_id = ? AND ${notOwner}
                  AND artifact_id IN (SELECT a.id FROM task_artifacts a
                    JOIN tasks t ON t.id = a.task_id WHERE t.project_id = ?)`,
          params: [input.userId, input.projectId, input.userId, input.projectId]
        }
      ])
      changed(ctx, [input.userId])
      return { ok: true as const }
    }),

  // ── tasks ──
  /**
   * A task's sharing: the root task that decides it (subtasks inherit), its
   * visibility and creator, the users invited to this task, and those invited to an
   * ancestor (inherited, read-only here).
   */
  taskSharing: publicProcedure
    .input(z.object({ taskId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const chain = await chainOf(ctx, input.taskId)
      if (chain.length === 0) throw new TRPCError({ code: 'NOT_FOUND', message: 'Not found' })
      const root = chain[chain.length - 1]
      const grants = await ctx.db.all<{ task_id: string; user_id: string; role: AccessRole }>(
        `SELECT task_id, user_id, role FROM task_grants
          WHERE task_id IN (SELECT value FROM json_each(?)) ORDER BY created_at`,
        [JSON.stringify(chain.map((t) => t.id))]
      )
      return {
        rootTaskId: root.id,
        projectId: root.project_id,
        visibility: root.visibility,
        createdByUserId: root.created_by_user_id,
        grants: grants
          .filter((g) => g.task_id === input.taskId)
          .map((g) => ({ userId: g.user_id, role: g.role })),
        inherited: grants
          .filter((g) => g.task_id !== input.taskId)
          .map((g) => ({ taskId: g.task_id, userId: g.user_id, role: g.role }))
      }
    }),
  /**
   * Make a top-level task private (its creator and the users invited to it only) or
   * visible to the whole project again. A subtask follows its top-level task.
   */
  setTaskVisibility: publicProcedure
    .input(z.object({ taskId: z.string().min(1), visibility: z.enum(['project', 'private']) }))
    .mutation(async ({ ctx, input }) => {
      const chain = await chainOf(ctx, input.taskId)
      const task = chain[0]
      if (!task) throw new TRPCError({ code: 'NOT_FOUND', message: 'Not found' })
      if (task.parent_id !== null) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'A subtask follows its top-level task: change that one instead'
        })
      }
      if (task.visibility === input.visibility) return { ok: true as const }
      const project = await ctx.db.get<{ owner_user_id: string | null }>(
        'SELECT owner_user_id FROM projects WHERE id = ?',
        [task.project_id]
      )
      const subtree = await subtreeOf(ctx, task.id)
      // Terminals and agents on a computer belong to ONE user: whoever owned the task's
      // computer side so far keeps them (a tab with no owner on record falls back to
      // the task's owner user, which this change is about to move).
      const ownerUserBefore =
        task.visibility === 'private' ? task.created_by_user_id : (project?.owner_user_id ?? null)
      if (ownerUserBefore) {
        await ctx.db.run(
          `UPDATE terminal_tabs SET owner_user_id = ?
            WHERE owner_user_id IS NULL AND task_id IN (SELECT value FROM json_each(?))`,
          [ownerUserBefore, JSON.stringify(subtree)]
        )
      }
      const actor = ctx.principal?.userId ?? null
      // A private task is its creator's: one that has none on record becomes the
      // actor's. Whoever makes it private keeps it (a manager who is not its creator
      // gets a manage grant), so a change never locks its own author out.
      const creator = task.created_by_user_id ?? actor
      await ctx.db.run('UPDATE tasks SET visibility = ?, created_by_user_id = ? WHERE id = ?', [
        input.visibility,
        creator,
        task.id
      ])
      if (input.visibility === 'private' && actor && actor !== creator) {
        await ctx.db.run(
          `INSERT INTO task_grants (task_id, user_id, role, added_by) VALUES (?, ?, 'manage', ?)
           ON CONFLICT (task_id, user_id) DO UPDATE SET role = 'manage'`,
          [task.id, actor, actor]
        )
      }
      // Everyone in the project may gain or lose it.
      const members = await ctx.db.all<{ user_id: string }>(
        'SELECT user_id FROM project_members WHERE project_id = ?',
        [task.project_id]
      )
      changed(ctx, [project?.owner_user_id, creator, ...members.map((m) => m.user_id)])
      getSharingRouterDeps().tasksChanged(subtree)
      // Visible to the project again: its members now reach its artifacts.
      if (input.visibility === 'project' && members.length > 0)
        getSharingRouterDeps().onTaskShared(task.id)
      return { ok: true as const }
    }),
  /** Invite one of the project's people to a task (a private one, or above their role). */
  setTaskGrant: publicProcedure
    .input(z.object({ taskId: z.string().min(1), userId, role }))
    .mutation(async ({ ctx, input }) => {
      await assertKnownUser(input.userId)
      await assertInProject(ctx, await projectOfTask(ctx, input.taskId), input.userId)
      await ctx.db.run(
        `INSERT INTO task_grants (task_id, user_id, role, added_by) VALUES (?, ?, ?, ?)
         ON CONFLICT (task_id, user_id) DO UPDATE SET role = excluded.role`,
        [input.taskId, input.userId, input.role, ctx.principal?.userId ?? null]
      )
      changed(ctx, [input.userId])
      getSharingRouterDeps().tasksChanged(await subtreeOf(ctx, input.taskId))
      getSharingRouterDeps().onTaskShared(input.taskId)
      return { ok: true as const }
    }),
  removeTaskGrant: publicProcedure
    .input(z.object({ taskId: z.string().min(1), userId }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.run('DELETE FROM task_grants WHERE task_id = ? AND user_id = ?', [
        input.taskId,
        input.userId
      ])
      changed(ctx, [input.userId])
      return { ok: true as const }
    }),

  // ── artifacts ──
  artifactGrants: publicProcedure
    .input(z.object({ artifactId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.all<{ user_id: string; role: 'view' | 'edit' }>(
        'SELECT user_id, role FROM artifact_grants WHERE artifact_id = ? ORDER BY created_at',
        [input.artifactId]
      )
      return rows.map((r) => ({ userId: r.user_id, role: r.role }))
    }),
  /**
   * Invite one of the project's people to one artifact — on its own, too: someone not
   * invited to its private task opens this artifact only. A shared artifact lives on
   * the hub: one held by a computer is moved there first (every version), so the
   * grantee can reach it while that computer is away. The move gives it a new id,
   * which this answers.
   */
  setArtifactGrant: publicProcedure
    .input(z.object({ artifactId: z.string().min(1), userId, role: artifactRole }))
    .mutation(async ({ ctx, input }) => {
      await assertKnownUser(input.userId)
      await assertInProject(ctx, await projectOfArtifact(ctx, input.artifactId), input.userId)
      let artifactId: string
      try {
        artifactId = await getSharingRouterDeps().promoteArtifact(input.artifactId)
      } catch (err) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: `This file is on a computer that must be connected to share it (${
            err instanceof Error ? err.message : String(err)
          })`
        })
      }
      await ctx.db.run(
        `INSERT INTO artifact_grants (artifact_id, user_id, role, added_by) VALUES (?, ?, ?, ?)
         ON CONFLICT (artifact_id, user_id) DO UPDATE SET role = excluded.role`,
        [artifactId, input.userId, input.role, ctx.principal?.userId ?? null]
      )
      changed(ctx, [input.userId])
      return { ok: true as const, artifactId }
    }),
  removeArtifactGrant: publicProcedure
    .input(z.object({ artifactId: z.string().min(1), userId }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.run('DELETE FROM artifact_grants WHERE artifact_id = ? AND user_id = ?', [
        input.artifactId,
        input.userId
      ])
      changed(ctx, [input.userId])
      return { ok: true as const }
    }),

  /**
   * The artifacts shared with the caller ON THEIR OWN: invited to the artifact, while
   * its task stays out of reach (a private task they are not invited to). Nothing of
   * the task travels with them. Newest first; `isNew` until the caller opens it
   * ({@link markArtifactOpened}). The owner gate cuts each row to what the caller may
   * open — the project's people only.
   */
  artifactsSharedWithMe: publicProcedure.query(async ({ ctx }) => {
    const me = ctx.principal?.userId
    if (!me) return []
    const rows = await ctx.db.all<{
      id: string
      title: string
      task_id: string
      project_id: string
      role: 'view' | 'edit'
      added_by: string | null
      opened_at: string | null
    }>(
      `SELECT a.id, a.title, a.task_id, t.project_id, g.role, g.added_by, g.opened_at
         FROM artifact_grants g
         JOIN task_artifacts a ON a.id = g.artifact_id
         JOIN tasks t ON t.id = a.task_id
        WHERE g.user_id = ? AND t.deleted_at IS NULL
        ORDER BY g.created_at DESC, a.id`,
      [me]
    )
    const out: {
      id: string
      title: string
      projectId: string
      sharedByUserId: string | null
      role: 'view' | 'edit'
      isNew: boolean
    }[] = []
    for (const r of rows) {
      // Its task is open to the caller: the artifact is found there, not here.
      if ((await getSharingRouterDeps().roleOf(ctx, { kind: 'task', id: r.task_id })) !== null)
        continue
      out.push({
        id: r.id,
        title: r.title,
        projectId: r.project_id,
        sharedByUserId: r.added_by,
        role: r.role,
        isNew: r.opened_at === null
      })
    }
    return out
  }),
  /** The caller opened an artifact shared with them: it is no longer new. */
  markArtifactOpened: publicProcedure
    .input(z.object({ artifactId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const me = ctx.principal?.userId
      if (!me) return { ok: true as const }
      const r = await ctx.db.run(
        `UPDATE artifact_grants SET opened_at = datetime('now')
          WHERE artifact_id = ? AND user_id = ? AND opened_at IS NULL`,
        [input.artifactId, me]
      )
      if (r.changes > 0) changed(ctx, [])
      return { ok: true as const }
    }),

  /** Something about sharing changed for one of `userIds`: refetch what you can see. */
  onChanged: publicProcedure.subscription(() =>
    observable<SharingChangedEvent>((emit) => {
      const handler = (e: SharingChangedEvent): void => emit.next(e)
      events.on('changed', handler)
      return () => {
        events.off('changed', handler)
      }
    })
  )
})

export type SharingRouter = typeof sharingRouter
