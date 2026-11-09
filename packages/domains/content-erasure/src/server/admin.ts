import type { SlayzoneDb } from '@slayzone/platform'
import { eraseContent, getErasureReport, resumeErasure, exportErasureReceipt } from './index'
import type { ErasureJob } from './manifest'
import { AdminContentErasureError } from './admin-errors'
import { createOfflineErasure } from './offline'
export { AdminContentErasureError } from './admin-errors'

export interface ErasureActor {
  userId: string
  role: 'admin' | 'user'
  scopes: readonly string[]
}
export interface ErasureAccount {
  id: string
  email: string
  name: string
  disabledAt: string | null
}

const accountLocks = new Map<string, Promise<void>>()
/** Enable and erase share this lock; a target cannot become active mid-erasure. */
export async function withErasureAccountLock<T>(userId: string, run: () => Promise<T>): Promise<T> {
  const previous = accountLocks.get(userId) ?? Promise.resolve()
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.catch(() => undefined).then(() => held)
  accountLocks.set(userId, tail)
  await previous.catch(() => undefined)
  try {
    return await run()
  } finally {
    release()
    if (accountLocks.get(userId) === tail) accountLocks.delete(userId)
  }
}

function requireAdmin(actor: ErasureActor) {
  if (actor.role !== 'admin' || !actor.scopes.includes('full'))
    throw new AdminContentErasureError(
      'ADMIN_ONLY',
      'Only a hub admin with a full session can erase another user’s content.'
    )
}

export function createAdminContentErasure(options: {
  db: SlayzoneDb
  dataRoot: string
  /** Must exclude service/break-glass identities, as findHubUser does. */
  findUser: (id: string) => Promise<ErasureAccount | null>
}) {
  const { db, dataRoot, findUser } = options
  async function disabledUser(id: string): Promise<ErasureAccount> {
    const user = await findUser(id)
    if (!user) throw new AdminContentErasureError('USER_NOT_FOUND', 'User not found.')
    if (!user.disabledAt)
      throw new AdminContentErasureError(
        'USER_NOT_DISABLED',
        'Disable the user before erasing their content.'
      )
    return user
  }
  async function preview(input: { actor: ErasureActor; userId: string }) {
    requireAdmin(input.actor)
    await disabledUser(input.userId)
    const projects = 'SELECT id FROM projects WHERE owner_user_id=?'
    const tasks = `SELECT id FROM tasks WHERE project_id IN (${projects})`
    const artifacts = `SELECT id FROM task_artifacts WHERE task_id IN (${tasks})`
    const count = async (sql: string) => (await db.get<{ n: number }>(sql, [input.userId]))?.n ?? 0
    return {
      counts: {
        projects: await count(`SELECT count(*) AS n FROM projects WHERE owner_user_id=?`),
        tasks: await count(`SELECT count(*) AS n FROM tasks WHERE project_id IN (${projects})`),
        artifacts: await count(
          `SELECT count(*) AS n FROM task_artifacts WHERE task_id IN (${tasks})`
        ),
        versions: await count(
          `SELECT count(*) AS n FROM artifact_versions WHERE artifact_id IN (${artifacts})`
        )
      }
    }
  }
  return {
    ...createOfflineErasure({
      db,
      dataRoot,
      requireAdmin,
      disabledUser,
      withAccountLock: withErasureAccountLock
    }),
    preview,
    async erase(input: { actor: ErasureActor; userId: string; confirmation: string }) {
      requireAdmin(input.actor)
      return withErasureAccountLock(input.userId, async () => {
        const user = await disabledUser(input.userId)
        if (input.confirmation.trim().toLowerCase() !== user.email.trim().toLowerCase())
          throw new AdminContentErasureError(
            'CONFIRMATION_MISMATCH',
            'Type the selected user’s email to confirm permanent erasure.'
          )
        const report = await eraseContent(
          db,
          dataRoot,
          { kind: 'user', userId: user.id },
          {
            actorUserId: input.actor.userId,
            beforeResume: async () => {
              await disabledUser(user.id)
            }
          }
        )
        return report
      })
    },
    async reports(input: { actor: ErasureActor; userId: string }) {
      requireAdmin(input.actor)
      if (!(await findUser(input.userId)))
        throw new AdminContentErasureError('USER_NOT_FOUND', 'User not found.')
      const jobs = await db.all<{ id: string }>(
        `SELECT id FROM content_erasure_jobs WHERE owner_user_id=? ORDER BY created_at DESC,id DESC LIMIT 100`,
        [input.userId]
      )
      return Promise.all(jobs.map((job) => getErasureReport(db, job.id)))
    },
    async retry(input: { actor: ErasureActor; jobId: string }) {
      requireAdmin(input.actor)
      const job = await db.get<ErasureJob>('SELECT * FROM content_erasure_jobs WHERE id=?', [
        input.jobId
      ])
      if (!job || !job.owner_user_id)
        throw new AdminContentErasureError('USER_NOT_FOUND', 'Erasure operation not found.')
      const userId = job.owner_user_id
      return withErasureAccountLock(userId, async () => {
        await disabledUser(userId)
        return resumeErasure(db, dataRoot, input.jobId, {
          beforeResume: async () => {
            await disabledUser(userId)
          }
        })
      })
    },
    async receipt(input: { actor: ErasureActor; jobId: string }) {
      requireAdmin(input.actor)
      return exportErasureReceipt(db, input.jobId)
    }
  }
}

export type AdminContentErasure = ReturnType<typeof createAdminContentErasure>
